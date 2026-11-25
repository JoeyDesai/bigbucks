import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeftRight, ChartPie, CircleHelp, Coins, Landmark, PiggyBank, Pencil, Settings, Wallet, type LucideIcon } from "lucide-react";
import { monthOf, today as localToday } from "@homebase/shared";
import { dollars } from "@/lib/format";
import { requireUser } from "@/server/auth";
import { loadBucketMonth } from "@/server/queries/glow";
import { GuideBack } from "./GuideBack";

export const metadata = { title: "How it works" };

const SECTIONS: { id: string; title: string; icon: LucideIcon }[] = [
  { id: "idea", title: "The idea", icon: Coins },
  { id: "budget", title: "Budget page", icon: Wallet },
  { id: "income", title: "Money coming in", icon: Landmark },
  { id: "savings", title: "Savings & Ready to save", icon: PiggyBank },
  { id: "transactions", title: "Transactions", icon: ArrowLeftRight },
  { id: "reflect", title: "Reflect", icon: ChartPie },
  { id: "edit", title: "Editing buckets", icon: Pencil },
  { id: "settings", title: "Settings & syncing", icon: Settings },
  { id: "faq", title: "Quick answers", icon: CircleHelp },
];

function Section({ id, children }: { id: string; children: ReactNode }) {
  const s = SECTIONS.find((x) => x.id === id)!;
  const Icon = s.icon;
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="card scroll-mt-6 p-5 sm:p-7">
      <h2 id={`${id}-h`} className="mb-4 flex items-center gap-3 text-[20px] font-semibold text-ink">
        <span className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-accent-soft">
          <Icon size={18} strokeWidth={2} aria-hidden className="text-accent" />
        </span>
        {s.title}
      </h2>
      <div className="guide-body space-y-3 text-[15px] leading-relaxed text-ink-2">{children}</div>
    </section>
  );
}

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="space-y-2">
      {items.map((it, i) => (
        <li key={i} className="flex gap-3">
          <span className="num mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12.5px] font-semibold text-accent">{i + 1}</span>
          <span>{it}</span>
        </li>
      ))}
    </ol>
  );
}

function Q({ q, children }: { q: string; children: ReactNode }) {
  return (
    <div className="border-t border-rule pt-3 first:border-0 first:pt-0">
      <h3 className="mb-1 text-[15px] font-semibold text-ink">{q}</h3>
      <div className="text-ink-2">{children}</div>
    </div>
  );
}

const B = ({ children }: { children: ReactNode }) => <strong className="font-semibold text-ink">{children}</strong>;
const K = ({ children }: { children: ReactNode }) => <kbd className="num rounded-[6px] border border-rule-strong bg-paper-sunken px-1.5 py-0.5 text-[12.5px] font-semibold text-ink">{children}</kbd>;

