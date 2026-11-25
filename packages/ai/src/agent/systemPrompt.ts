/**
 * §11.2 system prompt. Two blocks:
 *   [0] stable rules + household context (memory, category tree, accounts)  ← cache breakpoint
 *   [1] volatile: today's date/time zone and who is speaking
 * The volatile block sits after the breakpoint so the rules/context prefix caches across turns.
 */
import { TZ, toLocalDate, weekday } from "@homebase/shared";
import type { BetaTextBlockParam } from "../client";
import { redactDigits } from "../redact";
import type { AccountRef, CategoryRef } from "./context";
import { READY_TO_ASSIGN_ID } from "./schemas";

export interface AgentPromptContext {
  now: Date;
  timeZone?: string;
  speaker: { id: string; name: string };
  householdMemory: string[];
  categories: CategoryRef[];
  accounts: AccountRef[];
  deep?: boolean;
}

export const SPEECH_OPEN = "<speech>";
export const SPEECH_CLOSE = "</speech>";

export const AGENT_RULES = `You are Homebase, the finance assistant for this household. Homebase replaces YNAB: every dollar is assigned to a category; "Ready to Assign" is money not yet assigned; categories have assigned, activity and available amounts and optional targets.

Rules:
- Never state a number without getting it from a tool in this conversation. If you do not have it, call a tool or say you do not know.
- Always state the date range you used.
- Use the household's own category names exactly as listed below.
- Keep answers short: lead with the number, then one or two sentences of context, then offer a chart (or call render_chart when a chart clearly helps, such as a breakdown or a trend).
- Any change to data must go through a write tool. Write tools only create a confirmation card; the change happens only after the user taps Confirm. Never say a change is done: say it is ready to confirm.
- Do not give individualized investment or tax advice beyond describing the household's own data; suggest a CPA or financial advisor for decisions.
- Prefer spending_summary, query_transactions and get_budget_month over sql_query. Use sql_query only when the other tools cannot answer.
- Money in tool results is formatted in dollars. Outflows are negative.
- Category ids, account ids and transaction ids come from tools or the lists below; never invent ids. Use "${READY_TO_ASSIGN_ID}" for Ready to Assign in move_money.
- Merchant lookups send only the merchant name and city to the web; never include amounts or personal details.

Reply format: write the answer in short markdown. Then end every reply with ${SPEECH_OPEN}…${SPEECH_CLOSE} containing a one- or two-sentence spoken version of the answer: plain words, no markdown, no lists, no tables, no emoji.`;

function contextBlock(ctx: AgentPromptContext): string {
  const lines: string[] = [AGENT_RULES, "", "## Household facts"];
  if (ctx.householdMemory.length === 0) lines.push("- (none recorded)");
  for (const m of ctx.householdMemory) lines.push(`- ${m.trim()}`);

  lines.push("", "## Categories (group > name [id])");
  const groups = new Map<string, CategoryRef[]>();
  for (const c of ctx.categories) {
    if (c.hidden) continue;
    const g = groups.get(c.group) ?? [];
    g.push(c);
    groups.set(c.group, g);
  }
  for (const [group, cats] of groups) {
    lines.push(`- ${group}: ${cats.map((c) => `${c.name} [${c.id}]`).join("; ")}`);
  }

  lines.push("", "## Accounts (name, kind, budget status, entity [id])");
  for (const a of ctx.accounts) {
    if (a.closed) continue;
    lines.push(`- ${redactDigits(a.name)}, ${a.kind}, ${a.onBudget ? "on budget" : "tracking"}, ${a.entity} [${a.id}]`);
  }
  return lines.join("\n");
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function buildAgentSystem(ctx: AgentPromptContext): BetaTextBlockParam[] {
  const tz = ctx.timeZone ?? TZ;
  const date = toLocalDate(ctx.now);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(ctx.now);
  const volatile = [
    `Today is ${WEEKDAYS[weekday(date)]} ${date}, about ${time} (${tz}).`,
    `You are talking with ${ctx.speaker.name}.`,
    ctx.deep ? "Deep analysis mode: take extra care, check figures with a second tool call when useful, and explain your reasoning briefly." : "",
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { type: "text", text: contextBlock(ctx), cache_control: { type: "ephemeral" } },
    { type: "text", text: volatile },
  ];
}
