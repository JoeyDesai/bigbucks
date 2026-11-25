import "server-only";
import { addMonths, lastDayOfMonth, monthOf, type ISODate } from "@homebase/shared";
import { balancesAt, type AmortizationRow } from "@homebase/core";
import { getDb } from "../db";

/** Remaining balance at each January (plus the final row) for the amortization chart. */
export function yearlyBalances(rows: AmortizationRow[]): { date: string; balance: bigint }[] {
  const out: { date: string; balance: bigint }[] = [];
  for (const r of rows) if (r.date.slice(5, 7) === "01") out.push({ date: r.date, balance: r.balance });
  const last = rows[rows.length - 1];
  if (last && out[out.length - 1]?.date !== last.date) out.push({ date: last.date, balance: last.balance });
  return out;
}

/** One account's balance at each month end over the last `months` months (and today). */
export async function accountHistory(accountId: string, today: ISODate, months = 12): Promise<{ date: string; value: bigint }[]> {
  const dates: ISODate[] = [];
  for (let i = months; i >= 1; i--) dates.push(lastDayOfMonth(addMonths(monthOf(today), -i)));
  dates.push(today);
  const rows = await balancesAt(getDb(), dates, { accountIds: [accountId], includeBusiness: true });
  return rows.sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({ date: r.date, value: r.balance }));
}
