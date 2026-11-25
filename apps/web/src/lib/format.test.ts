import { describe, expect, it } from "vitest";
import { formatDay, parseMonthParam, timeAgo } from "./format";
import { fmtCompact } from "@/components/charts/util";

describe("format", () => {
  it("formatDay", () => {
    expect(formatDay("2026-10-21")).toBe("Oct 21");
    expect(formatDay("2026-10-21", { weekday: true, withYear: true })).toBe("Wed, Oct 21, 2026");
  });
  it("timeAgo", () => {
    const now = new Date("2026-10-22T12:00:00Z");
    expect(timeAgo("2026-10-22T11:59:40Z", now)).toBe("just now");
    expect(timeAgo("2026-10-22T10:00:00Z", now)).toBe("2h ago");
    expect(timeAgo("2026-10-19T12:00:00Z", now)).toBe("3d ago");
  });
  it("parseMonthParam", () => {
    expect(parseMonthParam("2026-10")).toBe("2026-10-01");
    expect(parseMonthParam("2026-10-01")).toBe("2026-10-01");
    expect(parseMonthParam("2026-13")).toBeNull();
    expect(parseMonthParam(undefined)).toBeNull();
  });
  it("compact chart ticks", () => {
    expect(fmtCompact(850)).toBe("$850");
    expect(fmtCompact(3200)).toBe("$3.2k");
    expect(fmtCompact(-1_400_000)).toBe("-$1.4M");
  });
});
