import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env, type Env } from "./env";

/**
 * AES-256-GCM for connector credentials and other stored secrets (§4.6).
 *
 * Ciphertext layout: [key id: 1 byte][iv: 12 bytes][auth tag: 16 bytes][ciphertext].
 * The key-id byte is bound as additional authenticated data, so it can't be swapped,
 * and lets old rows keep decrypting after HOMEBASE_MASTER_KEY is rotated.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

export interface Keyring {
  /** Key id used for new ciphertexts. */
  currentId: number;
  keys: ReadonlyMap<number, Buffer>;
}

export function generateMasterKey(): string {
  return randomBytes(32).toString("base64");
}

function decodeKey(b64: string, label: string): Buffer {
  const key = Buffer.from(b64.trim(), "base64");
  if (key.length !== 32) throw new Error(`${label} must be 32 bytes, base64-encoded`);
  return key;
}

function checkKeyId(id: number): number {
  if (!Number.isInteger(id) || id < 1 || id > 255) throw new Error(`key id must be an integer 1–255, got ${id}`);
  return id;
}

/** Build a keyring from a base64 key (and optional retired keys, for rotation). */
export function createKeyring(currentKeyB64: string, currentId = 1, previous: Record<number, string> = {}): Keyring {
  const keys = new Map<number, Buffer>();
  for (const [id, b64] of Object.entries(previous)) keys.set(checkKeyId(Number(id)), decodeKey(b64, `previous key ${id}`));
  keys.set(checkKeyId(currentId), decodeKey(currentKeyB64, "HOMEBASE_MASTER_KEY"));
  return { currentId, keys };
}

export function keyringFromEnv(e: Env = env()): Keyring {
  if (!e.HOMEBASE_MASTER_KEY) throw new Error("HOMEBASE_MASTER_KEY is not set; generate one with `openssl rand -base64 32`");
  const previous: Record<number, string> = {};
  for (const entry of (e.HOMEBASE_PREVIOUS_MASTER_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const sep = entry.indexOf(":");
    if (sep < 1) throw new Error("HOMEBASE_PREVIOUS_MASTER_KEYS entries must look like id:base64");
    previous[Number(entry.slice(0, sep))] = entry.slice(sep + 1);
  }
  return createKeyring(e.HOMEBASE_MASTER_KEY, e.HOMEBASE_MASTER_KEY_ID, previous);
}

let defaultKeyring: Keyring | undefined;
function getDefaultKeyring(): Keyring {
  defaultKeyring ??= keyringFromEnv();
  return defaultKeyring;
}

export function encryptSecret(plaintext: string, keyring: Keyring = getDefaultKeyring()): Buffer {
  const key = keyring.keys.get(keyring.currentId);
  if (!key) throw new Error(`no key for current key id ${keyring.currentId}`);
  const header = Buffer.from([keyring.currentId]);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(buf: Buffer | Uint8Array, keyring: Keyring = getDefaultKeyring()): string {
  const data = Buffer.from(buf);
  if (data.length < HEADER_BYTES) throw new Error("ciphertext too short");
  const keyId = data[0]!;
  const key = keyring.keys.get(keyId);
  if (!key) throw new Error(`no key with id ${keyId}; was HOMEBASE_MASTER_KEY rotated without HOMEBASE_PREVIOUS_MASTER_KEYS?`);
  const iv = data.subarray(1, 1 + IV_BYTES);
  const tag = data.subarray(1 + IV_BYTES, HEADER_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(data.subarray(0, 1));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data.subarray(HEADER_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("secret failed authentication (wrong key or tampered ciphertext)");
  }
}

/** Key id a ciphertext was written with, e.g. to find rows that still need re-encrypting after rotation. */
export function secretKeyId(buf: Buffer | Uint8Array): number {
  if (buf.length < HEADER_BYTES) throw new Error("ciphertext too short");
  return buf[0]!;
}

/** Last 4 characters for display in Settings; empty for secrets too short to reveal any part of. */
export function last4(secret: string): string {
  const s = secret.trim();
  return s.length <= 8 ? "" : s.slice(-4);
}
