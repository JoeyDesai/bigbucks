import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getAccount, holdings, homeDetail, investmentGrowth, mortgageDetail, NotFoundError } from "@homebase/core";
import { today as localToday } from "@homebase/shared";
import { getDb } from "@/server/db";
import { requireUser } from "@/server/auth";
import { accountHistory, yearlyBalances } from "@/server/queries/wealth";
import { displayBalance } from "@/server/queries/transactions";
import { PageHeader } from "@/components/shell/PageHeader";
import { sourceLabel } from "@/lib/format";
import { Money } from "@/components/ui/Money";
import { AccountDetail, HomeDetailView, MortgageDetailView } from "./AccountDetail";

const INVEST = new Set(["brokerage", "retirement", "hsa", "crypto", "other"]);

export default async function WealthAccountPage({ params }: { params: Promise<{ accountId: string }> }) {
  await requireUser();
  const { accountId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(accountId)) notFound();
  const db = getDb();
  const today = localToday();
  const account = await getAccount(db, accountId, { today }).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const history = await accountHistory(accountId, today);

  let body: React.ReactNode;
  if (account.kind === "property") {
    const h = await homeDetail(db, { accountId, today }).catch(() => null);
    body = h ? (
      <HomeDetailView
        assetId={h.asset.id}
        latest={h.latest ? { value: h.latest.value, low: h.latest.low, high: h.latest.high, asOf: h.latest.asOf, source: h.latest.source, comps: Array.isArray(h.latest.comps) ? (h.latest.comps as Record<string, unknown>[]) : [] } : null}
        valuations={h.valuations}
        equitySeries={h.equitySeries}
        equity={h.equity}
        mortgageBalance={h.mortgageBalance}
        purchasePrice={h.purchasePrice}
        purchaseDate={h.purchaseDate}
        appreciation={h.appreciation}
      />
    ) : (
      <AccountDetail invest={false} history={history} holdings={null} growth={[]} />
    );
  } else if (account.kind === "mortgage" || account.kind === "loan") {
    const m = await mortgageDetail(db, accountId, { today }).catch(() => null);
    body = m ? (
      <MortgageDetailView
        accountId={accountId}
        today={today}
        servicer={m.servicer}
        ratePct={m.terms.annualRatePct}
        payment={m.terms.payment}
        escrow={m.terms.escrow}
        owed={m.syncedBalance ?? m.scheduledBalance}
        scheduledBalance={m.scheduledBalance}
        drift={m.drift}
        driftFlagged={m.driftFlagged}
        payoffDate={m.payoffDate}
        interestPaid={m.interestPaidToDate}
        principalPaid={m.principalPaidToDate}
        remainingInterest={m.remainingInterest}
        nextPayment={m.nextPayment}
        base={yearlyBalances(m.schedule.rows)}
        totalInterest={m.schedule.totalInterest}
      />
    ) : (
      <AccountDetail invest={false} history={history} holdings={null} growth={[]} />
    );
  } else if (INVEST.has(account.kind)) {
    const [h, g] = [await holdings(db, { accountId, includeBusiness: true }), await investmentGrowth(db, accountId, 12, { today })];
    body = (
      <AccountDetail
        invest
        history={history}
        holdings={h.positions.length ? { asOf: h.asOf, total: h.total, positions: h.positions.map((p) => ({ symbol: p.symbol, name: p.name, quantity: p.quantity, price: p.price, marketValue: p.marketValue, gain: p.gain, weightBps: p.weightBps })), allocation: h.allocation } : null}
        growth={g.months.map((m) => ({ month: m.month, contributions: m.contributions, market: m.marketChange, known: m.contributionsKnown }))}
      />
    );
  } else {
    body = <AccountDetail invest={false} history={history} holdings={null} growth={[]} registerHref={account.onBudget || account.transactionCount > 0 ? `/activity/${accountId}` : undefined} />;
  }

  return (
    <>
      <div className="px-2 pt-2 lg:px-6 lg:pt-6">
        <Link href="/wealth" className="inline-flex min-h-11 items-center gap-1 px-2 text-[14px] font-semibold text-accent hover:text-accent-hover">
          <ChevronLeft size={16} strokeWidth={1.75} aria-hidden /> Wealth
        </Link>
      </div>
      <PageHeader title={account.displayName} eyebrow={`${account.institution ?? sourceLabel(account.source)}${account.entityName !== "Household" ? ` · ${account.entityName}` : ""}`} className="lg:pt-2" />
      <div className="px-4 lg:px-8">
        <Money value={displayBalance(account)} display tone={displayBalance(account) < 0n ? "neg" : "ink"} className="block text-[40px] leading-none" />
        {body}
      </div>
    </>
  );
}
