import { describe, expect, it } from "vitest";
import { matchPendingToPosted, matchScheduled, matchYnab, payeeSimilarity, withinPct } from "../src/ingest/matching";

const c = (id: string, date: string, amount: bigint, ...texts: string[]) => ({ id, date, amount, texts });

describe("§8.4 matching rules", () => {
  it("payee similarity ignores store numbers, states and card noise", () => {
    expect(payeeSimilarity("COSTCO WHSE #0000 FAIRVIEW VA", "Costco")).toBe(1);
    expect(payeeSimilarity("SQ *KESSLER S MINFAIRVIEW VA", "Kessler's Mini Mart")).toBe(1);
    expect(payeeSimilarity("SHELL OIL 00000000 FAIRVIEW VA", "Kroger")).toBeLessThan(0.35);
    expect(payeeSimilarity("", "Kroger")).toBe(0);
  });

  it("±20% amount tolerance keeps the sign", () => {
    expect(withinPct(-55000n, -52100n, 20n)).toBe(true); // tip/hold
    expect(withinPct(-70000n, -52100n, 20n)).toBe(false);
    expect(withinPct(52100n, -52100n, 20n)).toBe(false);
  });

  it("pending → posted: same payee family, ≤ 7 days, ±20%", () => {
    const posted = { date: "2026-10-23", amount: -55000n, texts: ["SHELL OIL 12345678 FAIRVIEW VA"] };
    const pool = [c("a", "2026-10-21", -52100n, "SHELL OIL 00000000 FAIRVIEW VA"), c("b", "2026-10-21", -55000n, "KROGER #000"), c("old", "2026-10-10", -55000n, "SHELL OIL")];
    expect(matchPendingToPosted(posted, pool)?.id).toBe("a");
    expect(matchPendingToPosted({ ...posted, amount: -80000n }, pool)).toBeNull();
  });

  it("scheduled → synced: exact or within $1, ±4 days, closest wins", () => {
    const t = { date: "2026-10-21", amount: -89990n, texts: ["FAIRVIEW POWER BILL PAY"] };
    expect(matchScheduled(t, [c("s1", "2026-10-18", -90000n), c("s2", "2026-10-26", -89990n)])?.id).toBe("s1");
    expect(matchScheduled(t, [c("s3", "2026-10-21", -91000n)])).toBeNull(); // $1.01 off
    expect(matchScheduled(t, [c("s4", "2026-10-26", -89990n)])).toBeNull(); // 5 days
  });

  it("YNAB → synced: exact amount, ±3 days, fuzzy payee; transfers match payment descriptors", () => {
    const t = { date: "2026-10-19", amount: -421180n, texts: ["FABRIKAM E-PAYMENT 0000", "Fabrikam"] };
    expect(matchYnab(t, [{ ...c("y1", "2026-10-18", -421180n, "Transfer : Fabrikam Cash Back"), transfer: true }])?.id).toBe("y1");
    expect(matchYnab(t, [c("y2", "2026-10-18", -421170n, "Fabrikam")])).toBeNull(); // not exact
    expect(matchYnab(t, [c("y3", "2026-10-14", -421180n, "Fabrikam")])).toBeNull(); // 5 days
    expect(matchYnab({ ...t, texts: ["COSTCO WHSE"] }, [c("y4", "2026-10-19", -421180n, "Kroger"), c("y5", "2026-10-19", -421180n, "Costco")])?.id).toBe("y5");
    // A text-less YNAB row matches only when it is the sole candidate.
    expect(matchYnab(t, [c("y6", "2026-10-19", -421180n)])?.id).toBe("y6");
    expect(matchYnab(t, [c("y6", "2026-10-19", -421180n), c("y7", "2026-10-20", -421180n)])).toBeNull();
  });
});