/** How Big Bucks works: every screen and idea in plain words, with this month's real Ready to save math. */
export default async function GuidePage() {
  await requireUser();
  const today = localToday();
  const month = await loadBucketMonth(monthOf(today), today);
  const ready = month.savings.ready;

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 pb-10 pt-3 sm:px-6 lg:px-10 lg:pt-8">
      <GuideBack />
      <header className="mb-6 lg:mb-8">
        <h1 className="display text-[30px] leading-tight text-ink lg:text-[36px]">How Big Bucks works</h1>
        <p className="mt-2 max-w-[62ch] text-[15px] text-ink-2">Everything in one place: what each screen shows, how money moves between buckets and savings, and how to do the common things fast.</p>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="On this page" className="lg:sticky lg:top-6 lg:self-start">
          <ul className="-mx-1 flex gap-1.5 overflow-x-auto pb-1 lg:mx-0 lg:block lg:space-y-0.5 lg:overflow-visible">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              return (
                <li key={s.id} className="shrink-0">
                  <a href={`#${s.id}`} className="flex min-h-9 items-center gap-2 whitespace-nowrap rounded-full border border-rule px-3 text-[13px] text-ink-2 hover:border-accent/50 hover:text-ink lg:rounded-[10px] lg:border-0 lg:px-2.5 lg:text-[14px] lg:hover:bg-paper-hover">
                    <Icon size={15} strokeWidth={1.9} aria-hidden className="hidden text-ink-3 lg:block" />
                    {s.title}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="grid min-w-0 gap-5">
          <Section id="idea">
            <p>
              Every kind of spending has a <B>bucket</B>: Groceries, Gas, Mortgage, Eating Out. Each bucket gets a <B>monthly goal</B>, the amount you plan to spend in it this month. As you spend, the bucket&rsquo;s bar drains. That&rsquo;s the whole budget: look at a
              bar and you know how much is left.
            </p>
            <p>
              Money you want to keep goes into <B>savings buckets</B> (Taxes, Emergency Fund, House Renovations). Those don&rsquo;t refill every month. You add money to them when you have it, and the balance builds up.
            </p>
            <p>
              The bank accounts sync on their own, and every purchase lands in the <B>Transactions</B> tab, where you (or Big Bucks&rsquo; suggestion) put it in a bucket.
            </p>
          </Section>

          <Section id="budget">
            <p>
              The top card shows <B>Left to spend this month</B>: all your monthly goals added up, minus what&rsquo;s been spent from them. The pace line tells you if you&rsquo;re spending faster than the month is going by.
            </p>
            <p>Each bucket below has a bar:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <B>Full color</B>: money left. It drains as you spend.
              </li>
              <li>
                <B>Orange</B>: almost empty (85% or more spent).
              </li>
              <li>
                <B>Red</B>: overspent. The red part shows how far over you went.
              </li>
            </ul>
            <p>
              <B>Tap any bucket</B> to open its drawer: change the monthly goal, turn on <B>Overflow</B>, see this month&rsquo;s transactions, and edit the bucket itself (name, icon, group, merge, hide).
            </p>
            <p>
              <B>Overflow</B> (for example on spending money, Gifts, Trash and Car Expenses): whatever is left at the end of the month is added to next month&rsquo;s goal. Overspending doesn&rsquo;t carry. Buckets without Overflow start fresh every
              month, and their leftover counts as Ready to save.
            </p>
            <p>
              Use <K>←</K> <K>→</K> or the arrows at the top to look at other months.
            </p>
          </Section>

          <Section id="income">
            <p>
              Paychecks and other money coming in are put in the <B>Income</B> bucket. You don&rsquo;t have to do anything with income: it lands in your checking account, and the monthly buckets spend out of it.
            </p>
            <p>
              Your monthly goals are a <B>plan</B>, not money moved anywhere. They don&rsquo;t wait for a paycheck. As long as more comes in than your goals add up to, the extra builds up as <B>Ready to save</B> (next section).
            </p>
            <p>
              To send part of a paycheck straight into savings, <B>split</B> it: tap its bucket in Transactions, choose <B>Split between buckets…</B>, and put some in Income and some in, say, Taxes. The Taxes part goes into that savings bucket. Most of the time
              it&rsquo;s simpler to leave the whole paycheck in Income and use <B>+ Add</B> on the Savings card.
            </p>
          </Section>

          <Section id="savings">
            <p>
              <B>Savings buckets</B> hold money you&rsquo;re keeping, and their balance carries over every month. Spending from one (paying the property tax from Taxes) takes money out of it.
            </p>
            <p>
              <B>Ready to save</B> is the money in your bank accounts that isn&rsquo;t in any bucket yet. It&rsquo;s what you can safely move into savings. Big Bucks works it out from your real balances:
            </p>
            {ready ? (
              <div className="rounded-[14px] border border-rule bg-paper-sunken/60 p-4" data-testid="guide-ready">
                <dl className="num grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1.5 text-[14.5px]">
                  <dt>Cash in your budget accounts (checking + savings − credit cards)</dt>
                  <dd className="text-right font-semibold text-ink">{dollars(ready.cash)}</dd>
                  <dt>− still left in this month&rsquo;s buckets</dt>
                  <dd className="text-right font-semibold text-ink">{dollars(ready.inBuckets)}</dd>
                  <dt>− already in savings buckets</dt>
                  <dd className="text-right font-semibold text-ink">{dollars(ready.inSavings)}</dd>
                  <dt className="border-t border-rule pt-1.5 font-semibold text-ink">= Ready to save right now</dt>
                  <dd className={`border-t border-rule pt-1.5 text-right text-[17px] font-semibold ${ready.amount < 0n ? "text-warn" : "text-accent"}`}>{dollars(ready.amount)}</dd>
                </dl>
              </div>
            ) : null}
            <Steps
              items={[
                <>
                  On the Budget page, find the <B>Savings</B> card.
                </>,
                <>
                  Tap <B>+ Add</B> on a savings bucket, type an amount (or tap $100, $250, $500 or $1,000) and press Enter.
                </>,
                <>
                  Ready to save drops by that much and the bucket&rsquo;s balance goes up. Nothing moves at the bank. It&rsquo;s a label on money you already have.
                </>,
                <>
                  If you add more than Ready to save, you&rsquo;ll get an orange warning and an <B>Add anyway</B> button.
                </>,
                <>
                  Use <B>Take out</B> to move money back, for example when you decide to spend it.
                </>,
              ]}
            />
            <p>
              Tap a savings bucket to set an optional <B>target</B> (like $15,000 for renovations). It then shows a progress bar.
            </p>
            <p>
              Savings never count toward Left to spend. Unspent money from buckets without Overflow becomes Ready to save at the start of the next month.
            </p>
          </Section>

          <Section id="transactions">
            <p>Every purchase from the bank shows up here. The ones that need a look are at the top with a suggested bucket.</p>
            <Steps
              items={[
                <>
                  Press <K>Enter</K> (or tap the tick next to it) to accept it. Tap the bucket itself to pick a different one, any time, even after it is approved. On the Budget page, open a bucket and tap a transaction to move it.
                </>,
                <>
                  Or start typing a bucket name (<K>g</K> <K>r</K> <K>o</K> then <K>Enter</K> for Groceries), or press <K>1</K> <K>2</K> <K>3</K> to pick a suggestion.
                </>,
                <>
                  <K>⇧</K> + <K>Enter</K> applies it to every transaction from that store. Do the same store twice and Big Bucks learns the rule.
                </>,
              ]}
            />
            <p>
              Other keys: <K>s</K> split, <K>t</K> mark as a transfer, <K>e</K> edit, <K>u</K> undo, <K>/</K> search, <K>?</K> the full list. On a phone, tap the bucket chip instead.
            </p>
            <p>
              <B>Splits</B>: choose <B>Split between buckets…</B> at the bottom of the bucket picker to divide one transaction (a Costco run, a paycheck) across several buckets.
            </p>
          </Section>

          <Section id="reflect">
            <p>Reflect looks back. Pick a month with the arrows.</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <B>At a glance</B>: what you spent, what came in, and what you kept, compared with your usual month.
              </li>
              <li>
                <B>Where it went</B>: a ring chart of spending by bucket. Tap a slice or a row to see that bucket&rsquo;s history.
              </li>
              <li>
                <B>Every month</B>: twelve months of spending, with a line for what came in. Tap a month to open it. A one-off month (like a big purchase) is drawn cut off so the others stay readable.
              </li>
              <li>
                <B>Bucket history</B>: any bucket over twelve months against its goal, with the average and highest month.
              </li>
            </ul>
            <p>Reflect counts spending the same way the Budget page does, so money moved into savings or retirement through a bucket counts as spent there too.</p>
          </Section>

          <Section id="edit">
            <p>
              <B>From the Budget page</B>: tap a bucket and use <B>Edit</B> at the top of its drawer to rename it, change its icon, move it to another group, make it a savings bucket, hide it, or merge it into another bucket.
            </p>
            <p>
              <B>Settings → Buckets</B> does the same for many buckets at once, and is where you add new buckets and groups and change their order.
            </p>
            <p>
              <B>Merge</B> moves every past transaction into the other bucket and removes this one. Use it instead of deleting. It can&rsquo;t be undone. <B>Hide</B> just takes a bucket off the Budget page; you can bring it back in Settings → Buckets.
            </p>
          </Section>

          <Section id="settings">
            <p>
              Open Settings from your picture (top right on a phone, bottom left on a computer). On a phone, <B>Done</B> takes you back to where you were. On a computer, use <B>Back to …</B> at the top of the settings list.
            </p>
            <p>
              Banks sync through SimpleFIN about four times a day (around 5am, 11am, 5pm and 11pm). Pending charges don&rsquo;t come through; a purchase shows up once it posts, usually in 1&ndash;3 days.
            </p>
            <p>Each person picks their own color in Settings; gold is the default. The theme (dark or light) is there and in the picture menu.</p>
          </Section>

          <Section id="faq">
            <Q q="Can I just add a million dollars to savings?">
              You can type it, but you&rsquo;ll get a warning, because it&rsquo;s more than Ready to save. Savings buckets only label money you actually have. Ready to save is worked out from your real bank balances, so it can&rsquo;t promise money that isn&rsquo;t there.
            </Q>
            <Q q="What happens at the end of a month?">
              Every bucket refills to its goal. Overflow buckets add their leftover to the new goal. Leftover in the other buckets becomes Ready to save. Savings buckets keep their balance.
            </Q>
            <Q q="What about yearly bills?">Give the bucket a monthly goal of the yearly amount divided by 12 and turn on Overflow so it builds up. Or make it a savings bucket and add to it when you can.</Q>
            <Q q="A purchase is missing.">It&rsquo;s probably still pending at the bank. It will show after it posts and the next sync runs.</Q>
            <Q q="Ready to save is negative.">Your buckets hold more than your accounts have right now (common just before a paycheck, or after a big card bill). Take some money out of a savings bucket, or wait for the next paycheck.</Q>
          </Section>

          <p className="text-center text-[13px] text-ink-3">
            Something not covered here? Open <Link href="/settings" className="text-accent hover:underline">Settings</Link> or ask whoever set it up.
          </p>
        </div>
      </div>
    </div>
  );
}
