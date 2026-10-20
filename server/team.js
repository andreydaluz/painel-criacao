import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const file = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "team.json");
let cached = null;
let cachedAt = 0;

export function loadTeam() {
  if (!existsSync(file)) {
    throw new Error("Falta config/team.json. Copie config/team.example.json e preencha a equipe.");
  }
  const changed = statSync(file).mtimeMs;
  if (!cached || changed !== cachedAt) {
    cached = JSON.parse(readFileSync(file, "utf8"));
    cachedAt = changed;
  }
  return cached;
}

export function norm(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

export function clientFromName(name) {
  const cleaned = String(name).replace(/^\[[^\]]+\]\s*/, "");
  const raw = (cleaned.split(/\s*\|\s*|\s+l\s+|\s+-\s+/i)[0] || cleaned).trim();
  const { aliases = {}, contains = {} } = loadTeam().clients || {};
  const key = norm(raw);
  for (const [alias, client] of Object.entries(aliases)) {
    if (norm(alias) === key) return client;
  }
  const whole = norm(cleaned);
  for (const [fragment, client] of Object.entries(contains)) {
    if (new RegExp(`\\b${norm(fragment).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(whole)) return client;
  }
  return raw;
}

export function roleFor(team, fullName) {
  const key = norm(fullName);
  const da = team.das.find((person) => norm(person.name) === key);
  if (da) return { role: "da", active: da.active !== false, note: da.note || "" };
  const socio = (team.socios || []).find((person) => norm(person.name) === key);
  if (socio) return { role: "socio", active: true, note: socio.note || "Sócio" };
  const trafego = (team.trafego || []).find((person) => norm(person.name) === key);
  if (trafego) return { role: "trafego", active: true, note: trafego.note || "" };
  if (team.atendimento.some((name) => norm(name) === key)) {
    return { role: "atendimento", active: true, note: "" };
  }
  return { role: "outro", active: true, note: "" };
}
