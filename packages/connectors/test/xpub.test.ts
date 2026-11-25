import { HDKey } from "@scure/bip32";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { createMempoolClient, deriveAddress, deriveAddresses, parseExtendedPubKey, scanXpub, XPUB_VERSIONS, type MempoolClient } from "../src/xpub";
import { json, mockFetch } from "./helpers";

// Published BIP44/49/84 vectors for the "abandon … about" test mnemonic (account 0).
const XPUB = "xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj";
const YPUB = "ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP";
const ZPUB = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

describe("watch-only derivation", () => {
  it("xpub → P2PKH (BIP44 vector)", () => {
    expect(deriveAddress(parseExtendedPubKey(XPUB), 0, 0)).toBe("1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA");
  });
  it("ypub → P2SH-P2WPKH (BIP49 vector)", () => {
    expect(deriveAddress(parseExtendedPubKey(YPUB), 0, 0)).toBe("37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf");
  });
  it("zpub → P2WPKH (BIP84 vectors: receive 0, 1 and change 0)", () => {
    const w = parseExtendedPubKey(ZPUB);
    expect(deriveAddresses(w, 0, 0, 2)).toEqual(["bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"]);
    expect(deriveAddress(w, 1, 0)).toBe("bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el");
  });
  it("vectors agree with independent derivation from the mnemonic seed", () => {
    const seed = pbkdf2(sha512, "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", "mnemonic", { c: 2048, dkLen: 64 });
    const v = XPUB_VERSIONS.zpub!;
    expect(HDKey.fromMasterSeed(seed, { public: v.public, private: v.private }).derive("m/84'/0'/0'").publicExtendedKey).toBe(ZPUB);
  });
  it("rejects private keys and unknown prefixes", () => {
    const seed = new Uint8Array(32).fill(7);
    const xprv = HDKey.fromMasterSeed(seed).privateExtendedKey;
    expect(() => parseExtendedPubKey(xprv)).toThrow(/private/);
    expect(() => parseExtendedPubKey("tpubD6NzVbkrYhZ4X")).toThrow(/Unsupported/);
    expect(() => parseExtendedPubKey("xpub123")).toThrow(/Invalid/);
  });
});

describe("mempool.space client", () => {
  it("balance = chain funded − spent; throttled to 1 req/s; cached", async () => {
    let clock = 0;
    const starts: number[] = [];
    const { fetch, calls } = mockFetch((u) => {
      starts.push(clock);
      const addr = u.pathname.split("/").pop()!;
      return json({ address: addr, chain_stats: { funded_txo_sum: 150_000, spent_txo_sum: 50_000, tx_count: 3 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 1_000, tx_count: 1 } });
    });
    const client = createMempoolClient({ http: { fetch }, now: () => clock, sleep: async (ms) => void (clock += ms) });
    const [a, b, c] = await Promise.all([client.getAddress("bc1qa"), client.getAddress("bc1qb"), client.getAddress("bc1qc")]);
    expect(a).toEqual({ address: "bc1qa", balanceSats: 100_000n, mempoolDeltaSats: -1_000n, txCount: 4 });
    expect(b!.address).toBe("bc1qb");
    expect(c!.address).toBe("bc1qc");
    expect(starts).toEqual([0, 1000, 2000]);
    await client.getAddress("bc1qa");
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe("https://mempool.space/api/address/bc1qa");
  });
});

describe("gap-limit scan", () => {
  it("stops after 20 consecutive unused addresses per chain and sums balances", async () => {
    const w = parseExtendedPubKey(ZPUB);
    const used = new Map<string, bigint>([
      [deriveAddress(w, 0, 0), 50_000n],
      [deriveAddress(w, 0, 3), 0n], // used then emptied
      [deriveAddress(w, 0, 22), 25_000n], // within the gap after index 3
      [deriveAddress(w, 1, 1), 1_234n],
    ]);
    const queried: string[] = [];
    const client: MempoolClient = {
      async getAddress(address) {
        queried.push(address);
        const bal = used.get(address);
        return { address, balanceSats: bal ?? 0n, mempoolDeltaSats: 0n, txCount: bal === undefined ? 0 : 2 };
      },
    };
    const r = await scanXpub(ZPUB, client);
    expect(r.totalSats).toBe(76_234n);
    expect(r.totalBtc).toBe("0.00076234");
    expect(r.addresses.map((a) => [a.chain, a.index])).toEqual([[0, 0], [0, 3], [0, 22], [1, 1]]);
    expect(r.nextReceiveIndex).toBe(23);
    expect(queried).toHaveLength(43 + 22); // receive: 0..42, change: 0..21
    expect(r.script).toBe("p2wpkh");
  });
});
