import { inflateSync } from "node:zlib";
import { db } from "./db.js";
import { norm } from "./team.js";

const FRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
const SIGNAL = "triangulo-v4";
const MARK_MIN = 80;
const CUT_MIN = 0.45;
const ZONE = "America/Sao_Paulo";
const DAY_MS = 24 * 60 * 60 * 1000;

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

function decodePng(png) {
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
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = pixels.subarray(y * stride, (y + 1) * stride);
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
    previous = row;
  }
  return { width, height, pixels };
}

function countIn(image, box, test) {
  const { width, height, pixels } = image;
  const x0 = Math.round(width * (box[0] / 960));
  const y0 = Math.round(height * (box[1] / 540));
  const x1 = Math.min(width - 1, Math.round(width * (box[2] / 960)));
  const y1 = Math.min(height - 1, Math.round(height * (box[3] / 540)));
  let hits = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const i = (y * width + x) * 3;
      if (test(pixels[i], pixels[i + 1], pixels[i + 2])) hits += 1;
    }
  }
  return { hits, area: (x1 - x0 + 1) * (y1 - y0 + 1) };
}

const pink = (r, g, b) => r > 200 && g < 80 && b < 120 && r > g + 100;
const rose = (r, g, b) => r > 150 && r > g + 50 && r > b + 50 && Math.abs(g - b) < 35;

function logoMark(image) {
  const strip = countIn(image, [0, 520, 270, 538], rose);
  if (strip.hits >= strip.area * CUT_MIN) return { mark: strip.hits, state: "cancelado" };
  const { width, height, pixels } = image;
  const x0 = Math.round(width * (200 / 960));
  const x1 = Math.round(width * (500 / 960));
  const y0 = Math.round(height * (10 / 540));
  const y1 = Math.round(height * (35 / 540));
  const win = Math.max(8, Math.round(width * (40 / 960)));
  const step = Math.max(1, Math.round(win / 20));
  let mark = 0;
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      let hits = 0;
      for (let yy = y; yy < y + win && yy < height; yy += 1) {
        for (let xx = x; xx < x + win && xx < width; xx += 1) {
          const i = (yy * width + xx) * 3;
          if (pink(pixels[i], pixels[i + 1], pixels[i + 2])) hits += 1;
        }
      }
      if (hits > mark) mark = hits;
    }
  }
  return { mark, state: mark >= MARK_MIN ? "selo" : "aberto" };
}

export function approvalMark(png) {
  const image = decodePng(png);
  return image ? logoMark(image) : null;
}

function slideText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<\/p>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
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

function furthestSeal(marked, today) {
  if (!marked.length) return null;
  return marked.reduce((best, slide) => {
    const iso = dayISO(slide.day, today);
    const bestIso = dayISO(best.day, today);
    if (iso > bestIso) return slide;
    if (iso === bestIso && slide.slide > best.slide) return slide;
    return best;
  });
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
    const pauta = (text.match(/Pauta:[^\S\n]*([^\n\uFFFD]{0,70})/) || [])[1] || "";
    const cancelled = /\bCANCELADO\b/i.test(text);
    const image = part.match(/https:\/\/docs\.google\.com\/presentation[^"]+format=png/);
    return {
      slide: index + 1,
      day: date ? `${date[1]}/${date[2]}` : null,
      pauta: pauta.replace(/\s*Formato:.*$/, "").trim(),
      cancelled,
      image: image ? image[0].replace(/&amp;/g, "&") : null,
    };
  });
  const scored = await mapLimit(slides, 4, async (slide) => {
    if (!slide.day || !slide.image) return { ...slide, state: null };
    try {
      const file = await fetch(slide.image, { signal: AbortSignal.timeout(20000) });
      if (!file.ok) return { ...slide, state: null };
      const read = approvalMark(Buffer.from(await file.arrayBuffer()));
      const state = slide.cancelled || read?.state === "cancelado" ? "cancelado" : read?.state ?? null;
      return { ...slide, state };
    } catch {
      return { ...slide, state: null };
    }
  });
  const read = scored.filter((slide) => slide.day && slide.state);
  const cancelled = read.filter((slide) => slide.state === "cancelado").length;
  const posts = read.filter((slide) => slide.state !== "cancelado");
  const marked = posts.filter((slide) => slide.state === "selo");
  const firstOpen = posts.find((slide) => slide.state !== "selo");
  const today = localToday(new Date());
  const through = furthestSeal(marked, today);
  return {
    signal: SIGNAL,
    placedUntil: through ? { slide: through.slide, day: through.day, pauta: through.pauta } : null,
    nextBlank: firstOpen ? { slide: firstOpen.slide, day: firstOpen.day, pauta: firstOpen.pauta } : null,
    placedPosts: marked.length,
    sealedAfterGap: firstOpen ? marked.filter((slide) => slide.slide > firstOpen.slide).length : 0,
    cancelled,
    seals: posts.map((slide) => ({ slide: slide.slide, day: slide.day, sealed: slide.state === "selo" })),
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
    posts: parsed.posts - (visual?.cancelled || 0),
    placedUntil: visual?.placedUntil ?? null,
  };
}

