import Link from "next/link";
import { listAccounts } from "@homebase/core";
import { today } from "@homebase/shared";
import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { SettingsFrame } from "@/components/settings/SettingsFrame";
import { AccountsEditor } from "@/components/settings/AccountsEditor";

export const metadata = { title: "Accounts" };
export const dynamic = "force-dynamic";

const KIND: Record<string, string> = {
  checking: "Checking",
  savings: "Savings",
  cash: "Cash",
  credit_card: "Credit card",
  line_of_credit: "Line of credit",
  brokerage: "Brokerage",
  retirement: "Retirement",
  hsa: "HSA",
  crypto: "Crypto",
  property: "Property",
  mortgage: "Mortgage",
  loan: "Loan",
  other: "Other",
};

export default async function Page() {
  await requireUser();
  const accounts = await listAccounts(getDb(), { includeClosed: true, today: today() });
  return (
    <SettingsFrame
      title="Accounts"
      intro={
        <>
          Names, nicknames, statement due days and monthly contributions. New accounts found by a sync wait in the{" "}
          <Link href="/activity" className="text-accent underline-offset-2 hover:underline">
            new-account inbox on Activity
          </Link>
          , where you set their kind, budget status, entity and sign.
        </>
      }
    >
      <AccountsEditor
        accounts={accounts.map((a) => ({
          id: a.id,
          name: a.name,
          nickname: a.nickname,
          institution: a.institution,
          kind: a.kind,
          kindLabel: KIND[a.kind] ?? a.kind,
          onBudget: a.onBudget,
          closed: a.closed,
          entityName: a.entityName,
          balance: a.balance.toString(),
          statementDueDay: a.statementDueDay,
          monthlyContribution: a.monthlyContribution?.toString() ?? null,
          note: a.note,
          source: a.source,
        }))}
      />
    </SettingsFrame>
  );
}
