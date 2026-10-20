import "../server/env.js";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ITERATIONS = 600000;
const SALT = Buffer.from("painel-criacao/v1");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

const password = process.env.PAINEL_SENHA || "";
if (password.length < 16) {
  console.error("PAINEL_SENHA precisa ter pelo menos 16 caracteres.");
  process.exit(1);
}
if (!existsSync(join(dist, "index.html"))) {
  console.error("Rode a build estática antes: npm run build:static");
  process.exit(1);
}

const { syncTrello } = await import("../server/trello.js");
const { buildDashboard } = await import("../server/metrics.js");

const result = await syncTrello().catch((error) => ({ ok: false, reason: error.message }));
if (!result.ok) {
  console.error("A leitura do Trello falhou.");
  process.exit(1);
}

const dashboard = await buildDashboard();
const key = pbkdf2Sync(password, SALT, ITERATIONS, 32, "sha256");
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", key, iv);
const sealed = Buffer.concat([cipher.update(JSON.stringify(dashboard)), cipher.final(), cipher.getAuthTag()]);

writeFileSync(
  join(dist, "dados.json"),
  JSON.stringify({
    v: 1,
    iterations: ITERATIONS,
    salt: SALT.toString("base64"),
    iv: iv.toString("base64"),
    data: sealed.toString("base64"),
  }),
);
console.log("Painel publicado com os dados criptografados.");
