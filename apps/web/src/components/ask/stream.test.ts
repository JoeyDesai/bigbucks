import { describe, expect, it } from "vitest";
import { parseSse, reduceTurn, type ClientEvent } from "./stream";
import type { AskTurnVM } from "./types";

describe("parseSse", () => {
  it("returns complete frames and keeps the partial remainder", () => {
    const a = parseSse('event: text_delta\ndata: {"type":"text_delta","text":"Hi"}\n\nevent: done\ndata: {"ty');
    expect(a.messages).toEqual([{ event: "text_delta", data: '{"type":"text_delta","text":"Hi"}' }]);
    const b = parseSse(`${a.rest}pe":"done"}\n\n`);
    expect(b.messages).toEqual([{ event: "done", data: '{"type":"done"}' }]);
    expect(b.rest).toBe("");
  });
});

describe("reduceTurn", () => {
  const start: AskTurnVM = { id: "a", role: "assistant", parts: [], streaming: true };
  const run = (events: ClientEvent[]) => events.reduce(reduceTurn, start);

  it("builds text, tool steps, charts and action cards in order", () => {
    const t = run([
      { type: "tool_call", id: "t1", name: "spending_summary", input: {} },
      { type: "tool_result", id: "t1", name: "spending_summary", summary: "9 rows", isError: false },
      { type: "text_delta", text: "You spent " },
      { type: "text_delta", text: "$1,113.40." },
      { type: "tool_call", id: "t2", name: "render_chart", input: {} },
      { type: "chart", id: "t2", spec: { type: "pie", title: "Sept", format: "currency", series: [{ name: "s", data: [{ x: "a", y: 1 }] }] } },
      { type: "tool_call", id: "t3", name: "recategorize", input: {} },
      { type: "pending_action", action: { id: "p1", tool: "recategorize", input: { category_id: "c" }, humanDiff: "Move 3 transactions", status: "awaiting_confirmation" } },
      { type: "text_delta", text: "  " },
      { type: "done", stopReason: "end_turn", text: "", speech: "You spent about eleven hundred dollars.", usage: { costMicroUsd: "1200" } },
    ]);
    expect(t.parts.map((p) => p.type)).toEqual(["tool", "text", "chart", "action"]);
    expect(t.parts[0]).toMatchObject({ done: true, summary: "9 rows" });
    expect(t.parts[1]).toEqual({ type: "text", text: "You spent $1,113.40." });
    expect(t.streaming).toBe(false);
    expect(t.speech).toBe("You spent about eleven hundred dollars.");
  });

  it("records errors", () => {
    expect(run([{ type: "error", code: "disabled", message: "Add a key" }]).error).toBe("Add a key");
  });
});
