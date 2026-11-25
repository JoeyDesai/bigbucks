/** `get_overview()` (spec §11.3): RTA, overspent categories, unapproved count, net worth, last sync per account. */
import { sql } from "drizzle-orm";
import { monthOf, today as localToday, type ISODate, type Milli, type Month } from "@homebase/shared";
import { getBudgetMonth } from "./budget/view";
import type { DbLike } from "./context";
import { listAccounts, type StatusColor } from "./transactions/accounts";
import { netWorth } from "./wealth/netWorth";

export interface Overview {
  asOf: ISODate;
  month: Month;
  readyToAssign: Milli;
  assignedInFuture: Milli;
  overspent: { categoryId: string; name: string; available: Milli; kind: "cash" | "credit" | "mixed" }[];
  underfundedTotal: Milli;
  unapprovedCount: number;
  uncategorizedCount: number;
  netWorth: Milli;
  netWorthChangeVsLastMonth: Milli;
  ageOfMoney: number | null;
  accounts: { id: string; name: string; balance: Milli; lastSyncAt: Date | null; statusColor: StatusColor; onBudget: boolean }[];
}

export async function getOverview(db: DbLike, opts: { today?: ISODate } = {}): Promise<Overview> {
  const today = opts.today ?? localToday();
  const month = monthOf(today);
  const view = await getBudgetMonth(db, month, { today });
  const cats = [...view.groups.flatMap((g) => g.categories), ...view.hidden, ...(view.uncategorized ? [view.uncategorized] : [])];
  const overspent = cats
    .filter((c) => c.available < 0n)
    .map((c) => ({ categoryId: c.id, name: c.name, available: c.available, kind: (c.cashOverspend > 0n && c.creditOverspend > 0n ? "mixed" : c.cashOverspend > 0n ? "cash" : "credit") as "cash" | "credit" | "mixed" }));
  const counts = await db.execute<{ unapproved: bigint; uncategorized: bigint }>(sql`
    SELECT count(*) FILTER (WHERE NOT t.approved) AS unapproved,
      count(*) FILTER (WHERE a.on_budget AND NOT t.is_split AND NOT t.is_starting_balance AND t.transfer_account_id IS NULL AND (t.category_id IS NULL OR c.kind = 'uncategorized')) AS uncategorized
    FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.deleted_at IS NULL`);
  const nw = await netWorth(db, { period: "1M", granularity: "month", today });
  const accts = await listAccounts(db, { today });
  return {
    asOf: today,
    month,
    readyToAssign: view.summary.readyToAssign,
    assignedInFuture: view.summary.assignedInFuture,
    overspent,
    underfundedTotal: view.summary.underfunded,
    unapprovedCount: Number(counts.rows[0]!.unapproved),
    uncategorizedCount: Number(counts.rows[0]!.uncategorized),
    netWorth: nw.headline.netWorth,
    netWorthChangeVsLastMonth: nw.headline.changeVsLastMonth,
    ageOfMoney: view.summary.ageOfMoney,
    accounts: accts.map((a) => ({ id: a.id, name: a.displayName, balance: a.balance, lastSyncAt: a.lastSyncAt, statusColor: a.statusColor, onBudget: a.onBudget })),
  };
}
