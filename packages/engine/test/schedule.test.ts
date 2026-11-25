import { describe, expect, it } from "vitest";
import { occurrences, occurrencesInMonth } from "../src/schedule";
import type { EngineScheduledTransaction } from "../src/types";
import type { Frequency } from "@homebase/shared";

const S = (frequency: Frequency, nextDate: string, endDate: string | null = null): EngineScheduledTransaction => ({ id: "s", accountId: "a", categoryId: null, transferAccountId: null, amount: -1n, frequency, nextDate, endDate });

describe("scheduled occurrences", () => {
  it("once / daily / weekly / biweekly / every 4 weeks", () => {
    expect(occurrences(S("once", "2026-03-05"), "2026-12-31")).toEqual(["2026-03-05"]);
    expect(occurrences(S("daily", "2026-03-30"), "2026-04-02")).toEqual(["2026-03-30", "2026-03-31", "2026-04-01", "2026-04-02"]);
    expect(occurrencesInMonth(S("weekly", "2026-03-02"), "2026-03-01")).toEqual(["2026-03-02", "2026-03-09", "2026-03-16", "2026-03-23", "2026-03-30"]);
    expect(occurrencesInMonth(S("biweekly", "2026-03-02"), "2026-03-01")).toEqual(["2026-03-02", "2026-03-16", "2026-03-30"]);
    expect(occurrencesInMonth(S("every_4_weeks", "2026-02-20"), "2026-03-01")).toEqual(["2026-03-20"]);
  });

  it("month-based frequencies clamp to month end", () => {
    expect(occurrences(S("monthly", "2026-01-31"), "2026-04-30")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    expect(occurrences(S("every_other_month", "2026-01-15"), "2026-06-30")).toEqual(["2026-01-15", "2026-03-15", "2026-05-15"]);
    expect(occurrences(S("every_3_months", "2026-01-15"), "2026-12-31")).toHaveLength(4);
    expect(occurrences(S("every_4_months", "2026-01-15"), "2026-12-31")).toHaveLength(3);
    expect(occurrences(S("twice_yearly", "2026-01-15"), "2027-12-31")).toHaveLength(4);
    expect(occurrences(S("yearly", "2026-01-15"), "2028-12-31")).toEqual(["2026-01-15", "2027-01-15", "2028-01-15"]);
    expect(occurrences(S("every_other_year", "2026-01-15"), "2030-12-31")).toEqual(["2026-01-15", "2028-01-15", "2030-01-15"]);
  });

  it("twice monthly: anchor day and 15 days apart", () => {
    expect(occurrencesInMonth(S("twice_monthly", "2026-03-01"), "2026-03-01")).toEqual(["2026-03-01", "2026-03-16"]);
    expect(occurrencesInMonth(S("twice_monthly", "2026-03-20"), "2026-04-01")).toEqual(["2026-04-05", "2026-04-20"]);
    expect(occurrencesInMonth(S("twice_monthly", "2026-01-15"), "2026-02-01")).toEqual(["2026-02-15", "2026-02-28"]);
    expect(occurrences(S("twice_monthly", "2026-03-20"), "2026-03-31")).toEqual(["2026-03-20"]);
  });

  it("respects endDate and dates before nextDate", () => {
    expect(occurrences(S("monthly", "2026-01-10", "2026-02-15"), "2026-12-31")).toEqual(["2026-01-10", "2026-02-10"]);
    expect(occurrences(S("monthly", "2026-05-10"), "2026-04-30")).toEqual([]);
  });
});
