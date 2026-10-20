import "./env.js";
import { createServer } from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDashboard } from "./metrics.js";
import { loadTeam } from "./team.js";
import { syncTrello } from "./trello.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const port = Number(process.env.PORT || 8787);
const syncMinutes = Number(process.env.SYNC_MINUTES || 15);
const dist = join(root, "dist");
const password = process.env.PAINEL_SENHA || "";
const session = password ? createHmac("sha256", password).update("painel-criacao").digest("hex") : "";

let syncing = null;
async function runSync() {
  if (syncing) return syncing;
  syncing = syncTrello()
    .catch((error) => ({ ok: false, reason: error.message }))
    .finally(() => {
      syncing = null;
    });
  return syncing;
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (url.pathname === "/api/health") return send(res, 200, { ok: true });
  if (url.pathname === "/entrar") return login(req, res);
  if (!authorized(req)) {
    if (url.pathname.startsWith("/api/")) return send(res, 401, { error: "Senha necessária" });
    res.writeHead(302, { location: "/entrar" });
    return res.end();
  }
  if (url.pathname === "/api/dashboard") {
    return send(res, 200, await buildDashboard());
  }
  if (url.pathname === "/api/sync" && req.method === "POST") {
    const result = await runSync();
    return send(res, result.ok ? 200 : 200, { ...result, dashboard: await buildDashboard() });
  }
  if (req.method !== "GET") return send(res, 404, { error: "Não encontrado" });
  serveStatic(res, url.pathname);
}).listen(port, () => {
  console.log(`Painel em http://127.0.0.1:${port}`);
});

setInterval(() => {
  runSync().then((result) => {
    if (result?.ok) console.log(`Sincronizado: ${result.cards} cartões`);
  });
}, syncMinutes * 60 * 1000);

setTimeout(() => {
  runSync().then((result) => {
    if (!result.ok) console.log(result.reason);
  });
}, 1500);

function authorized(req) {
  if (!password) return true;
  const cookie = (req.headers.cookie || "").split(/;\s*/).find((part) => part.startsWith("painel="));
  const value = Buffer.from(cookie ? cookie.slice("painel=".length) : "");
  const expected = Buffer.from(session);
  return value.length === expected.length && timingSafeEqual(value, expected);
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

async function login(req, res) {
  if (!password) {
    res.writeHead(302, { location: "/" });
    return res.end();
  }
  if (req.method !== "POST") return loginPage(res, "");
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) break;
  }
  const typed = new URLSearchParams(body).get("senha") || "";
  if (!timingSafeEqual(digest(typed), digest(password))) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return loginPage(res, "Senha incorreta.");
  }
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.writeHead(302, {
    location: "/",
    "set-cookie": `painel=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`,
  });
  res.end();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function loginPage(res, message) {
  const brand = escapeHtml(loadTeam().brand || "");
  res.writeHead(message ? 401 : 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Painel de criação${brand ? ` · ${brand}` : ""}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;700;800&display=swap" rel="stylesheet">
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #dcdcd4; color: #3c3c3c; font-family: Manrope, sans-serif; }
body::before { content: ""; position: fixed; inset: 0 0 auto; height: 7px; background: linear-gradient(90deg, #ef147f 0%, #6a3d9a 48%, #14c4e4 100%); }
form { background: #fcfcfc; padding: 32px; width: min(360px, calc(100vw - 48px)); box-sizing: border-box; }
p { margin: 0 0 10px; color: #e4147c; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; }
h1 { margin: 0 0 22px; font-size: 1.8rem; font-weight: 800; letter-spacing: -0.04em; }
label { display: block; font-size: 0.85rem; margin-bottom: 6px; }
input { width: 100%; box-sizing: border-box; padding: 11px 12px; border: 1px solid #c9c9c2; font: inherit; }
button { margin-top: 14px; width: 100%; background: #3c3c3c; color: white; border: 0; padding: 11px 16px; font: inherit; font-weight: 700; cursor: pointer; }
.erro { margin-top: 12px; color: #e4147c; font-size: 0.85rem; }
</style>
</head>
<body>
<form method="post" action="/entrar">
${brand ? `<p>${brand}</p>` : ""}
<h1>Painel de criação</h1>
<label for="senha">Senha</label>
<input id="senha" name="senha" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Entrar</button>
${message ? `<div class="erro">${message}</div>` : ""}
</form>
</body>
</html>`);
}

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function serveStatic(res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = normalize(join(dist, relative));
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) {
    const index = join(dist, "index.html");
    if (!existsSync(index)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<p>Rode <code>npm run build</code> para gerar o painel.</p>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(index));
    return;
  }
  res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
}