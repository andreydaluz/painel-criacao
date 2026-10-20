const STORE = "painel-chave";

function bytes(base64) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

async function envelope() {
  const response = await fetch(`dados.json?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Não foi possível baixar os dados do painel.");
  return response.json();
}

async function open(key, sealed) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(sealed.iv) }, key, bytes(sealed.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

export async function unlockWithPassword(password) {
  const sealed = await envelope();
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: bytes(sealed.salt), iterations: sealed.iterations },
    base,
    { name: "AES-GCM", length: 256 },
    true,
    ["decrypt"],
  );
  const data = await open(key, sealed);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  localStorage.setItem(STORE, btoa(String.fromCharCode(...raw)));
  return data;
}

export async function unlockWithSaved() {
  const saved = localStorage.getItem(STORE);
  if (!saved) return null;
  const sealed = await envelope();
  try {
    const key = await crypto.subtle.importKey("raw", bytes(saved), "AES-GCM", false, ["decrypt"]);
    return await open(key, sealed);
  } catch {
    localStorage.removeItem(STORE);
    return null;
  }
}

export function forget() {
  localStorage.removeItem(STORE);
}
