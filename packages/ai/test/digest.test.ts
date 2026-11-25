import { describe, expect, it } from "vitest";
import { AiClient, amountsAreGrounded, deterministicDigest, digestStatsText, generateDigest, InMemoryUsageSink, type DigestStats } from "../src";
import { FakeAnthropic, jsonReply } from "../src/testing";

const now = () => new Date("2026-10-25T22:00:00Z");
const stats: DigestStats = {
  weekStart: "2026-10-19",
  weekEnd: "2026-10-25",
  month: "2026-10-01",
  spentMtdMilli: 3_412_500n,
  assignedMtdMilli: 5_000_000n,
  overspent: [{ category: "Dining Out", availableMilli: -42_100n }],
  unapprovedCount: 7,
  uncategorizedCount: 2,
  unusual: [{ date: "2026-10-21", payee: "Lowe's", amountMilli: -612_400n, category: "House Projects", typicalMilli: -85_000n }],
  newSubscriptions: [{ payee: "Max", amountMilli: -16_990n, cadence: "monthly" }],
  priceChanges: [{ payee: "Netflix", fromMilli: -15_490n, toMilli: -17_990n }],
  billsDue: [{ date: "2026-10-28", payee: "Fairview Power", amountMilli: -142_000n }],
  netWorth: { currentMilli: 512_340_000n, changeMilli: 2_100_000n, sinceDate: "2026-10-18" },
};

describe("digest", () => {
  it("renders pre-computed stats with formatted amounts", () => {
    const t = digestStatsText(stats);
    expect(t).toContain("Spent this month so far: $3,412.50 of $5,000.00 assigned");
    expect(t).toContain("Netflix -$15.49 to -$17.99");
    expect(t).toContain("change +$2,100.00");
  });

  it("deterministic fallback covers every section", () => {
    const d = deterministicDigest(stats);
    expect(d.source).toBe("deterministic");
    expect(d.body).toContain("Overspent:** Dining Out (-$42.10)");
    expect(d.body).toContain("Fairview Power -$142.00 on 2026-10-28");
    expect(d.body).toContain("Netflix -$15.49 to -$17.99");
    expect(d.pushText.length).toBeLessThanOrEqual(180);
  });

  it("falls back when AI is null or the cap is reached", async () => {
    expect((await generateDigest(null, stats)).source).toBe("deterministic");
    const capped = new AiClient({ anthropic: new FakeAnthropic([]), usage: new InMemoryUsageSink({ "2026-10-01": 8_000_000n }), now });
    expect((await generateDigest(capped, stats)).source).toBe("deterministic");
  });

  it("uses Haiku output when every figure is grounded in the stats", async () => {
    const fake = new FakeAnthropic([
      jsonReply({ title: "Dining is over", push_text: "Dining Out is over by $42.10; Fairview Power $142 due Wed.", body: "You've spent $3,412.50 of $5,000.00." }),
    ]);
    const usage = new InMemoryUsageSink();
    const d = await generateDigest(new AiClient({ anthropic: fake, usage, now }), stats);
    expect(d.source).toBe("ai");
    expect(fake.calls[0]!.params.model).toBe("claude-haiku-5-5");
    expect(usage.records[0]!.purpose).toBe("digest");
  });

  it("rejects AI text containing numbers not in the stats", async () => {
    expect(amountsAreGrounded("You spent $9,999.00", stats)).toBe(false);
    const fake = new FakeAnthropic([jsonReply({ title: "Week", push_text: "Spent $3,500 so far", body: "x" })]);
    const d = await generateDigest(new AiClient({ anthropic: fake, usage: new InMemoryUsageSink(), now }), stats);
    expect(d.source).toBe("deterministic");
  });
});
