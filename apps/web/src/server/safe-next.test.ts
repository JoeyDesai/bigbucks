import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("keeps paths on this site, with their query", () => {
    expect(safeNext("/budget")).toBe("/budget");
    expect(safeNext("/reports/net-worth?period=last12")).toBe("/reports/net-worth?period=last12");
    expect(safeNext("/activity?q=café")).toBe("/activity?q=caf%C3%A9");
    // An encoded tab stays an encoded path segment, so it can't become "//host".
    expect(safeNext("/%09/evil.example")).toBe("/%09/evil.example");
  });

  it.each([
    ["nothing", undefined],
    ["null", null],
    ["empty", ""],
    ["relative", "budget"],
    ["absolute URL", "https://evil.example/"],
    ["protocol-relative", "//evil.example"],
    ["backslash", "/\\evil.example"],
    ["tab", "/\t/evil.example"],
    ["newline", "/\n/evil.example"],
    ["carriage return", "/\r//evil.example"],
    ["leading tab", "\t//evil.example"],
    ["NUL", "/\u0000/evil.example"],
    ["DEL", "/\u007f/evil.example"],
    ["the login page", "/login"],
    ["the login page with a next", "/login?next=/budget"],
  ])("falls back to /budget: %s", (_why, next) => {
    expect(safeNext(next)).toBe("/budget");
  });
});
