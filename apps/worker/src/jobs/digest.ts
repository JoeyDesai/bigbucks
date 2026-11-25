/**
 * digest.weekly (Sun 18:00, §11.6). Computes the pre-computed stats (never the raw ledger), hands them
 * to an injected generator (Haiku via @homebase/ai, with a deterministic fallback), stores the result
 * as a chat message referenced by `settings.digest_latest` (the web app pins it), and pushes it.
 */
import { and, desc, eq, gte, isNull, lt, lte, max, ne, sql } from "drizzle-orm";
import { type Db, accounts, aiConversations, aiMessages, budgetMonthCache, categories, payees, scheduledTransactions, transactions, vNetWorthDaily } from "@homebase/db";
import { occurrences } from "@homebase/engine";
import { generateDigest, type Digest, type DigestStats } from "@homebase/ai";
import { addDays, monthOf } from "@homebase/shared";
import { todayOf, type WorkerContext } from "../context";
import { createWorkerAiClient } from "../ai";
import { HOUSEHOLD_ENTITY } from "../ingest/accounts";
import { SETTING_KEYS, setSetting } from "../settings";

export type { Digest, DigestStats };

export type DigestGenerator = (stats: DigestStats) => Promise<Digest>;

/** Haiku via @homebase/ai when ANTHROPIC_API_KEY is set (and under the cost cap); deterministic text otherwise. */
export function defaultDigestGenerator(db: Db, apiKey: string | undefined): DigestGenerator {
  return async (stats) => generateDigest(await createWorkerAiClient(db, apiKey), stats);
}

/** Integer square root (bigint). */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n < 0n ? 0n : n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

