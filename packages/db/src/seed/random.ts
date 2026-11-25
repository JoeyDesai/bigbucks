/** Deterministic randomness for seeds: same seed → byte-identical data, including ids. */
export class Rng {
  private state: number;
  private idCounter = 0;

  constructor(
    seed: number,
    /** Epoch ms embedded in generated uuid v7 ids (incremented per id so they stay sortable). */
    private readonly idEpochMs: number,
  ) {
    this.state = seed >>> 0;
  }

  /** mulberry32: uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }

  /** Standard normal draw (Box–Muller). */
  gauss(): number {
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Whole-cent amount in milliunits, uniform between two dollar amounts. */
  milli(loDollars: number, hiDollars: number): bigint {
    return BigInt(this.int(Math.round(loDollars * 100), Math.round(hiDollars * 100))) * 10n;
  }

  /** RFC 9562 uuid v7 with a deterministic timestamp and random bits. */
  uuid(): string {
    const ts = (this.idEpochMs + this.idCounter++).toString(16).padStart(12, "0");
    const hex = (n: number) => Array.from({ length: n }, () => this.int(0, 15).toString(16)).join("");
    const variant = (8 + this.int(0, 3)).toString(16);
    return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
  }
}
