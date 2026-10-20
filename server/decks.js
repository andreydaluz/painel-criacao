import { inflateSync } from "node:zlib";
import { db } from "./db.js";
import { norm } from "./team.js";

const FRESH_MS = 6 * 60 * 60 * 1000;
const SIGNAL = "triangulo";
const MARK_MIN = 80;

export function isRoutine(name) {
  const key = norm(name);
  return /\bsocial\b|\bq\s*[12]\b|\bcalendario\b|\bmensal\b/.test(key);
}

export function slidesLink(text) {
  const match = String(text || "").match(/docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return null;
  return `https://docs.google.com/presentation/d/${match[1]}`;
}

export function parseDeck(text) {
  const lines = String(text || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const posts = [];
  let current = null;
  for (const line of lines) {
    const date = line.match(/^(\d{2})\.(\d{2})\b/);
    if (date) {
      current = { day: `${date[1]}/${date[2]}`, approved: false };
      posts.push(current);
      continue;
    }
    if (current && /^aprovado$/i.test(line)) current.approved = true;
  }
  return {
    posts: posts.length,
    approved: posts.filter((post) => post.approved).length,
    first: posts[0]?.day || null,
    last: posts.at(-1)?.day || null,
  };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function approvalMark(png) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (colorType !== 2 || !width || !height) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  let previous = Buffer.alloc(stride);
  let rowStart = 0;
  let mark = 0;
  const y0 = Math.round(height * (36 / 540));
  const y1 = Math.round(height * (85 / 540));
  const x0 = Math.round(width * (205 / 960));
  const x1 = Math.round(width * (280 / 960));
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rowStart];
    const row = Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const value = raw[rowStart + 1 + i];
      const left = i >= 3 ? row[i - 3] : 0;
      const up = previous[i];
      const upLeft = i >= 3 ? previous[i - 3] : 0;
      if (filter === 1) row[i] = (value + left) & 255;
      else if (filter === 2) row[i] = (value + up) & 255;
      else if (filter === 3) row[i] = (value + ((left + up) >> 1)) & 255;
      else if (filter === 4) row[i] = (value + paeth(left, up, upLeft)) & 255;
      else row[i] = value;
    }
    if (y >= y0 && y <= y1) {
      for (let x = x0; x <= x1; x += 1) {
        const i = x * 3;
        const red = row[i];
        const green = row[i + 1];
        const blue = row[i + 2];
        if (red > 200 && green < 80 && blue < 120 && red > green + 100) mark += 1;
      }
    }
    previous = row;
    rowStart += stride + 1;
  }
  return mark;
}