async function cachedDeck(url) {
  const row = db.prepare("SELECT payload, checked_at FROM deck_reads WHERE url = ?").get(url);
  const age = row ? Date.now() - new Date(row.checked_at).getTime() : Infinity;
  if (age < FRESH_MS) {
    const saved = JSON.parse(row.payload);
    const retry = saved.error && age > RETRY_MS;
    if (!retry && (saved.signal === SIGNAL || saved.open === false)) return saved;
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

function localToday(now) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function dayISO(day, today) {
  if (!day) return null;
  const [d, m] = day.split("/").map(Number);
  const ref = Date.parse(`${today}T00:00:00Z`);
  const year = Number(today.slice(0, 4));
  const best = [year - 1, year, year + 1]
    .map((y) => Date.UTC(y, m - 1, d))
    .reduce((a, b) => (Math.abs(b - ref) < Math.abs(a - ref) ? b : a));
  return new Date(best).toISOString().slice(0, 10);
}

function short(iso) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function pace(deck, now = new Date()) {
  const today = localToday(now);
  const sealedUntil = dayISO(deck.placedUntil?.day, today);
  const nextOpen = dayISO(deck.nextBlank?.day, today);
  const overdueDates = (deck.seals || [])
    .filter((post) => !post.sealed)
    .map((post) => dayISO(post.day, today))
    .filter((iso) => iso && iso <= today)
    .sort();
  const overdueOpenPosts = overdueDates.length;
  const firstOverdue = overdueDates[0] || null;
  const lastOverdue = overdueDates.at(-1) || null;
  const daysAhead = sealedUntil ? Math.round((Date.parse(sealedUntil) - Date.parse(today)) / DAY_MS) : null;
  const allSealed = Boolean(sealedUntil) && !nextOpen;
  // Lacunas com data até hoje — não confundir com "os posts de hoje estão sem selo".
  let gap = "";
  if (overdueOpenPosts === 1) {
    gap = `1 post em atraso ainda sem o selo de aprovação (${short(firstOverdue)})`;
  } else if (overdueOpenPosts > 1) {
    gap = firstOverdue === lastOverdue
      ? `${overdueOpenPosts} posts em atraso ainda sem o selo de aprovação (${short(firstOverdue)})`
      : `${overdueOpenPosts} posts em atraso ainda sem o selo de aprovação (de ${short(firstOverdue)} a ${short(lastOverdue)})`;
  }
  let status;
  let phrase;
  let text;
  if (allSealed) {
    status = "todos";
    phrase = null;
    text = `Selo de aprovação em todos os posts, até ${short(sealedUntil)}`;
  } else if (!sealedUntil) {
    status = overdueOpenPosts ? "atrasado" : "sem-selo";
    phrase = gap || null;
    text = gap
      ? `Nenhum selo de aprovação · ${gap}`
      : `Nenhum selo de aprovação ainda${nextOpen ? ` · primeiro post em ${short(nextOpen)}` : ""}`;
  } else if (overdueOpenPosts) {
    status = "atrasado";
    phrase = gap;
    text = `Selo de aprovação até ${short(sealedUntil)} · ${gap}`;
  } else if (daysAhead > 0) {
    status = "adiantado";
    phrase = `${plural(daysAhead, "dia", "dias")} adiantado`;
    text = `Selo de aprovação até ${short(sealedUntil)} · ${phrase} · próximo sem o selo: ${short(nextOpen)}`;
  } else {
    status = "em-dia";
    phrase = "em dia";
    text = daysAhead === 0
      ? `Selo de aprovação até hoje (${short(sealedUntil)}) · em dia · próximo sem o selo: ${short(nextOpen)}`
      : `Selo de aprovação até ${short(sealedUntil)} · em dia · próximo sem o selo: ${short(nextOpen)}`;
  }
  return { today, sealedUntil, nextOpen, allSealed, daysAhead, overdueOpenPosts, status, phrase, text };
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
  const today = localToday(new Date());
  const days = (deck.seals || []).map((post) => dayISO(post.day, today)).sort();
  const first = days.length ? short(days[0]) : deck.first;
  const last = days.length ? short(days.at(-1)) : deck.last;
  const span = first && last ? `, de ${first} a ${last}` : "";
  const clean = (value) => String(value || "").replace(/\s+Format\w*.*$/i, "").trim();
  const where = (slide) => `slide ${slide.slide} (${slide.day}${clean(slide.pauta) ? `, ${clean(slide.pauta)}` : ""})`;
  const until = deck.placedUntil ? ` O selo de aprovação está até o ${where(deck.placedUntil)}.` : "";
  const blank = deck.nextBlank
    ? deck.placedUntil
      ? ` A partir do ${where(deck.nextBlank)} o post ainda não tem o selo de aprovação.`
      : ` Nenhum post tem o selo de aprovação. O primeiro sem a marca é o ${where(deck.nextBlank)}.`
    : "";
  const after = deck.sealedAfterGap
    ? ` Depois dessa lacuna, mais ${plural(deck.sealedAfterGap, "post já tem", "posts já têm")} o selo de aprovação.`
    : "";
  const dropped = deck.cancelled ? ` ${plural(deck.cancelled, "post cancelado ficou", "posts cancelados ficaram")} fora da conta.` : "";
  const deliveredPosts = deck.placedPosts ?? null;
  const deliveryPercent = deck.posts && deliveredPosts != null
    ? Math.round((deliveredPosts / deck.posts) * 100)
    : null;
  const rhythm = deck.seals ? pace(deck) : null;
  const versusToday = rhythm?.phrase ? ` Em relação a hoje (${short(rhythm.today)}): ${rhythm.phrase}.` : "";
  return {
    routine,
    access: "aberta",
    url: link,
    posts: deck.posts,
    approved: deck.approved,
    deliveredPosts,
    deliveryPercent,
    first,
    last,
    placedUntil: deck.placedUntil || null,
    nextBlank: deck.nextBlank || null,
    pace: rhythm,
    cancelled: deck.cancelled || 0,
    summary: `Rotina. Apresentação aberta: ${deck.posts} posts${span}.${until}${blank}${after}${dropped}${versusToday}`,
  };
}
