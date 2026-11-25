/** Wealth screen sections (spec §12.3). */
import { and, eq, inArray } from "drizzle-orm";
import { assets, loans } from "@homebase/db";
import { addMonths, lastDayOfMonth, monthOf, today as localToday, type AccountKind, type ISODate, type Milli } from "@homebase/shared";
import type { DbLike } from "../context";
import { listAccounts, type AccountSummary } from "../transactions/accounts";
import { homeDetail, mortgageDetail } from "./property";
import { balancesAt, householdEntityId } from "./netWorth";

export type SectionKey = "cash" | "credit" | "investments" | "retirement" | "crypto" | "home" | "mortgage" | "other" | "business";

const SECTION_OF: Record<AccountKind, Exclude<SectionKey, "business">> = {
  checking: "cash",
  savings: "cash",
  cash: "cash",
  credit_card: "credit",
  line_of_credit: "credit",
  brokerage: "investments",
  hsa: "investments",
  retirement: "retirement",
  crypto: "crypto",
  property: "home",
  mortgage: "mortgage",
  loan: "mortgage",
  other: "other",
};

const TITLES: Record<SectionKey, string> = {
  cash: "Cash",
  credit: "Credit",
  investments: "Investments",
  retirement: "Retirement",
  crypto: "Crypto",
  home: "Home",
  mortgage: "Mortgage",
  other: "Other",
  business: "Business",
};

export interface WealthAccount extends AccountSummary {
  /** Balance at the end of last month (snapshot), for the change badge. */
  lastMonthBalance: Milli | null;
  changeVsLastMonth: Milli | null;
  home?: { assetId: string; value: Milli | null; low: Milli | null; high: Milli | null; asOf: ISODate | null; equity: Milli | null; mortgageBalance: Milli };
  mortgage?: { owed: Milli; payoffDate: ISODate | null; driftFlagged: boolean };
}

export interface WealthSection {
  key: SectionKey;
  title: string;
  total: Milli;
  accounts: WealthAccount[];
}

export async function accountsBySection(db: DbLike, opts: { includeBusiness?: boolean; includeClosed?: boolean; today?: ISODate } = {}): Promise<{ sections: WealthSection[]; businessAvailable: boolean }> {
  const today = opts.today ?? localToday();
  const household = await householdEntityId(db);
  const all = await listAccounts(db, { includeClosed: opts.includeClosed, today });
  const lastMonthEnd = lastDayOfMonth(addMonths(monthOf(today), -1));
  const prev = await balancesAt(db, [lastMonthEnd], { includeBusiness: true });
  const prevBy = new Map(prev.map((p) => [p.accountId, p.balance]));
  const ids = all.map((a) => a.id);
  const homeAssets = ids.length ? await db.select().from(assets).where(and(eq(assets.kind, "home"), inArray(assets.accountId, ids))) : [];
  const loanRows = ids.length ? await db.select({ accountId: loans.accountId }).from(loans).where(inArray(loans.accountId, ids)) : [];
  const hasLoan = new Set(loanRows.map((l) => l.accountId));

  const sections = new Map<SectionKey, WealthSection>();
  let businessAvailable = false;
  for (const a of all) {
    const isBiz = household !== null && a.entityId !== household;
    if (isBiz) businessAvailable = true;
    if (isBiz && !opts.includeBusiness) continue;
    const key: SectionKey = isBiz ? "business" : SECTION_OF[a.kind];
    const lastMonthBalance = prevBy.get(a.id) ?? null;
    const w: WealthAccount = { ...a, lastMonthBalance, changeVsLastMonth: lastMonthBalance === null ? null : a.balance - lastMonthBalance };
    if (a.kind === "property") {
      const asset = homeAssets.find((h) => h.accountId === a.id);
      if (asset) {
        const h = await homeDetail(db, { assetId: asset.id, today });
        w.home = { assetId: asset.id, value: h.latest?.value ?? null, low: h.latest?.low ?? null, high: h.latest?.high ?? null, asOf: h.latest?.asOf ?? null, equity: h.equity, mortgageBalance: h.mortgageBalance };
      }
    }
    if ((a.kind === "mortgage" || a.kind === "loan") && hasLoan.has(a.id)) {
      const m = await mortgageDetail(db, a.id, { today });
      w.mortgage = { owed: m.syncedBalance ?? m.scheduledBalance, payoffDate: m.payoffDate, driftFlagged: m.driftFlagged };
    }
    let s = sections.get(key);
    if (!s) sections.set(key, (s = { key, title: TITLES[key], total: 0n, accounts: [] }));
    s.accounts.push(w);
    s.total += a.balance;
  }
  const order: SectionKey[] = ["cash", "credit", "investments", "retirement", "crypto", "home", "mortgage", "other", "business"];
  return { sections: order.map((k) => sections.get(k)).filter((s): s is WealthSection => !!s), businessAvailable };
}