function slideText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function placedArt(id) {
  const response = await fetch(`https://docs.google.com/presentation/d/${id}/htmlpresent`, {
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
    headers: { "user-agent": "Mozilla/5.0" },
  });
  if (!response.ok) return null;
  const html = await response.text();
  const slides = html.split('<div role="group" class="slide"').slice(1).map((part, index) => {
    const text = slideText(part);
    const date = text.match(/\b(\d{2})\.(\d{2})\b/);
    const pauta = (text.match(/Pauta:\s*(.{0,70})/) || [])[1] || "";
    const image = part.match(/https:\/\/docs\.google\.com\/presentation[^"]+format=png/);
    return {
      slide: index + 1,
      day: date ? `${date[1]}/${date[2]}` : null,
      pauta: pauta.replace(/\s*Formato:.*$/, "").trim(),
      image: image ? image[0].replace(/&amp;/g, "&") : null,
    };
  });
  const scored = await mapLimit(slides, 4, async (slide) => {
    if (!slide.day || !slide.image) return { ...slide, mark: null };
    try {
      const file = await fetch(slide.image, { signal: AbortSignal.timeout(20000) });
      if (!file.ok) return { ...slide, mark: null };
      const mark = approvalMark(Buffer.from(await file.arrayBuffer()));
      return { ...slide, mark };
    } catch {
      return { ...slide, mark: null };
    }
  });
  const posts = scored.filter((slide) => slide.day && slide.mark != null);
  const marked = posts.filter((slide) => slide.mark >= MARK_MIN);
  const firstOpen = posts.find((slide) => slide.mark < MARK_MIN);
  const through = firstOpen
    ? marked.filter((slide) => slide.slide < firstOpen.slide).at(-1) || null
    : marked.at(-1) || null;
  return {
    signal: SIGNAL,
    placedUntil: through ? { slide: through.slide, day: through.day, pauta: through.pauta } : null,
    nextBlank: firstOpen ? { slide: firstOpen.slide, day: firstOpen.day, pauta: firstOpen.pauta } : null,
    placedPosts: through ? marked.filter((slide) => slide.slide <= through.slide).length : marked.length,
  };
}

async function fetchDeck(url) {
  const id = url.split("/d/")[1];
  const response = await fetch(`https://docs.google.com/presentation/d/${id}/export?format=txt`, {
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
    headers: { "user-agent": "painel-criacao" },
  });
  if (!response.ok) return { open: false };
  const text = await response.text();
  if (!text || text.length < 40 || text.trim().startsWith("<")) return { open: false };
  const parsed = parseDeck(text);
  let visual = null;
  try {
    visual = await placedArt(id);
  } catch {
    visual = null;
  }
  return {
    open: true,
    signal: SIGNAL,
    ...parsed,
    ...(visual || {}),
    placedUntil: visual?.placedUntil ?? null,
  };
}

async function cachedDeck(url) {
  const row = db.prepare("SELECT payload, checked_at FROM deck_reads WHERE url = ?").get(url);
  if (row && Date.now() - new Date(row.checked_at).getTime() < FRESH_MS) {
    const saved = JSON.parse(row.payload);
    if (saved.signal === SIGNAL || saved.open === false) return saved;
  }
  let payload;
  try {
    payload = await fetchDeck(url);
  } catch {
    payload = { open: false, error: true };
  }
  db.prepare(
    "INSERT INTO deck_reads (url, payload, checked_at) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET payload = excluded.payload, checked_at = excluded.checked_at",
  ).run(url, JSON.stringify(payload), new Date().toISOString());
  return payload;
}

export async function describeDeck(card) {
  const routine = isRoutine(card.name);
  const link = slidesLink(card.description);
  if (!routine && !link) return null;
  if (!link) {
    return {
      routine,
      access: "sem-link",
      summary: "Rotina. A descrição do cartão não tem link de apresentação.",
    };
  }
  const deck = await cachedDeck(link);
  if (!deck.open) {
    return {
      routine,
      access: "fechada",
      url: link,
      summary: "Rotina. A apresentação está com o link fechado.",
    };
  }
  const span = deck.first && deck.last ? `, de ${deck.first} a ${deck.last}` : "";
  const clean = (value) => String(value || "").replace(/\s+Format\w*.*$/i, "").trim();
  const where = (slide) => `slide ${slide.slide} (${slide.day}${clean(slide.pauta) ? `, ${clean(slide.pauta)}` : ""})`;
  const until = deck.placedUntil ? ` O selo de aprovação está até o ${where(deck.placedUntil)}.` : "";
  const blank = deck.nextBlank
    ? deck.placedUntil
      ? ` A partir do ${where(deck.nextBlank)} o post ainda não tem o selo.`
      : ` Nenhum post tem o selo de aprovação. O primeiro sem a marca é o ${where(deck.nextBlank)}.`
    : "";
  const deliveredPosts = deck.placedPosts ?? null;
  const deliveryPercent = deck.posts && deliveredPosts != null
    ? Math.round((deliveredPosts / deck.posts) * 100)
    : null;
  return {
    routine,
    access: "aberta",
    url: link,
    posts: deck.posts,
    approved: deck.approved,
    deliveredPosts,
    deliveryPercent,
    first: deck.first,
    last: deck.last,
    placedUntil: deck.placedUntil || null,
    nextBlank: deck.nextBlank || null,
    summary: `Rotina. Apresentação aberta: ${deck.posts} posts${span}.${until}${blank}`,
  };
}
