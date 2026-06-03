// AES-GCM wrapper around crypto.subtle for encrypting OAuth tokens at rest.
// Key comes from Env.TOKEN_ENCRYPTION_KEY (32 bytes, base64).

const ALG = "AES-GCM";
const IV_BYTES = 12;

async function importKey(rawBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(rawBase64);
  if (raw.byteLength !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  }
  return crypto.subtle.importKey("raw", raw, ALG, false, ["encrypt", "decrypt"]);
}

export async function encryptString(
  plaintext: string,
  keyBase64: string,
  iv?: Uint8Array,
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> {
  const key = await importKey(keyBase64);
  const nonce = iv ?? crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALG, iv: nonce },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext, iv: nonce };
}

export async function decryptString(
  ciphertext: ArrayBuffer | Uint8Array,
  iv: ArrayBuffer | Uint8Array,
  keyBase64: string,
): Promise<string> {
  const key = await importKey(keyBase64);
  const plaintext = await crypto.subtle.decrypt(
    { name: ALG, iv: toUint8(iv) },
    key,
    toUint8(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

function toUint8(buf: ArrayBuffer | Uint8Array): Uint8Array {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
