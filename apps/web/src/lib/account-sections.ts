import type { AccountVM } from "./view-models";

export interface AccountSection {
  id: "cash" | "credit" | "tracking" | "closed";
  title: string;
  accounts: AccountVM[];
  total: bigint;
}

/** YNAB's account groups: CASH and CREDIT (on budget), TRACKING (off budget), CLOSED. */
export function accountSections(accounts: AccountVM[]): AccountSection[] {
  const open = accounts.filter((a) => !a.closed);
  const sum = (xs: AccountVM[]) => xs.reduce((s, a) => s + a.balance, 0n);
  const cash = open.filter((a) => a.onBudget && a.section !== "credit");
  const credit = open.filter((a) => a.onBudget && a.section === "credit");
  const tracking = open.filter((a) => !a.onBudget);
  const closed = accounts.filter((a) => a.closed);
  const out: AccountSection[] = [
    { id: "cash", title: "Cash", accounts: cash, total: sum(cash) },
    { id: "credit", title: "Credit", accounts: credit, total: sum(credit) },
    { id: "tracking", title: "Investments & tracking", accounts: tracking, total: sum(tracking) },
    { id: "closed", title: "Closed", accounts: closed, total: sum(closed) },
  ];
  return out.filter((s) => s.accounts.length > 0);
}
