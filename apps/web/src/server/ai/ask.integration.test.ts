/**
 * /api/ask turn end to end against Postgres with a scripted FakeAnthropic (no network): SSE frames,
 * persistence, history reload, pending action → confirm → core write + audit.
 */
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { AiClient } from "@homebase/ai";
import { DbUsageSink } from "@homebase/ai/db";
import { FakeAnthropic, fakeMessage, textReply, toolUseBlock } from "@homebase/ai/testing";
import { schema as s } from "@homebase/db";
import { prepareWebTestDb } from "@/test/db";
import { askTurn, framesToStream, NO_KEY_MESSAGE, type AskFrame } from "./ask";
import { confirmAction, rejectAction } from "./actions";
import { loadThread, listConversations } from "./conversations";

const SUITE = "ask";
const t = await prepareWebTestDb(SUITE);

async function collect(gen: AsyncGenerator<AskFrame>): Promise<AskFrame[]> {
  const out: AskFrame[] = [];
  for await (const f of gen) out.push(f);
  return out;
}

describe.skipIf(!t)("Ask turn (Postgres + FakeAnthropic)", () => {
  const db = t!.db;
  afterAll(async () => t?.close());
  const now = new Date("2026-10-22T16:00:00Z");
  let conversationId = "";
  let alex: { id: string; name: string };

  it("streams a tool loop as SSE and persists the conversation", async () => {
    const [u] = await db.select().from(s.users).where(eq(s.users.role, "admin"));
    alex = { id: u!.id, name: u!.displayName };
    const fake = new FakeAnthropic([
      fakeMessage({ content: [toolUseBlock("get_overview", {})] }),
      textReply("**$412.18** is ready to assign for October 2026.<speech>You have about four hundred dollars to assign.</speech>"),
    ]);
    const ai = new AiClient({ anthropic: fake, usage: new DbUsageSink(db), now: () => now });
    const frames = await collect(askTurn({ db, ai, speaker: alex, conversationId: null, message: "How much is left to assign?", deep: false, now }));

    const conv = frames[0]!;
    expect(conv).toMatchObject({ type: "conversation", created: true });
    conversationId = (conv as { id: string }).id;
    expect(frames.find((f) => f.type === "tool_call")).toMatchObject({ name: "get_overview" });
    const tr = frames.find((f) => f.type === "tool_result");
    expect(tr, JSON.stringify(tr)).toMatchObject({ name: "get_overview", isError: false });
    const text = frames.flatMap((f) => (f.type === "text_delta" ? [f.text] : [])).join("");
    expect(text).toBe("**$412.18** is ready to assign for October 2026.");
    expect(frames.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn", speech: "You have about four hundred dollars to assign." });

    // The system prompt carries the household's categories; chat uses the chat model.
    const first = fake.calls[0]!.params;
    expect(first.model).toBe("claude-sonnet-5-5");
    expect(JSON.stringify(first.system)).toContain("Groceries");

    const thread = await loadThread(db, conversationId);
    expect(thread.map((x) => x.role)).toEqual(["user", "assistant"]);
    expect(thread[1]!.parts.find((p) => p.type === "text")).toEqual({ type: "text", text: "**$412.18** is ready to assign for October 2026." });
    expect(thread[1]!.speech).toBe("You have about four hundred dollars to assign.");
    expect((await listConversations(db, alex.id)).map((c) => c.id)).toContain(conversationId);
    const usage = await db.select().from(s.aiUsage).where(eq(s.aiUsage.conversationId, conversationId));
    expect(usage).toHaveLength(2);
  });

  it("frames are valid SSE", async () => {
    const ai = new AiClient({ anthropic: new FakeAnthropic([textReply("Hi.")]), usage: new DbUsageSink(db), now: () => now });
    const stream = framesToStream(askTurn({ db, ai, speaker: alex, conversationId, message: "hello", deep: true, now }));
    const body = await new Response(stream).text();
    expect(body).toMatch(/^event: conversation\ndata: \{"type":"conversation","id":"[0-9a-f-]+","created":false\}\n\n/);
    expect(body).toContain("event: text_delta\n");
    expect(body.trimEnd().split("\n\n").at(-1)).toMatch(/^event: done\ndata: /);
  });

  it("a write tool becomes a card; Confirm runs it once through core with actor=ai and confirmed_by", async () => {
    const fake = new FakeAnthropic([fakeMessage({ content: [toolUseBlock("remember", { fact: "Costco runs are mostly groceries" })] }), textReply("That's ready to confirm.")]);
    const ai = new AiClient({ anthropic: fake, usage: new DbUsageSink(db), now: () => now });
    const frames = await collect(askTurn({ db, ai, speaker: alex, conversationId, message: "Remember that Costco runs are mostly groceries", deep: false, now }));
    // History from the earlier turns was sent back (user, tool loop, reply, …).
    expect(fake.calls[0]!.params.messages.length).toBeGreaterThan(3);
    const pa = frames.find((f) => f.type === "pending_action") as Extract<AskFrame, { type: "pending_action" }>;
    expect(pa.action).toMatchObject({ tool: "remember", status: "awaiting_confirmation", humanDiff: "Remember: “Costco runs are mostly groceries”" });
    expect(await db.select().from(s.householdMemory).where(eq(s.householdMemory.text, "Costco runs are mostly groceries"))).toHaveLength(0);

    const thread = await loadThread(db, conversationId);
    expect(thread.at(-1)!.parts.some((p) => p.type === "action" && p.action.id === pa.action.id && p.action.status === "awaiting_confirmation")).toBe(true);

    const r = await confirmAction(db, { actionId: pa.action.id, userId: alex.id });
    expect(r).toMatchObject({ ok: true, status: "confirmed" });
    expect(await db.select().from(s.householdMemory).where(eq(s.householdMemory.text, "Costco runs are mostly groceries"))).toHaveLength(1);
    const coreAudit = await db.select().from(s.auditLog).where(and(eq(s.auditLog.action, "memory.add"), eq(s.auditLog.actor, "ai")));
    expect(coreAudit[0]).toMatchObject({ userId: alex.id, confirmedBy: alex.id });
    const aiAudit = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "ai.remember"));
    expect(aiAudit[0]).toMatchObject({ actor: "ai", confirmedBy: alex.id, entity: "household_memory" });

    expect(await confirmAction(db, { actionId: pa.action.id, userId: alex.id })).toMatchObject({ ok: false, httpStatus: 409 });
    expect(await rejectAction(db, { actionId: pa.action.id, userId: alex.id })).toMatchObject({ ok: false, httpStatus: 409 });
    const after = await loadThread(db, conversationId);
    expect(after.at(-1)!.parts.find((p) => p.type === "action")).toMatchObject({ action: { status: "confirmed" } });
  });

  it("another user can't confirm someone else's card", async () => {
    const fake = new FakeAnthropic([fakeMessage({ content: [toolUseBlock("remember", { fact: "Second fact here" })] }), textReply("Ready.")]);
    const ai = new AiClient({ anthropic: fake, usage: new DbUsageSink(db), now: () => now });
    const frames = await collect(askTurn({ db, ai, speaker: alex, conversationId, message: "remember this", deep: false, now }));
    const pa = frames.find((f) => f.type === "pending_action") as Extract<AskFrame, { type: "pending_action" }>;
    const [sam] = await db.select().from(s.users).where(eq(s.users.role, "member"));
    expect(await confirmAction(db, { actionId: pa.action.id, userId: sam!.id })).toMatchObject({ ok: false, httpStatus: 404 });
    expect(await rejectAction(db, { actionId: pa.action.id, userId: alex.id })).toMatchObject({ ok: true, status: "rejected" });
  });

  it("without an API key the turn explains how to set one up and writes nothing", async () => {
    const before = await db.select().from(s.aiConversations);
    const frames = await collect(askTurn({ db, ai: null, speaker: alex, conversationId: null, message: "hi", deep: false }));
    expect(frames[0]).toEqual({ type: "error", code: "disabled", message: NO_KEY_MESSAGE });
    expect(frames[1]).toMatchObject({ type: "done", stopReason: "disabled" });
    expect(await db.select().from(s.aiConversations)).toHaveLength(before.length);
  });
});
