import { describe, expect, it } from "vitest";
import { createKeyring, decryptSecret, encryptSecret, generateMasterKey, keyringFromEnv, last4, secretKeyId } from "../src/crypto";
import { parseEnv } from "../src/env";

const keyring = createKeyring(generateMasterKey());

describe("encryptSecret / decryptSecret", () => {
  it("round-trips unicode secrets", () => {
    const secret = "https://user:p@ss🔑@bridge.simplefin.org/simplefin";
    expect(decryptSecret(encryptSecret(secret, keyring), keyring)).toBe(secret);
  });

  it("uses a fresh IV every time", () => {
    const a = encryptSecret("same", keyring);
    const b = encryptSecret("same", keyring);
    expect(a.equals(b)).toBe(false);
    expect(a.length).toBe(1 + 12 + 16 + 4);
  });

  it("prefixes the key id", () => {
    const ring = createKeyring(generateMasterKey(), 7);
    const buf = encryptSecret("x", ring);
    expect(buf[0]).toBe(7);
    expect(secretKeyId(buf)).toBe(7);
  });

  it("rejects tampered ciphertext, tag and key-id byte", () => {
    const buf = encryptSecret("secret-token:abc123", keyring);
    for (const i of [0, 5, 20, buf.length - 1]) {
      const bad = Buffer.from(buf);
      bad[i]! ^= 0x01;
      expect(() => decryptSecret(bad, keyring)).toThrow();
    }
  });

  it("rejects the wrong key", () => {
    const buf = encryptSecret("secret", keyring);
    expect(() => decryptSecret(buf, createKeyring(generateMasterKey()))).toThrow(/failed authentication/);
  });

  it("decrypts old ciphertexts after rotation via previous keys", () => {
    const oldKey = generateMasterKey();
    const old = createKeyring(oldKey, 1);
    const buf = encryptSecret("legacy", old);
    const rotated = createKeyring(generateMasterKey(), 2, { 1: oldKey });
    expect(decryptSecret(buf, rotated)).toBe("legacy");
    expect(secretKeyId(encryptSecret("new", rotated))).toBe(2);
  });

  it("rejects truncated input", () => {
    expect(() => decryptSecret(Buffer.alloc(10), keyring)).toThrow(/too short/);
  });
});

describe("keys and env", () => {
  it("generates 32-byte base64 keys", () => {
    expect(Buffer.from(generateMasterKey(), "base64")).toHaveLength(32);
    expect(generateMasterKey()).not.toBe(generateMasterKey());
  });

  it("rejects keys of the wrong length", () => {
    expect(() => createKeyring(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => parseEnv({ HOMEBASE_MASTER_KEY: "c2hvcnQ=" })).toThrow(/HOMEBASE_MASTER_KEY/);
  });

  it("builds a keyring from env, including previous keys", () => {
    const current = generateMasterKey();
    const previous = generateMasterKey();
    const e = parseEnv({ HOMEBASE_MASTER_KEY: current, HOMEBASE_MASTER_KEY_ID: "3", HOMEBASE_PREVIOUS_MASTER_KEYS: `2:${previous}` });
    const ring = keyringFromEnv(e);
    expect(ring.currentId).toBe(3);
    expect([...ring.keys.keys()].sort()).toEqual([2, 3]);
    expect(decryptSecret(encryptSecret("hi", createKeyring(previous, 2)), ring)).toBe("hi");
  });

  it("requires the master key and DATABASE_URL in production only", () => {
    expect(parseEnv({}).DATABASE_URL).toMatch(/^postgres:\/\//);
    expect(() => parseEnv({ NODE_ENV: "production" })).toThrow(/DATABASE_URL[\s\S]*HOMEBASE_MASTER_KEY/);
    expect(() => parseEnv({ DATABASE_URL: "mysql://x" })).toThrow(/postgres/);
    expect(() => keyringFromEnv(parseEnv({}))).toThrow(/HOMEBASE_MASTER_KEY is not set/);
  });
});

describe("last4", () => {
  it("shows only the last four characters of long secrets", () => {
    expect(last4("secret-token:mercury_abcd1234")).toBe("1234");
    expect(last4("  sk-ant-api03-xyzWXYZ  ")).toBe("WXYZ");
  });

  it("reveals nothing of short secrets", () => {
    expect(last4("12345678")).toBe("");
    expect(last4("")).toBe("");
  });
});
