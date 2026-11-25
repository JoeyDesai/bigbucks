import "server-only";
import { listPayees, listScheduled } from "@homebase/core";
import type { Flag, Frequency } from "@homebase/shared";
import { getDb } from "../db";

export interface ScheduledVM {
  id: string;
  accountId: string;
  accountName: string;
  payeeName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  transferAccountId: string | null;
  amount: bigint;
  frequency: Frequency;
  nextDate: string;
  endDate: string | null;
  memo: string | null;
  flag: Flag | null;
  splits: { amount: bigint; categoryId: string | null; memo: string | null }[];
  /** Occurrences in the next 35 days. */
  upcoming: string[];
}

export async function loadScheduled(today: string): Promise<ScheduledVM[]> {
  const rows = await listScheduled(getDb(), { today, horizonDays: 35 });
  return rows.map((s) => ({
    id: s.id,
    accountId: s.accountId,
    accountName: s.accountName,
    payeeName: s.payeeName,
    categoryId: s.categoryId,
    categoryName: s.categoryName,
    transferAccountId: s.transferAccountId,
    amount: s.amountMilli,
    frequency: s.frequency,
    nextDate: String(s.nextDate),
    endDate: s.endDate ? String(s.endDate) : null,
    memo: s.memo,
    flag: s.flag,
    splits: s.splits,
    upcoming: s.upcoming,
  }));
}

export interface PayeeOption {
  id: string;
  name: string;
  defaultCategoryId: string | null;
  defaultCategoryName: string | null;
  uses: number;
}

/** Payees for autocomplete, most used first. */
export async function loadPayeeOptions(): Promise<PayeeOption[]> {
  const rows = await listPayees(getDb(), { limit: 2000 });
  return rows
    .map((p) => ({ id: p.id, name: p.name, defaultCategoryId: p.defaultCategoryId, defaultCategoryName: p.defaultCategoryName, uses: p.transactionCount }))
    .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
}
