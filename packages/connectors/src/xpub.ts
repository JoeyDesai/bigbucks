/**
 * Watch-only Bitcoin wallet (§7.4 option 3).
 * Derives receive (0/i) and change (1/i) addresses locally from an xpub/ypub/zpub; only addresses leave
 * the server (mempool.space), never the extended key. Gap limit 20; mempool client throttled to 1 req/s.
 */
import { HDKey } from "@scure/bip32";
import { base58check, bech32 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { z } from "zod";
import { createHttpClient, defaultSleep, type HttpClientOptions } from "./http";
import { scaledToDecimal } from "./normalize";
import { ConnectorError } from "./types";

export type ScriptType = "p2pkh" | "p2sh-p2wpkh" | "p2wpkh";

/** SLIP-132 version bytes (mainnet). */
export const XPUB_VERSIONS: Record<string, { public: number; private: number; script: ScriptType }> = {
  xpub: { public: 0x0488b21e, private: 0x0488ade4, script: "p2pkh" },
  ypub: { public: 0x049d7cb2, private: 0x049d7878, script: "p2sh-p2wpkh" },
  zpub: { public: 0x04b24746, private: 0x04b2430c, script: "p2wpkh" },
};

const b58c = base58check(sha256);
const hash160 = (b: Uint8Array) => ripemd160(sha256(b));

export interface WatchOnlyKey {
  hd: HDKey;
  script: ScriptType;
}

/** Parse a public extended key. Private keys (xprv/yprv/zprv) are rejected. `scriptOverride` lets an xpub be used for p2wpkh wallets. */
export function parseExtendedPubKey(key: string, scriptOverride?: ScriptType): WatchOnlyKey {
  const k = key.trim();
  const prefix = k.slice(0, 4);
  if (/^[xyztuv]prv$/.test(prefix)) throw new ConnectorError("invalid_input", "Refusing a private extended key; provide the xpub/ypub/zpub only", { provider: "xpub" });
  const v = XPUB_VERSIONS[prefix];
  if (!v) throw new ConnectorError("invalid_input", `Unsupported extended key prefix "${prefix}" (expected xpub, ypub or zpub)`, { provider: "xpub" });
  let hd: HDKey;
  try {
    hd = HDKey.fromExtendedKey(k, { public: v.public, private: v.private });
  } catch (e) {
    throw new ConnectorError("invalid_input", "Invalid extended public key", { provider: "xpub", cause: e });
  }
  if (hd.privateKey) throw new ConnectorError("invalid_input", "Refusing a private extended key", { provider: "xpub" });
  return { hd, script: scriptOverride ?? v.script };
}

export function pubkeyToAddress(pub: Uint8Array, script: ScriptType): string {
  const h = hash160(pub);
  switch (script) {
    case "p2pkh":
      return b58c.encode(Uint8Array.from([0x00, ...h]));
    case "p2sh-p2wpkh": {
      const redeem = Uint8Array.from([0x00, 0x14, ...h]);
      return b58c.encode(Uint8Array.from([0x05, ...hash160(redeem)]));
    }
    case "p2wpkh":
      return bech32.encode("bc", [0, ...bech32.toWords(h)]);
  }
}

/** Derive address at chain (0 = receive, 1 = change) / index from the account-level extended key. */
export function deriveAddress(w: WatchOnlyKey, chain: 0 | 1, index: number): string {
  const child = w.hd.deriveChild(chain).deriveChild(index);
  if (!child.publicKey) throw new ConnectorError("parse", "Derivation produced no public key", { provider: "xpub" });
  return pubkeyToAddress(child.publicKey, w.script);
}

export function deriveAddresses(w: WatchOnlyKey, chain: 0 | 1, start: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => deriveAddress(w, chain, start + i));
}

// ---------------------------------------------------------------------------------------------------------------------
// mempool.space client

const StatsSchema = z.looseObject({ funded_txo_sum: z.number(), spent_txo_sum: z.number(), tx_count: z.number() });
const AddressSchema = z.looseObject({ address: z.string(), chain_stats: StatsSchema, mempool_stats: StatsSchema.nullish() });

export interface AddressStats {
  address: string;
  /** Confirmed balance: chain_stats.funded_txo_sum − chain_stats.spent_txo_sum (sats). */
  balanceSats: bigint;
  /** Unconfirmed delta from mempool (sats). */
  mempoolDeltaSats: bigint;
  txCount: number;
}

export interface MempoolClientOptions {
  http?: HttpClientOptions;
  baseUrl?: string;
  /** Minimum ms between request starts (default 1000 = 1 req/s). */
  minIntervalMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface MempoolClient {
  getAddress(address: string): Promise<AddressStats>;
}

export function createMempoolClient(o: MempoolClientOptions = {}): MempoolClient {
  const http = createHttpClient({ ...(o.http ?? {}), provider: "xpub" });
  const base = (o.baseUrl ?? "https://mempool.space/api").replace(/\/+$/, "");
  const minInterval = o.minIntervalMs ?? 1000;
  const ttl = o.cacheTtlMs ?? 10 * 60_000;
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? defaultSleep;
  const cache = new Map<string, { at: number; v: AddressStats }>();
  let queue: Promise<unknown> = Promise.resolve();
  let lastStart = -Infinity;

  async function throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(async () => {
      const wait = lastStart + minInterval - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
      return fn();
    });
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    async getAddress(address) {
      const hit = cache.get(address);
      if (hit && now() - hit.at < ttl) return hit.v;
      const j = await throttled(() => http.getJson(`${base}/address/${encodeURIComponent(address)}`));
      const a = AddressSchema.parse(j);
      const v: AddressStats = {
        address: a.address,
        balanceSats: BigInt(a.chain_stats.funded_txo_sum) - BigInt(a.chain_stats.spent_txo_sum),
        mempoolDeltaSats: a.mempool_stats ? BigInt(a.mempool_stats.funded_txo_sum) - BigInt(a.mempool_stats.spent_txo_sum) : 0n,
        txCount: a.chain_stats.tx_count + (a.mempool_stats?.tx_count ?? 0),
      };
      cache.set(address, { at: now(), v });
      return v;
    },
  };
}

export interface ScannedAddress extends AddressStats {
  chain: 0 | 1;
  index: number;
}

export interface XpubScanResult {
  script: ScriptType;
  addresses: ScannedAddress[];
  totalSats: bigint;
  totalBtc: string;
  /** Next unused receive index. */
  nextReceiveIndex: number;
}

/** Scan receive and change chains until `gapLimit` consecutive unused addresses (default 20). */
export async function scanXpub(key: string, client: MempoolClient, o: { gapLimit?: number; maxPerChain?: number; script?: ScriptType } = {}): Promise<XpubScanResult> {
  const w = parseExtendedPubKey(key, o.script);
  const gap = o.gapLimit ?? 20;
  const max = o.maxPerChain ?? 10_000;
  const addresses: ScannedAddress[] = [];
  let nextReceiveIndex = 0;
  for (const chain of [0, 1] as const) {
    let unused = 0;
    let lastUsed = -1;
    for (let i = 0; i < max && unused < gap; i++) {
      const s = await client.getAddress(deriveAddress(w, chain, i));
      if (s.txCount > 0) {
        unused = 0;
        lastUsed = i;
        addresses.push({ ...s, chain, index: i });
      } else unused++;
    }
    if (chain === 0) nextReceiveIndex = lastUsed + 1;
  }
  const totalSats = addresses.reduce((t, a) => t + a.balanceSats, 0n);
  return { script: w.script, addresses, totalSats, totalBtc: scaledToDecimal(totalSats, 8), nextReceiveIndex };
}
