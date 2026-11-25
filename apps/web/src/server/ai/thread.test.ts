import { describe, expect, it } from "vitest";
import { messagesToTurns, repairHistory, splitSpeech } from "./thread";

const chart = { type: "pie", title: "September spending", format: "currency", series: [{ name: "Spent", data: [{ x: "Groceries", y: 812.4 }, { x: "Eating Out", y: 301 }] }] };

describe("messagesToTurns", () => {
  it("folds a tool loop into one assistant turn with charts, steps and action cards", () => {
    const turns = messagesToTurns(
      [
        { id: "m1", role: "user", content: [{ type: "text", text: "Where did our money go in September?" }] },
        { id: "m2", role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "spending_summary", input: {} }] },
        { id: "m3", role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "{}" }] },
        {
          id: "m4",
          role: "assistant",
          content: [
            { type: "text", text: "You spent **$1,113.40** in September 2026." },
            { type: "tool_use", id: "tu2", name: "render_chart", input: { spec: chart } },
            { type: "tool_use", id: "tu3", name: "remember", input: { fact: "x" } },
          ],
        },
        { id: "m5", role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "ok" }, { type: "tool_result", tool_use_id: "tu3", content: "ok" }] },
        { id: "m6", role: "assistant", content: [{ type: "text", text: "Ready to confirm.<speech>You spent about eleven hundred dollars.</speech>" }] },
      ],
      [
        { id: "c1", toolUseId: "tu1", name: "spending_summary", input: {}, outputSummary: "12 category rows", status: "auto", error: null },
        { id: "c3", toolUseId: "tu3", name: "remember", input: { fact: "x" }, outputSummary: "Remember: “x”", status: "awaiting_confirmation", error: null },
      ],
    );
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    const a = turns[1]!;
    expect(a.parts.map((p) => p.type)).toEqual(["tool", "text", "chart", "action", "text"]);
    expect(a.parts[0]).toMatchObject({ type: "tool", name: "spending_summary", summary: "12 category rows", done: true });
    expect(a.parts[3]).toMatchObject({ type: "action", action: { id: "c3", status: "awaiting_confirmation", humanDiff: "Remember: “x”" } });
    expect(a.parts[4]).toEqual({ type: "text", text: "Ready to confirm." });
    expect(a.speech).toBe("You spent about eleven hundred dollars.");
  });

  it("derives speech from markdown when the tag is missing", () => {
    const [, a] = messagesToTurns(
      [
        { id: "u", role: "user", content: "hi" },
        { id: "a", role: "assistant", content: [{ type: "text", text: "**$412.18** is ready to assign. That's for October 2026." }] },
      ],
      [],
    );
    expect(a!.speech).toContain("412.18");
  });
});

describe("splitSpeech", () => {
  it("separates the spoken summary", () => {
    expect(splitSpeech("Answer.\n<speech>Short.</speech>")).toEqual({ visible: "Answer.\n", speech: "Short." });
  });
});

describe("repairHistory", () => {
  it("adds error tool_results for an interrupted tool turn", () => {
    const out = repairHistory([
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "get_overview", input: {} }] },
    ]);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "Not run: the turn was interrupted", is_error: true }] });
  });

  it("merges missing results ahead of the next user text", () => {
    const out = repairHistory([
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "x", input: {} }, { type: "tool_use", id: "b", name: "y", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }, { type: "text", text: "next" }] },
    ]);
    expect(out).toHaveLength(2);
    expect((out[1]!.content as { type: string; tool_use_id?: string }[]).map((b) => b.tool_use_id ?? b.type)).toEqual(["a", "b", "text"]);
  });

  it("leaves valid history alone", () => {
    const h = [
      { role: "user" as const, content: "q" },
      { role: "assistant" as const, content: [{ type: "text", text: "a" }] },
    ];
    expect(repairHistory(h)).toEqual(h);
  });
});