export async function computeDigestStats(ctx: Pick<WorkerContext, "db" | "now">): Promise<DigestStats> {
  const db = ctx.db;
  const weekEnd = todayOf(ctx);
  const weekStart = addDays(weekEnd, -6);
  const month = monthOf(weekEnd);

  // Budget figures from the engine cache (latest version).
  const [ver] = await db.select({ v: max(budgetMonthCache.engineVersion) }).from(budgetMonthCache);
  const cache = ver?.v
    ? await db
        .select({ name: categories.name, kind: categories.kind, assigned: budgetMonthCache.assignedMilli, activity: budgetMonthCache.activityMilli, available: budgetMonthCache.availableMilli })
        .from(budgetMonthCache)
        .innerJoin(categories, eq(categories.id, budgetMonthCache.categoryId))
        .where(and(eq(budgetMonthCache.engineVersion, ver.v), eq(budgetMonthCache.month, month)))
    : [];
  let spent = 0n;
  let assigned = 0n;
  const overspent: DigestStats["overspent"] = [];
  for (const c of cache) {
    if (c.kind === "internal_rta") continue;
    assigned += c.assigned;
    if (c.kind !== "cc_payment") spent -= c.activity;
    if (c.available < 0n) overspent.push({ category: c.name, availableMilli: c.available });
  }

  const live = and(isNull(transactions.deletedAt), ne(transactions.cleared, "pending"));
  const [unapproved] = await db.select({ n: sql<number>`count(*)::int` }).from(transactions).where(and(live, eq(transactions.approved, false)));
  const [uncategorized] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(and(live, eq(accounts.onBudget, true), isNull(transactions.categoryId), eq(transactions.isSplit, false), isNull(transactions.transferAccountId), eq(transactions.isStartingBalance, false)));

  // Unusual: this week's outflows more than 3σ above that payee's prior 180-day norm (n ≥ 5).
  const week = await db
    .select({ date: transactions.date, amount: transactions.amountMilli, payeeId: transactions.payeeId, payee: payees.name, category: categories.name })
    .from(transactions)
    .innerJoin(payees, eq(payees.id, transactions.payeeId))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(live, gte(transactions.date, weekStart), lte(transactions.date, weekEnd), lt(transactions.amountMilli, 0n)));
  const unusual: DigestStats["unusual"] = [];
  for (const t of week) {
    const hist = await db
      .select({ n: sql<string>`count(*)::text`, s: sql<string>`coalesce(sum(-${transactions.amountMilli}), 0)::text`, ss: sql<string>`coalesce(sum((${transactions.amountMilli})::numeric * (${transactions.amountMilli})::numeric), 0)::text` })
      .from(transactions)
      .where(and(live, eq(transactions.payeeId, t.payeeId!), lt(transactions.amountMilli, 0n), gte(transactions.date, addDays(weekStart, -180)), lt(transactions.date, weekStart)));
    const n = BigInt(hist[0]?.n ?? "0");
    if (n < 5n) continue;
    const s = BigInt(hist[0]!.s);
    const ss = BigInt(hist[0]!.ss.split(".")[0]!);
    const mean = s / n;
    const sigma = isqrt(ss / n - mean * mean);
    if (-t.amount > mean + 3n * sigma && -t.amount > mean) unusual.push({ date: t.date, payee: t.payee, amountMilli: t.amount, category: t.category, typicalMilli: -mean });
  }

  // Bills due in the next 7 days (scheduled outflows).
  const sched = await db
    .select({ id: scheduledTransactions.id, accountId: scheduledTransactions.accountId, categoryId: scheduledTransactions.categoryId, transferAccountId: scheduledTransactions.transferAccountId, amount: scheduledTransactions.amountMilli, frequency: scheduledTransactions.frequency, nextDate: scheduledTransactions.nextDate, endDate: scheduledTransactions.endDate, payee: payees.name })
    .from(scheduledTransactions)
    .leftJoin(payees, eq(payees.id, scheduledTransactions.payeeId))
    .where(and(isNull(scheduledTransactions.deletedAt), lte(scheduledTransactions.nextDate, addDays(weekEnd, 7))));
  const billsDue: DigestStats["billsDue"] = [];
  for (const s of sched) {
    if (s.amount >= 0n) continue;
    for (const d of occurrences({ ...s, amount: s.amount }, addDays(weekEnd, 7))) if (d > weekEnd) billsDue.push({ date: d, payee: s.payee ?? "Scheduled", amountMilli: s.amount });
  }
  billsDue.sort((a, b) => (a.date < b.date ? -1 : 1));

  // Net worth (Household).
  const nw = await db
    .select({ date: vNetWorthDaily.date, value: vNetWorthDaily.netWorthMilli })
    .from(vNetWorthDaily)
    .where(and(eq(vNetWorthDaily.entityName, HOUSEHOLD_ENTITY), lte(vNetWorthDaily.date, weekEnd)))
    .orderBy(desc(vNetWorthDaily.date))
    .limit(8);
  const netWorth = nw.length >= 2 ? { currentMilli: nw[0]!.value, changeMilli: nw[0]!.value - nw[nw.length - 1]!.value, sinceDate: nw[nw.length - 1]!.date } : null;

  return {
    weekStart,
    weekEnd,
    month,
    spentMtdMilli: spent,
    assignedMtdMilli: assigned,
    overspent,
    unapprovedCount: unapproved?.n ?? 0,
    uncategorizedCount: uncategorized?.n ?? 0,
    unusual,
    newSubscriptions: [], // TODO(categorizer): recurring.ts detectRecurring → new subscriptions
    priceChanges: [], // TODO(categorizer): priceIncreasesSince
    billsDue,
    netWorth,
  };
}

export async function runWeeklyDigest(ctx: WorkerContext): Promise<{ conversationId: string; messageId: string; digest: Digest; push: unknown }> {
  const stats = await computeDigestStats(ctx);
  const digest = await ctx.digest(stats);
  const title = `${digest.title} · ${stats.weekStart} – ${stats.weekEnd}`;
  const { conversationId, messageId } = await ctx.db.transaction(async (tx) => {
    const [conv] = await tx.insert(aiConversations).values({ title }).returning({ id: aiConversations.id });
    const [msg] = await tx
      .insert(aiMessages)
      .values({ conversationId: conv!.id, role: "assistant", content: [{ type: "text", text: digest.body }], model: digest.source === "ai" ? "digest" : null })
      .returning({ id: aiMessages.id });
    await setSetting(tx, SETTING_KEYS.digestLatest, { conversation_id: conv!.id, message_id: msg!.id, week_end: stats.weekEnd, title, source: digest.source });
    return { conversationId: conv!.id, messageId: msg!.id };
  });
  const push = await ctx.push.sendToAll("digest", { title: digest.title, body: digest.pushText, url: `/ask?c=${conversationId}`, tag: "digest" });
  return { conversationId, messageId, digest, push };
}
