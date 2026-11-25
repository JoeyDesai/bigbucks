# Homebase — Household Finance App (YNAB Replacement)

**Build spec for Claude Code** · v1.0 · 2026-10-22

> Working name is "Homebase"; rename freely. This document is the single source of truth for the build. Claude Code should read it top to bottom before writing code, then work phase by phase (§14). Anything marked **[VERIFY]** was researched but not confirmed against a live account. Confirm it before depending on it.

---

## 0. TL;DR

A self-hosted, installable web app (PWA) for one household (here, Alex and Sam). It:

1. **Replaces YNAB**, using the same envelope budgeting rules. Every dollar gets a job, there are credit-card payment categories and targets, and it has auto-assign and Age of Money. The full YNAB history is imported, so nothing starts from zero.
2. **Pulls in every account automatically.** Bank checking and savings, credit cards, brokerage and 401k accounts (through SimpleFIN Bridge), the business bank (Mercury), Coinbase, River, the mortgage, a home value estimate, and Gusto payroll (optional).
3. **Categorizes transactions automatically.** It layers rules, learned history and Claude, uses web lookup for unknown merchants, and keeps a review queue for anything it isn't sure about.
4. **Shows the whole financial picture.** Net worth, investments, crypto, house equity, and monthly growth.
5. **Has an AI agent chat with voice.** You can ask it questions, have it run reports and draw charts, and have it recategorize transactions. Any change it makes needs a confirmation first.

It runs on a home server (a Mac running OrbStack) and opens no inbound port. As specified here it is reachable only from household devices over Tailscale; the household's own instance later added an outbound-only Cloudflare Tunnel in front of the app's own sign-in, and a public demo on made-up data (docs/decisions.md, 2026-10-27 and 2026-10-28).

---

## 1. Goals and non-goals

### Goals
- Budget math that matches YNAB to the exact milliunit, proven by tests against a real YNAB history (§6.9).
- Phone-first UI that installs to the iPhone home screen and feels like an app.
- No more than one tap per transaction in the normal flow. Most transactions should arrive already categorized and approved.
- One place for net worth: cash, credit, investments, retirement, crypto, home, mortgage.
- An AI assistant that knows the household's categories, history and goals.
- Low running cost. Target under $10/month total (SimpleFIN $15/yr, plus Claude API usage, plus $0 for the rest).

### Non-goals (v1)
- No multi-household or SaaS use. This is one household on one server.
- No paying bills or moving money. The app is **read-only toward every financial institution**. No connector may write to a bank, broker, payroll or YNAB.
- No full tax or accounting software. The business's books stay in its own bank, payroll and accounting tools; this app only shows them.
- No native iOS app. A PWA is enough.

---

## 2. Users and access

| User | Role | Notes |
|---|---|---|
| Alex | Admin | Manages connections, API keys and settings |
| Sam | Member | Full budgeting, chat, categories, targets, rules, payees, household memory; no access to admin-only Settings (Connections, Users, AI, Backups) |

- **Network:** only devices on the household tailnet can reach the app (§4.3). No Tailscale Funnel, no port forwarding. (Later addition: an outbound-only Cloudflare Tunnel to the app's own sign-in; see docs/decisions.md.)
- **Identity:** use the `Tailscale-User-Login` header that Tailscale Serve injects to identify the user with no password. If the header is missing, fall back to a 6-digit PIN per user (stored as an argon2 hash) and a 30-day session cookie. After 5 wrong PINs, lock that user out for 15 minutes and rate-limit attempts per IP.
- **Header trust:** Next.js must listen on the dedicated loopback alias **127.0.0.2:3000 only** (it shares the tailscale container's network namespace; not 127.0.0.1, because tailscaled's userspace netstack forwards raw tailnet TCP on any port to 127.0.0.1 and would bypass Serve). The sidecar runs in kernel networking mode. Trust `Tailscale-*` headers only when the request arrived through Serve, i.e. only when the app is bound to that alias (`HOMEBASE_LISTEN_HOST`). Otherwise, middleware strips them. **[VERIFY]** that the header still arrives once the server node is tagged (§4.3). If it doesn't, use the PIN only.
- **Write permissions:** both users can budget and categorize. Only the admin can see or change Connections, Users, AI settings and Backups.

---

## 3. Alex's to-do list before the build (accounts and keys)

Claude Code can build Phases 0–2 (§14) with **only the YNAB token and the Tailscale auth key** (#1, #10). The rest are needed by the phase noted.

| # | Item | Needed by | How |
|---|---|---|---|
| 1 | **YNAB personal access token** | Phase 1 | YNAB → Account Settings → Developer Settings → New Token. Used **read-only** for migration. |
| 2 | **Anthropic API key** in a dedicated workspace with a monthly spend limit (e.g. $15) | Phase 4 | Claude Console → Workspaces → create "homebase" → set spend limit → create key scoped to that workspace. The Default workspace can't have a spend limit, so don't use it. |
| 3 | **SimpleFIN Bridge account** ($15/yr) and a setup token | Phase 3 | beta-bridge.simplefin.org → subscribe → connect each bank → "New app connection" → copy the setup token (it works once). |
| 4 | Connect each bank, card issuer and brokerage in SimpleFIN | Phase 3 | If a workplace 401k has its own login at the brokerage, **link it to the main brokerage login first** so one connection covers both. Plan-only logins often fail through aggregators. |
| 5 | Check SimpleFIN's institution search for **the crypto exchanges and the mortgage servicer** | Phase 6 | beta-bridge.simplefin.org/search-institutions. Whatever isn't supported uses the fallbacks in §7. |
| 6 | **Mercury read-only API token** | Phase 6 | Mercury → Settings → Tokens → "Read Only". This type needs no IP whitelist. Unused tokens get deleted, but the daily sync keeps it alive. |
| 7 | **Coinbase CDP API key**, view permission only, **ECDSA (ES256)** | Phase 6 | CDP portal → API keys → Secret API key → algorithm **ECDSA**, not Ed25519 → permission **View** only. |
| 8 | **RentCast API key** (free Developer plan, 50 calls/mo) | Phase 6 | rentcast.io/api |
| 9 | **Mortgage terms**: servicer, original principal, rate, term, first payment date, P&I payment, escrow | Phase 6 | From the closing disclosure. |
| 10 | **Tailscale auth key** (reusable, tagged `tag:homebase`) and Tailscale on each member's phone | Phase 0 | Tailscale admin console. |
| 11 | *(Optional)* Gusto CLI login | Phase 8 | See §7.8. |
| 12 | *(Optional)* River account activity CSV and/or a BTC xpub, if any coins are held in self-custody | Phase 6 | river.com (web only) → Account activity → Download CSV. |

Alex creates every token himself; Claude Code can open the right page in Chrome and walk him through it (§4.5). Before the app exists, secrets go into `.env` on the server (gitignored, `chmod 600`). After Phase 0 they go in through the **Settings → Connections** page (§12.6) and are stored encrypted. Never put them in the repo or in chat.

---

## 4. Architecture

### 4.1 Runtime topology (single host)

```
iPhone/Mac (Tailscale) ──HTTPS──▶ tailscale sidecar (Serve, tailnet-only, *.ts.net cert)
                                      │ network_mode: service:tailscale
                                      ▼
                               web  (Next.js 16, UI + API + agent endpoint) :3000
                               worker (Node, pg-boss jobs: sync, categorize, snapshots, digests)
                               postgres 18  (volume: pgdata)
                               backup (pg_dump nightly → ./backups, 30-day rotation)
Host macOS (outside Docker):   whisper.cpp server (Metal) :8178  ← speech-to-text
                               reached from containers at host.docker.internal / host.internal
```

- Everything except whisper runs in one `docker-compose.yml` under OrbStack.
- whisper.cpp runs **natively** because Docker on macOS can't use the Mac's GPU (Metal). Install it with Homebrew and run it as a `launchd` service. Claude Code should write the plist and an install script.
- Only the tailscale container publishes anything, and only to the tailnet. Postgres binds to the compose network only.

### 4.2 Tech stack (pin these)

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict), Node 24 LTS | |
| Repo | pnpm workspaces monorepo | `apps/web`, `apps/worker`, `packages/{db,engine,connectors,categorizer,ai,shared}` |
| Web | Next.js 16 (App Router), React, Tailwind, shadcn/ui | Server actions for mutations; route handlers for the agent's SSE stream |
| PWA | Serwist (service worker), web manifest, apple-touch-icon | Cache the app shell only; Postgres is the only real data store |
| DB | Postgres 18 + Drizzle ORM 0.45.x | Migrations through drizzle-kit, committed to the repo |
| Jobs | pg-boss 10 | Cron, retries and a single-instance lock, with no Redis |
| Charts | Recharts (standard charts), ECharts (sankey and cash-flow) | |
| AI | `@anthropic-ai/sdk` (Messages API, tool runner, structured outputs, Batches) | No Agent SDK needed; the app runs its own tool loop |
| Validation | Zod everywhere (env, API, AI outputs) | |
| Tests | Vitest (unit and golden tests), Playwright (e2e at iPhone viewport) | |
| Money | **`bigint` milliunits** ($1.00 = 1000) | Same as YNAB's API. Never floats. Format only for display. |

### 4.3 Network and TLS: Tailscale Serve

- Sidecar `tailscale/tailscale` with `TS_AUTHKEY`, `TS_HOSTNAME=homebase` (pick a name that reveals nothing, because cert names show up in public certificate-transparency logs), `TS_STATE_DIR=/var/lib/tailscale` on a volume, `TS_SERVE_CONFIG=/config/serve.json` (mount the directory, not the file), and `TS_EXTRA_ARGS=--advertise-tags=tag:homebase`.
- Kernel networking (`TS_USERSPACE=false`, `/dev/net/tun`, `NET_ADMIN`/`NET_RAW`), not userspace (see docs/decisions.md, "Security review fixes").
- `serve.json` proxies `${TS_CERT_DOMAIN}:443` → `http://127.0.0.2:3000` with `AllowFunnel: false`. **[VERIFY]** the exact JSON shape by running `tailscale serve --bg 3000` once, then `tailscale serve status --json`.
- **Tailnet policy: add, don't replace.** The tailnet may already serve other things (other services on the same server, for instance), so **don't** switch off an existing allow-all policy wholesale. That would cut off those services. Instead:
  - Add `tag:homebase` (owner: the admin) and `group:household` (the household members).
  - Add a grant `group:household → tag:homebase : tcp:443`.
  - Narrow the allow-all's destination from `*` to `autogroup:member` (plus any other tags in use), so it no longer covers `tag:homebase`. Grants only add up, so without this the allow-all still opens every port on the node. Every user-owned device keeps exactly the access it has today. `tag:homebase` then accepts only tcp:443 from `group:household` (docs/server-setup.md step 5a).
  - Locking the tailnet down further is a separate decision for later (§16).
  - **Show the owner the exact policy diff and get an OK before saving it** (§4.5).
- **Before another member joins:** with a permissive policy, they'd also reach every other service on the tailnet. Decide on that first, or share only the Homebase node with them through Tailscale's node sharing (§16).
- Result: a real HTTPS certificate at `https://homebase.<tailnet>.ts.net`. That's required for the PWA install, the service worker, microphone access and Web Push. It works at home and away, with no setup on the phones beyond Tailscale.
- **Alternative (documented, not default):** LAN-only, using Caddy's internal certificate authority. The root cert has to be installed and fully trusted on every iPhone, it doesn't work away from home, and the app needs its own login. Only switch to this if the owner decides the tailnet doesn't count as "local only" (§16).

### 4.5 Home server bootstrap (start of Phase 0) and guardrails

Claude Code runs on the dev machine and drives the server (a Mac) over SSH. The owner is signed in to YNAB and the Tailscale admin console in a browser on the dev machine, so Claude Code may use it to **read** those sites.

**Steps:**
1. **Reach the server.**
   - Find it on the LAN (Bonjour `*.local`, `arp -a`, or ask the owner for its hostname and username).
   - Confirm SSH works (System Settings → General → Sharing → Remote Login must be on; the owner may have to turn it on at the server).
   - Set up key-based SSH from the dev machine. Never store a password.
2. **Inventory, read only, and report to the owner before changing anything:**
   - macOS version, free disk, power settings (`pmset -g`)
   - OrbStack/Docker status and the containers running now
   - whether Tailscale is installed (`tailscale status`, `tailscale whois`), and which account and tailnet it's on
   - what else already runs on it (other containers and self-hosted services)
3. **Tailscale on the server.** The goal is for the server to be on **the household's tailnet** (the account signed in to the admin console).
   - If it's on a different account, **stop and ask first**. Switching accounts changes the server's tailnet IP and name, which can break access to other services on it. Show what will move and which devices are on each tailnet.
   - Once the owner approves:
     - Install or sign in (Homebrew `tailscale` or the Mac app; on a headless Mac, `tailscale up` with an auth key the owner creates in the admin console, §3).
     - Turn on MagicDNS and HTTPS certificates in the admin console's DNS page if they're off.
4. **Keep the server awake and recovering on its own:**
   - `sudo pmset -a sleep 0 disksleep 0 autorestart 1` (and `womp 1`)
   - OrbStack set to start at login
   - automatic login for the server user, or Docker started at boot
   - **Ask before running anything with sudo.**
5. Then continue Phase 0: compose stack, Tailscale sidecar with Serve, the backup job, and the PWA shell.

**Guardrails: Claude Code must ask the owner first before any of these:**
- changing the Tailscale ACL or policy file
- signing a device out of Tailscale or switching its account
- removing or approving devices
- any `sudo` on the server
- changing macOS power or sharing settings
- stopping or modifying **existing** containers (other self-hosted services)
- installing anything other than Homebrew packages and Docker images named in this spec
- deleting files outside the Homebase project directory

**Never:**
- click, edit or approve anything in the YNAB web app. Browser use is read-only; data comes through the API.
- create, enter or rotate credentials in a web form on the owner's behalf. The owner creates every token (§3) and pastes it into the server's `.env`, or the Settings page once it exists.
- paste secrets into chat or commit them.

### 4.6 Secrets and security
- A master key comes from `HOMEBASE_MASTER_KEY` (a 32-byte base64 value in a Docker secret or a `.env` that's gitignored). Every connector credential in the DB is encrypted with AES-256-GCM under that key. Settings shows only the last 4 characters.
- The Anthropic key lives on the server only and never reaches the browser.
- **Every financial connector is read-only.** Add a test that fails if any connector module calls a non-GET HTTP method. The exception is SimpleFIN's one-time claim POST and Coinbase's JWT signing, which is local.
- **Master key backup:** losing `HOMEBASE_MASTER_KEY` makes every stored credential unreadable. Print a one-time recovery copy for Alex's password manager at first setup. The restore test (Phase 0) must restore both the DB and the key.
- Use a separate Postgres role `homebase_ro` (SELECT on reporting views only, `statement_timeout=5s`) for the AI's SQL tool. Run every AI query inside `BEGIN READ ONLY`, as well as the single-statement SELECT/WITH check.
- **LLM redaction:** before any text goes to Claude, mask runs of 4 or more digits in descriptions and memos (`1234` → `••••`), except amounts, which are sent as structured fields.
- **whisper.cpp** binds to 127.0.0.1 on the host. Containers reach it via OrbStack's `host.internal`, which forwards to the host's loopback **[VERIFY]**. It must never listen on the LAN.
- **Gusto CLI** runs only through a wrapper that allows `gusto api request` with GET on an explicit path list. Payroll write commands are blocked in code, not just by policy.
- Write an audit log row for every write the AI makes and every settings change.
- Backups: nightly `pg_dump -Fc`, keep 30 days. Include a documented, tested restore script. Any off-host copy **must be encrypted** (restic or age). Never write plain dumps to iCloud or Dropbox. Where it goes is Alex's call; see §16.
- Web Push: generate a VAPID key pair at first setup and store it encrypted. iOS delivers push only to the **installed** home-screen app, and only after the user taps to allow notifications.

---

## 5. Data model (Postgres, Drizzle)

All money is `bigint` milliunits. All IDs are `uuid` (v7). Every table gets `created_at` and `updated_at`. Dates are `date` and timestamps are `timestamptz`. Below is the logical model; Claude Code owns the exact DDL.

### 5.1 Core budgeting
- **users** `(id, tailscale_login unique null, display_name, role enum[admin,member], pin_hash null)`
- **entities** `(id, name)`, seeded with `Household` and the business (`Northwind Studio LLC` in the demo). Every account belongs to one entity. Default views show Household; the business is a filter or toggle.
- **accounts** `(id, entity_id, name, nickname, institution, kind enum[checking, savings, cash, credit_card, line_of_credit, brokerage, retirement, hsa, crypto, mortgage, loan, property, other], on_budget bool, closed bool, source enum[simplefin, mercury, coinbase, river_csv, xpub, rentcast, amortization, manual, ynab_import], connection_id null, external_id null, balance_sign enum[normal, inverted], sort, note, statement_due_day int null /* cards */, monthly_contribution_milli bigint null /* retirement, §7.5 */)`
  - On budget: checking, savings, cash, credit_card.
  - Tracking (off budget): everything else, plus **all business (Mercury) accounts**, so business cash never inflates household Ready to Assign.
- **balances** `(account_id, as_of date, current_milli, available_milli null, source)`, one row per account per day (upsert). This drives net worth history.
- **category_groups** `(id, name, sort, hidden)`
- **categories** `(id, group_id, name, sort, hidden, note, kind enum[normal, cc_payment, internal_rta, uncategorized], linked_account_id null)`. The emoji stays part of `name`, as in YNAB. There is one `uncategorized` system category, which receives transactions with no category (§6.1).
  - `cc_payment` categories are created automatically for each on-budget credit card and placed in a system group "Credit Card Payments".
  - `internal_rta` is the single "Inflow: Ready to Assign" pseudo-category.
- **targets** `(category_id, effective_from month /* pk with category_id; see §6.5 */, type enum[need_refill, need_set_aside, balance, balance_by_date, monthly_builder, debt, percent_of_income], amount_milli, cadence enum[none, weekly, monthly, yearly, every_n_months], cadence_every int, day int null, target_date date null, percent numeric null, snoozed_month date null, created_month date)`
  - `percent_of_income` is new, not in YNAB. It's for categories like Giving: X% of income received this month.
- **month_assignments** `(month date /* first of month */, category_id, assigned_milli)`, primary key `(month, category_id)`
- **month_notes** `(month, category_id null, note)`
- **payees** `(id, name, normalized_key unique, default_category_id null, transfer_account_id null, merchant jsonb /* {website, type, location, description, confidence, looked_up_at} */)`
- **payee_aliases** `(id, pattern text, match enum[exact, prefix, regex], payee_id)`, which maps raw bank strings to a clean payee.
- **transactions**:
  ```
  id, account_id, date, posted_at null, amount_milli (− outflow, + inflow),
  payee_id null, raw_description, memo,
  category_id null,                 -- null when split, transfer between on-budget accts, or uncategorized
  is_split bool,
  transfer_account_id null, transfer_pair_id null,
  cleared enum[pending, uncleared, cleared, reconciled],
  approved bool, flag enum null,
  source enum[...], external_id null, import_hash,   -- unique(account_id, external_id)
  matched_ynab_id null,
  catz jsonb  /* {method: rule|history|ai|ai_web|user|ynab, confidence 0..1, model, rule_id, explanation, at} */,
  deleted_at null
  ```
- **transaction_splits** `(id, transaction_id, amount_milli, category_id null, payee_id null, memo, transfer_account_id null)`. Lines must add up to the parent amount (enforced in the app, plus a deferred constraint trigger).
- **scheduled_transactions** `(id, account_id, payee_id, category_id null, transfer_account_id null, is_split bool /* lines in scheduled_transaction_splits, same shape as transaction_splits */, amount_milli, frequency enum[once, daily, weekly, biweekly, twice_monthly, every_4_weeks, monthly, every_other_month, every_3_months, every_4_months, twice_yearly, yearly, every_other_year], next_date, memo, end_date null)`
- **reconciliations** `(id, account_id, at, statement_balance_milli, adjustment_tx_id null)`
- **budget_operations** `(id, at, user_id, kind enum[assign, move, auto_assign, reset, target_edit, …], month, payload jsonb, inverse jsonb, undone_at null)`. This is the undo/redo stack and the "Recent Moves" list.
- **budget_month_cache** `(engine_version, month, category_id, assigned, activity, available, carry_in, cash_overspend, credit_overspend, needed, underfunded)`, plus `budget_month_summary` `(engine_version, month, rta, assigned_future, cost_to_be_me, age_of_money)`.

### 5.2 Categorization
- **rules** `(id, priority, enabled, source enum[user, learned, ai_suggested], conditions jsonb, actions jsonb, hit_count, last_hit_at)`
  - Conditions: payee/raw_description equals, contains or regex; amount equals or range; account in; day-of-month range.
  - Actions: set payee, set category, set memo, apply split template (percent or fixed lines), mark as transfer to account, auto-approve.
- **categorization_events** `(id, transaction_id, suggested_category_id, final_category_id, method, confidence, model, input_tokens, output_tokens, cost_usd, accepted bool, at)`. This is the learning log.

### 5.3 Wealth
- **holdings** `(account_id, as_of date, symbol, name, quantity numeric(28,10), price numeric, market_value_milli, cost_basis_milli null, lot_key null)`. Daily snapshot; sum lots per symbol in views.
- **assets** `(id, kind enum[home], name, address, purchase_price_milli, purchase_date, account_id /* kind=property */)`
- **asset_valuations** `(asset_id, as_of, value_milli, low_milli, high_milli, source enum[rentcast, manual])`
- **loans** `(account_id pk, servicer, original_principal_milli, annual_rate numeric, term_months, first_payment_date, pi_payment_milli, escrow_milli)`
- **loan_events** `(id, account_id, date, kind enum[extra_principal, recast, rate_change, statement_balance], amount_milli null, new_payment_milli null, new_rate null)`
- **payroll_runs** (Gusto, optional) `(id, external_id, check_date, gross_milli, employee_taxes_milli, employer_taxes_milli, deductions jsonb, net_milli, matched_transaction_id null)`

### 5.4 Ops and AI
- **connections** `(id, provider, label, enc_credentials bytea, status enum[ok, needs_attention, error, disabled], last_success_at, last_error, meta jsonb)`
- **sync_runs** `(id, connection_id, started_at, finished_at, status, requests_used, accounts_seen, tx_added, tx_updated, errors jsonb)`
- **raw_payloads** `(id, sync_run_id, provider, fetched_at, body jsonb)`, purged after 14 days.
- **ai_conversations**, **ai_messages** `(role, content jsonb, tokens, cost)`, **ai_tool_calls** `(name, input, output_summary, status enum[auto, awaiting_confirmation, confirmed, rejected], confirmed_by)`
- **ai_usage** `(at, purpose enum[chat, categorize, batch_categorize, merchant_lookup, digest, report], model, input_tokens, output_tokens, cache_read_tokens, web_searches, cost_usd)`
- **household_memory** `(id, text, created_by)`. Plain facts the agent can read and the users can edit, e.g. "Paychecks land on the 25th", "Costco runs are mostly groceries".
- **saved_reports** `(id, name, spec jsonb, pinned bool)`
- **push_subscriptions** `(user_id, endpoint, keys jsonb)`
- **audit_log** `(at, user_id null, actor enum[user, ai, system], confirmed_by null, action, entity, entity_id, before jsonb, after jsonb)`
- **settings** (key/value jsonb)

### 5.5 Reporting views (the AI's SQL tool can read only these)
`v_transactions_flat` (splits expanded to one row per line, with group/category/payee/account/entity names), `v_month_category` (engine output, §6), `v_net_worth_daily`, `v_holdings_latest`, `v_cashflow_monthly`, `v_payee_spend_monthly`.

---

## 6. Budget engine (YNAB-equivalent)

A pure, deterministic TypeScript module, `packages/engine`, with no DB access. Input is a snapshot (accounts, categories, transactions with splits, assignments, targets, scheduled transactions). Output is a per-month, per-category table plus the Ready to Assign figures for each month. The DB layer caches results in `budget_month_cache` and recomputes from the earliest month that changed. Cache keys carry a version, so engine changes invalidate them.

### 6.1 Definitions
- Each **budget month** runs from the 1st to the last day of the month, in local time (America/New_York).
- **Activity(c, M)** = the sum of transaction and split amounts in category c dated in M, from on-budget accounts plus categorized transfers to tracking accounts. Uncategorized transfers between two on-budget accounts are excluded, and so are pending transactions (`cleared='pending'` is display-only until posted).
- **Transaction date** = SimpleFIN `transacted_at` if present, otherwise `posted`, converted to America/New_York. Imported YNAB transactions keep YNAB's date.
- **Activity of a payment category P(K)** = (+ funded card spending moved in, §6.4) + (− payments to the card) + (− anything categorized directly to P(K), e.g. interest). This matches how YNAB reports `activity` for payment categories.
- **Available(c, M)** = Carry(c, M−1) + Assigned(c, M) + Activity(c, M), the same formula for **every** category, including payment categories.
- **Carry(c, M−1)** = max(Available(c, M−1), 0). A negative balance does not roll over: cash overspending is charged to Ready to Assign (§6.3) and credit overspending turns into card debt (§6.4). **[VERIFY]** Treat a negative payment-category balance (paid more than was set aside) the same way, as cash overspending. Let the fixtures decide.
- **Uncategorized** non-transfer transactions go to the `uncategorized` system category and overspend like a normal category. In YNAB this shows as negative "Uncategorized Transactions" available (in the demo data, −$426.50 in Oct 2026).
- **Starting balances:** a cash account's starting balance → RTA. A credit card's starting balance (existing debt) is uncategorized, does not move money, and makes P(K) underfunded. **[VERIFY]** against fixtures.

### 6.2 Ready to Assign (RTA)
For month M:
```
RTA(M) = RTA_carry(M−1)
       + Σ inflows in M categorized to internal_rta (cash accounts; also card inflows that are categorized RTA)
       − CashOverspend(M−1)
       − Σ Assigned(*, M)
```
- In the UI, RTA is shown as of the future-most month that has assignments: subtract assignments made in future months from the current month's figure ("Assigned in Future Months"), like YNAB's "assign ahead".
- If RTA is negative, show it in red. **[VERIFY]** whether a negative RTA carries into the next month. Sources conflict, so let the golden parity tests (§6.9) decide and record the outcome in `docs/decisions.md`.
- Reconciliation adjustments on cash accounts go to internal_rta. On credit cards they go to the card's payment category.
- Starting balances of new cash accounts go to internal_rta.

### 6.3 Overspending
- **Cash overspending** happens when a category's Available is below 0 at month end and the negative amount came from cash-account activity. That amount is subtracted from the next month's RTA. Show it red.
- **Credit overspending** is the part of the negative that came from card purchases. It is not subtracted from RTA. It stays as debt on the card, and the card's payment category shows as underfunded. Show it yellow.
- When a category has both kinds, attribute in transaction order: card spending is funded first up to the Available at that moment, and whatever goes negative is attributed to whichever kind of transaction pushed it negative. Show mixed overspending red (YNAB's rule).

### 6.4 Credit card payment categories (the hard part — build it test-first)
For each on-budget card K with payment category P(K):
1. **Card purchase** of amount A (outflow) in category c in month M: the purchase lowers c's Available through its Activity, as usual. Separately, **add** to P(K)'s Activity the *funded portion* F = min(A, max(Funds(c) remaining, 0)). Nothing extra is subtracted from c.
   - Funds(c) for month M = Carry(c, M−1) + **the full month's Assigned(c, M)**, regardless of when in the month it was assigned. Assigning later in the month retroactively funds earlier card spending, as in YNAB.
   - Track Funds(c) as each of c's outflows in M consumes it, processed in date order. Tie-break by YNAB's transaction order for imported data, then by `(date, import order, id)`.
   - Cash outflows in c consume Funds(c) too, in the same ordered pass.
2. **Card refund or return** (inflow) categorized to c: **subtract** the full refund amount from P(K)'s Activity (money moves back from the payment category to c). **[VERIFY]** the case where a refund is larger than the funded portion, against fixtures.
3. **Payment to the card** (transfer from cash to K): P(K) Available decreases by the payment amount. Prefill the suggested payment as min(P(K) Available, card cleared balance).
4. **Interest and fees** categorized to P(K) directly: no move. The user assigns money to P(K).
5. **Card debt that existed before tracking started**, and credit overspending: P(K) shows underfunded. The user assigns to P(K) to pay it down.
6. **Card with a positive (overpaid) balance**: purchases don't move money until the balance is negative again.
7. **Split transactions on a card**: apply rules 1–2 to each line separately.

### 6.5 Targets
For every type, compute **`needed(M)`**, the full amount the target asks to be assigned in month M, *before* subtracting anything assigned in M. Then:
- **underfunded = max(needed(M) − Assigned(c, M), 0)**
- **Cost to Be Me = Σ needed(M)**

Also compute `overall_left` and `pct_complete`.

| type | needed(M) |
|---|---|
| `need_set_aside` (Set aside another X every cadence) | Monthly: X. Weekly: X × the number of `day` weekdays in M. Yearly / every-N-months: (X − assigned in earlier months of the current period) ÷ months left in the period, including M. |
| `need_refill` (Refill up to X) | Monthly: max(X − Carry(c, M−1), 0). Weekly and yearly work the same way, scaled to the period. |
| `balance` (Have a balance of X, no date) | max(X − Carry(c, M−1), 0). This makes underfunded = max(X − Available-before-spending, 0). |
| `balance_by_date` | max(X − Carry(c, M−1), 0) ÷ months remaining until `target_date`, including M. |
| `monthly_builder` | X |
| `debt` | X (the monthly payment) |
| `percent_of_income` (new) | percent × the income basis for M. The basis is set per target: **net inflows to RTA in M** (default) or **gross pay from Gusto `payroll_runs`** (Phase 8). Recalculates as income arrives. |

- **Cadence mapping from YNAB:**

  | `goal_cadence` | meaning | `goal_cadence_frequency` |
  |---|---|---|
  | 0 | none | ignored |
  | 1 | monthly | every N months |
  | 2 | weekly | every N weeks; uses `goal_day` (0 = Sunday) |
  | 3–12 | every 2–11 months | ignored |
  | 13 | yearly | every N years |
  | 14 | every 2 years | ignored |

  **[VERIFY]** codes 3–12 and 14 against the OpenAPI spec descriptions.

- Snoozed targets count as 0 needed for that month.
- Store targets **with history**: add `effective_from month` to `targets`, making the primary key `(category_id, effective_from)`. Editing a target creates a new row from the current month forward, and past months keep using the target that applied then. YNAB's API only gives the *current* target, so imported targets get `effective_from = goal_creation_month`. That means parity checks on `goal_under_funded` are only valid for the **fixture snapshot month** (§6.9).
- **Upcoming scheduled transactions** in M add to a category's "needed" amount if they exceed its Available (YNAB's yellow upcoming alert).
- **Cost to Be Me** = Σ needed(M). The expected value comes from the fixture snapshot, not a screenshot.

### 6.6 Auto-Assign actions
They apply to the selected categories, or to all visible categories if none are selected:
- Underfunded (targets in group/category sort order, then upcoming scheduled transactions, then overspending)
- Assigned last month
- Spent last month
- Average assigned over the last 12 months (excluding the current month)
- Average spent over the last 12 months
- Reduce overfunding
- Reset available (send it back to RTA)
- Reset assigned

Every Auto-Assign is a single undoable operation, logged in audit_log with a "Recent Moves" style history.

### 6.7 Age of Money
Treat cash inflows as FIFO buckets. Each cash outflow consumes the oldest buckets first. Card payments count as outflows, which is how card spending enters AoM once paid. Transfers between two **cash** on-budget accounts and starting balances are excluded. AoM = the mean of (outflow date − bucket date) over the last 10 outflows. Hide it until there are 10 outflows. **[VERIFY]** against YNAB's displayed AoM; document any difference.

### 6.8 Other behaviors
- **Move money** between categories, or category ↔ RTA, as a single undoable operation.
- **Assign ahead** to future months.
- **Hidden categories** are excluded from views but still in the math.
- **Reconcile**: enter the bank's statement balance. If it differs from the cleared balance, create an adjustment transaction, then lock the cleared transactions as reconciled.
- **Scheduled transactions** are created by a daily job on their date as uncleared and unapproved. The job matches them to synced transactions (§8.4).

### 6.9 Golden parity tests (required acceptance gate)
Reference implementation for structure only: Actual Budget (MIT), `packages/loot-core/src/server/budget/envelope.ts` and `base.ts`. **Actual has no credit-card payment categories, so §6.4 is new code.**

Test steps:
1. Pull every month from the YNAB API: `GET /plans/{plan_id}/months/{month}`, which returns per category `budgeted`, `activity`, `balance`, `goal_*` fields, plus the month's `to_be_budgeted`. Save them as fixtures (gitignored, since they contain real data).
   - Capture the fixtures **and** the full `/plans/{id}` export at one point in time: record `server_knowledge`, and make no YNAB edits while capturing.
   - Include deleted categories and transactions (`deleted: true`), so history adds up.
2. Run the engine on the migrated data.
3. **Assert** that for every month and every category, assigned, activity and available match YNAB **exactly**, as does month-level RTA. Assert that `goal_under_funded` matches the engine's `underfunded` for target categories.
4. The test runner prints a diff table for any mismatch. Phase 1 isn't done until the diff is empty (or every remaining difference is explained and Alex approves it).

Also add synthetic unit tests for every rule in §6.2–6.7, especially the card-payment edge cases: partial funding, refunds, overpaid card, a split across two categories, and a payment larger than the payment category's balance.

---

## 7. Connectors (`packages/connectors`)

Every connector implements:
```ts
interface Connector {
  provider: Provider;
  test(creds): Promise<{ ok: boolean; message: string }>;
  listAccounts(creds): Promise<ExternalAccount[]>;               // id, name, kind guess, currency, balance, as_of
  fetchTransactions(creds, opts:{ accountIds?, since, until }): Promise<ExternalTxn[]>;
  fetchHoldings?(creds): Promise<ExternalHolding[]>;
}
```
- Connectors are pure HTTP clients plus a mapper; persistence happens in the sync service (§8).
- Record each provider's raw JSON in `sync_runs.errors` (errors only) and in an optional `raw_payloads` table kept 14 days, for debugging.
- **No connector may make a write request** (§4.6).

### 7.1 SimpleFIN Bridge (primary aggregator)
- **Covers:** the household's checking and savings, credit cards, brokerage and 401k, plus anything else SimpleFIN supports (possibly the mortgage and the crypto exchanges; check them, see §3 #5).
- **Claim (one time):**
  - base64-decode the setup token to get a claim URL, then `POST` with no body. The response body is an **Access URL** with basic-auth credentials embedded (`https://user:pass@host/simplefin`).
  - Store it encrypted. A 403 means the token was already claimed or was compromised; show that clearly.
- **Fetch:** `GET {access}/accounts?version=2&start-date=<epoch>&end-date=<epoch>[&pending=1][&account=<id>...][&balances-only=1]`
  - v2 response: `{ errlist[], connections[], accounts[] }`.
  - Account fields: `{ id, name, conn_id, currency, balance (string), available-balance?, balance-date (epoch), transactions[], holdings[] (undocumented), extra? }`.
  - Transaction fields: `{ id, posted (0 if pending), amount (string, + = deposit), description, transacted_at?, pending?, extra? }`.
  - Also accept v1 shapes (`errors`, `org`) defensively.
- **Errors:** each `errlist` item has `code` (`gen.*`, `con.*`, `act.*`) and `msg`, which is safe to show users.
  - `con.auth` → mark that connection `needs_attention` and show a banner: "Reconnect <institution> in SimpleFIN".
  - HTTP 402 → subscription lapsed. HTTP 403 → access revoked.
- **Limits (hard):**
  - About **24 requests/day** across all calls. Budget it at **≤ 6/day**: scheduled at 05:17, 11:17, 17:17, 23:17 local, plus a manual "Sync now" capped at 2/day.
  - Each request window is ≤ 90 days. Normal syncs request the last 14 days (the overlap catches late posts and edits).
  - The initial backfill goes back to **30 days before the day SimpleFIN sync is first turned on** (the "sync start", §10). Older history comes from the YNAB import. Use 90-day windows, and spread requests over 2–3 days if needed to stay under the quota.
- **Pending:** send `pending=1`. Store pending transactions as `cleared='pending'` (display only). When the posted version arrives, match it (§8.4) and replace the pending row. If pending is off, **leave the parameter out entirely**.
- **Signs:** for liabilities (credit cards, mortgage), SimpleFIN reports a positive balance meaning amount owed. Normalize to negative for liabilities, with a per-account `balance_sign` override in Settings.
- **Holdings:** if `holdings[]` is present, map `symbol`, `shares`, `market_value`, `cost_basis`. Holdings come back **one row per lot** (a 401k can show deferral and match as separate lots), so store each lot and sum per symbol in views. **Fidelity, Vanguard and Schwab send `cost_basis` as the position total, not per share.** Detect and normalize this. The format is undocumented, so wrap parsing in try/catch and degrade to balance-only.
- **Data freshness:** banks and MX refresh roughly once a day, and the timing is outside our control. Show "Last updated X ago" per account.

### 7.2 Mercury (direct API; business entity, tracking accounts)
- Base `https://api.mercury.com/api/v1`, header `Authorization: Bearer secret-token:<token>`, **read-only token**.
- `GET /accounts` → balances (`currentBalance`, `availableBalance`, `kind`, `type`).
- `GET /transactions?start=…&end=…&limit=1000` (all accounts), paginated via `page.nextPage`/`start_after`.
  - Useful fields: `counterpartyName`, `bankDescription`, `mercuryCategory`, `note`, `externalMemo`, `status`, `postedAt`.
  - Map statuses: pending → pending; sent → cleared; failed, cancelled and blocked → skip.
- Poll hourly 07:00–22:00. Webhooks are **not** used: the design has no public inbound endpoint.
- Accounts are created as `entity=business`, `on_budget=false`. Transfers from Mercury into household checking (payroll, owner distributions, reimbursements) are matched as transfers (§8.3), so they show up correctly on both sides. On the household side they're categorized to RTA.
- Rate limits: undocumented **[VERIFY]**. Back off on 429.

### 7.3 Coinbase (direct API)
- CDP Secret API key, **ES256** (ECDSA P-256), **view** scope.
- Sign a **new JWT for each request**:
  - Header: `{alg: ES256, kid: <key name>, nonce: random}`.
  - Claims: `{iss: "cdp", sub: <key name>, nbf: now, exp: now+120, uri: "GET api.coinbase.com/v2/accounts"}`.
  - Send as `Authorization: Bearer <jwt>`.
- `GET /v2/accounts` (paginated via `pagination.next_uri`) → per-asset wallets with `balance` and `native_balance`. Store as holdings on a single "Coinbase" crypto account.
- `GET /v2/accounts/:id/transactions` → buys, sells, sends, receives, staking. Used for history and cost basis display only. Crypto accounts are tracking accounts.
- Prices: use the `native_balance` USD value, refreshed daily at 23:00, plus on demand.
- Limit is 10k requests/hour per key, which is far above what's needed.
- If SimpleFIN supports Coinbase, still prefer this direct API: it has per-asset detail.

### 7.4 River (Bitcoin)
- River has **no public API and no MCP**. Options, best first:
  1. **SimpleFIN**, if River appears in its institution search (balance and possibly transactions).
  2. **CSV import:** River's web app → account activity CSV. Columns: Date (UTC), Reference Code, Transaction Type, Sent Amount/Currency, Received Amount/Currency, Fee Amount/Currency, Total Amount/Currency, Method, Source, Destination, Cost Basis, Cost Basis Currency, Bitcoin Price Amount/Currency, Transaction ID, Recurring, Tag. Build an importer with a column-mapping preview. Compute the BTC position, then value it daily using the BTC-USD spot price. The Coinbase public price endpoint is fine, unauthenticated, **[VERIFY]**.
  3. **Watch-only xpub** (for coins withdrawn to self-custody):
     - Derive receive and change addresses locally, with a gap limit of 20.
     - Query `https://mempool.space/api/address/:addr`: balance = `chain_stats.funded_txo_sum − chain_stats.spent_txo_sum`.
     - Throttle to 1 request/sec and cache. Only addresses leave the server, never the xpub.

### 7.5 Fidelity (brokerage + 401k)
- Primary source: SimpleFIN (§7.1), giving balances and holdings if provided.
- Fallback: **Positions CSV importer** (`Portfolio_Positions_*.csv`). Columns: Account Number, Account Name, Investment Type, Symbol, Description, Quantity, Last Price, …, Current Value, Cost Basis Total, Average Cost Basis, Type. Strip `$`, `,` and `%`, and ignore footer disclaimer lines.
- Retirement accounts are `kind=retirement`, tracking.
- **Contributions vs growth:** 401k contributions arrive through payroll, not as bank transactions. Compute monthly growth = Δ balance − known contributions. Known contributions come from Gusto deductions (§7.8) if available, or a manual "monthly contribution" setting per account. Label anything else as "market change + unknown contributions".

### 7.6 Home value (RentCast)
- `GET https://api.rentcast.io/v1/avm/value?address=<full address>` with header `X-Api-Key`. Optional: `propertyType`, `bedrooms`, `bathrooms`, `squareFootage`, `compCount`.
- Store `price`, `priceRangeLow`, `priceRangeHigh` in `asset_valuations`, and the comps JSON for the detail view.
- Schedule: once a month (2nd of the month, 09:00) plus a manual refresh. The free plan gives 50 calls/month; hard-cap the app at 5/month.
- Zillow and Redfin have no legitimate API; don't scrape them.
- The home is a `property` tracking account. Equity = home value − mortgage balance.

### 7.7 Mortgage
1. If the servicer is on SimpleFIN, use that balance (tracking, `kind=mortgage`, sign normalized).
2. Otherwise, or in addition, use the **amortization engine**:
   - Monthly rate r = annual/12. Payment = P·r/(1−(1+r)^−n).
   - Balance after k payments = P(1+r)^k − pmt·((1+r)^k − 1)/r.
   - Apply `loan_events` (extra principal, **recast** with new payment, statement-balance corrections). Escrow is tracked separately from P&I.
3. When both exist, show the synced balance and flag drift greater than $50 against the schedule.
4. Mortgage page:
   - Payoff date, interest paid to date, and a "what if" slider for extra principal and recast.
5. Link the "🏠 Mortgage" budget category's payment transaction to the loan account as a categorized transfer to a tracking account, so it counts as spending in the budget and lowers the loan balance.

### 7.8 Gusto (optional, Phase 8)
- Gusto offers **no single-company REST API**. The supported routes are the Gusto MCP server (`https://mcp.api.gusto.com`, OAuth plus dynamic client registration, admin only) and the **Gusto CLI** (beta, `gusto-cli`).
- Plan:
  - The worker shells out to the CLI with `--json`. It runs in its own container with `credentials.toml` on a volume, and authenticates once with `gusto auth login --no-browser`.
  - It uses `gusto api request` against `/v1/companies/{uuid}/payrolls` (processed payrolls) to fetch check date, gross, taxes, deductions (401k deferral, HSA) and net.
  - Results go in `payroll_runs`, matched to the payroll deposit in household checking (the bank memo names the employer, e.g. "ACME PAYROLL").
- **[VERIFY]** that the CLI's refresh tokens survive unattended runs. If not, Phase 8 becomes "Import payroll CSV/PDF" with an upload button and Claude extraction.
- Purpose: a gross-to-net breakdown per paycheck, a YTD taxes widget, and 401k contribution data for §7.5.

### 7.9 YNAB (migration only, read-only)
- Base `https://api.ynab.com/v1`, `Authorization: Bearer <PAT>`. **200 requests/hour.** Amounts are milliunits.
- "Budgets" were renamed to "**plans**" (Feb–Mar 2026). Use `/plans/{plan_id}/...`. Old `/budgets` paths still work but are undocumented.
- **GET only.** The client must refuse any other method.
- Endpoints:
  - `/plans` (choose the plan to import by name, `YNAB_PLAN_NAME`)
  - `/plans/{id}` (full export in one call)
  - `/accounts`, `/categories` (all `goal_*` fields), `/months` and `/months/{month}`, `/transactions`, `/scheduled_transactions`, `/payees`, `/payee_locations`
- Request `/plans/{id}` once (full), then use `last_knowledge_of_server` deltas during the parallel-run period (§10) to keep importing.

### 7.10 Generic importers
CSV/OFX/QFX import for any account, with a mapping UI (date, amount or outflow/inflow, payee, memo) and duplicate detection (§8.4). This covers anything an aggregator misses.

---

## 8. Sync pipeline (`apps/worker`)

### 8.1 Jobs (pg-boss, cron in America/New_York)
| Job | Schedule | Notes |
|---|---|---|
| `sync.simplefin` | 05:17, 11:17, 17:17, 23:17 | ≤6 requests/day incl. manual |
| `sync.mercury` | hourly :07, 07:00–22:00 | |
| `sync.coinbase` | daily 23:05 | |
| `sync.rentcast` | monthly, 2nd 09:00 | |
| `sync.gusto` | daily 06:00 (Phase 8) | |
| `categorize.pending` | after every sync | real-time path, §9.3 |
| `categorize.batch` | nightly 02:30 | Batch API path for backlog |
| `snapshot.networth` | daily 23:55 | writes `balances` for every account incl. computed mortgage/home/crypto |
| `scheduled.materialize` | daily 00:10 | |
| `digest.weekly` | Sun 18:00 | push + chat message, §11.6 |
| `backup.pgdump` | daily 03:30 | |
| `health.connections` | daily 08:00 | push if any connection `needs_attention` > 24h |

Each job is idempotent and holds a single-instance lock. Failures retry with exponential backoff (3x), then mark the connection as errored.

### 8.2 Ingest steps (per account, per run)
1. Upsert the account by `(connection_id, external_id)`. New accounts land in a "New accounts" inbox for Alex to choose name, kind, on/off budget and entity. **Nothing new is put on budget automatically.**
2. Upsert today's balance.
3. For each transaction: compute `import_hash = sha256(account_id|date|amount|normalized description)`.
   - Upsert by `(account_id, external_id)`.
   - If a posted transaction replaces a pending one, keep the user's edits (category, memo, splits).
4. Run payee normalization (§9.2), then transfer detection (§8.3), then categorization (§9.3).
5. New transactions are `approved=false` unless auto-approved (§9.4).

### 8.3 Transfer detection
Pair transactions across household and business accounts when all of these hold:
- the amounts are opposite and equal
- the dates are within 5 days
- the descriptions look like a transfer: "PAYMENT", "ONLINE TRANSFER", "MERCURY", "AUTOPAY", the card's name, or the card issuers' payment patterns

Then:
- **Card payments** (checking → card) are paired automatically.
- **Business bank (Mercury) → household checking** is paired, and the household side is categorized to RTA (income).
- Anything ambiguous is suggested in the review queue, never applied silently.

### 8.4 Matching and dedupe
- **Pending → posted:** same account, same amount (allowing ±20% for tips and gas holds), within 7 days, similar payee. If found, the posted row replaces the pending one.
- **Scheduled → synced:** same account, amount within ±$1 or exact, within ±4 days.
- **YNAB-imported → synced** (cutover period): same account, exact amount, within ±3 days, fuzzy payee. Link via `matched_ynab_id` and keep the YNAB category and memo.
- **CSV import:** skip exact `import_hash` hits, and flag near-duplicates.

---

## 9. Smart categorization (`packages/categorizer`)

Goal: at least 85% of new transactions arrive correctly categorized, and at least 60% arrive approved with no review needed (measured from `categorization_events`, shown in Settings → AI).

### 9.1 Pipeline (first match wins, but every step can add context)
1. **Transfer?** (§8.3) → transfer, no category.
2. **Rules**, in priority order (user rules before learned rules).
3. **History:** if the normalized payee has 3 or more past transactions and at least 90% of them used one category, use that category (confidence 0.9–0.98, scaled by count). If amount clusters differ by category (e.g. Costco < $60 = Gas, ≥ $60 = Groceries), learn amount-banded history.
4. **AI (real-time):** Claude Haiku 5.5 with structured output (§9.3).
5. **AI + web lookup:** for an unknown merchant (no merchant profile and AI confidence < 0.7), run Sonnet 5.5 with the `web_search` server tool (`max_uses: 2`) to identify what the business is (e.g. "KESSLER S MINFAIRVIEW" → a restaurant in Fairview). Save the result to `payees.merchant` so each merchant is looked up **once**, then re-run step 4 with the profile.
6. Otherwise leave it **uncategorized** and put it in the review queue with the top 3 suggestions.

### 9.2 Payee normalization
- Apply deterministic cleanup first: strip POS/ACH prefixes ("POS PURCHASE", "SQ *", "TST*", "PAYPAL *"), store numbers (#1234), trailing city/state, card suffixes and reference numbers. Then title-case.
- `payee_aliases` maps raw patterns to a payee. The AI may propose a clean merchant name (`payee_name` in its output). Create an alias automatically when confidence ≥ 0.9; otherwise suggest it.

### 9.3 AI categorization call
- **Model:** `claude-haiku-5-5` (configurable). Use `output_config.format` with a JSON schema (structured outputs). Cache the system prompt and category catalog with `cache_control` (the prompt must be ≥ 512 tokens to cache).
- **Context sent:**
  - The category catalog: group, name, note, target, and 3–5 example payees per category from history.
  - `household_memory` facts.
  - The transaction: raw description, normalized payee, amount, account (e.g. checking, a card, the business account), date and weekday, merchant profile if known.
  - Up to 15 similar past transactions (Postgres `pg_trgm` similarity on payee, plus same amount ± 10%) with their final categories.
- **Output schema:**
  ```json
  { "category_id": "uuid|null", "confidence": 0.0-1.0, "payee_name": "string",
    "is_transfer": false, "split": [{"category_id":"uuid","amount_milli":0}] | null,
    "needs_web_lookup": false, "explanation": "≤ 20 words" }
  ```
- **Batch path:** the nightly backlog and the initial history clean-up use the **Message Batches API** (50% off). Results are processed when the batch ends (most finish within 1 hour).
- **Privacy:** send only the transaction fields listed above. Never send account numbers, balances or the full ledger. Web searches may contain only the merchant string and city, never amounts or personal data (state this in the system prompt and check generated queries with a regex guard where possible).

### 9.4 Approval policy (Settings, defaults shown)
- Auto-approve if:
  - the method is rule or history with confidence ≥ 0.95, **or**
  - the method is AI with confidence ≥ 0.95 **and** |amount| < $150
  - **and** the category isn't flagged "always review" (default: Misc, Uncategorized, any Savings category).
- Auto-categorize but leave unapproved if confidence ≥ 0.75.
- Below 0.75: only show suggestions.
- Income over $500 and anything categorized to RTA always needs review the first 3 times for a given payee.

### 9.5 Learning from corrections
- Every change to a category writes a `categorization_event`.
- If the same payee is corrected to the same category 2 times in a row, create a `learned` rule. Show the toast "Learned: Lowe's → House Projects (Undo)" and offer to re-apply it to that payee's unapproved transactions.
- Monthly "category health" insight: if Misc (or any category) gets more than 15 transactions a month from recognizable merchants, suggest new categories or rules. In a typical YNAB budget Misc is the most frequent category, and big-box merchants (Amazon, a hardware store) land there.

### 9.6 Splits for big-box merchants (Phase 9 backlog)
- Amazon: import Amazon order history (Amazon "Request your data" CSV, or order-confirmation emails uploaded manually). Match orders to card charges by amount and date, then AI-categorize each item and propose a split.
- Allow the same for Costco and Target receipts, where Claude reads uploaded receipt photos and proposes a split.

---

## 10. Migration from YNAB and cutover

1. **Import (Phase 1).** Pull the full plan with the YNAB API and map it:
   - category groups and categories, with the hidden flag, notes and emojis (kept as part of the name; there is no separate emoji column)
   - `goal_*` fields → `targets`, using this mapping:
     - NEED with `goal_needs_whole_amount=true` → `need_set_aside`
     - NEED with `false` → `need_refill`
     - TB → `balance`
     - TBD → `balance_by_date`
     - MF → `monthly_builder`
     - DEBT → `debt`
     - Cadence and day map across directly.
   - accounts (on budget/tracking, closed)
   - transactions with subtransactions (splits), transfers (YNAB `transfer_account_id` → `transfer_account_id`; YNAB `transfer_transaction_id` → `transfer_pair_id`), cleared/approved/flags/memos
   - scheduled transactions
   - payees
   - **every month's assigned amount per category** (`/months/{month}` `budgeted`)
   - YNAB's own "Credit Card Payments" categories → `cc_payment` categories linked to their cards
2. **Parity check:** run the golden tests (§6.9) until they're clean.
3. **Parallel run (2–4 weeks).** It starts at **sync start**, the day Phase 3 ships and SimpleFIN/Mercury sync is turned on.
   - **YNAB is the source of truth during the parallel run.** Homebase:
     - syncs from SimpleFIN and Mercury, and backfills to 30 days before sync start (§7.1)
     - imports YNAB deltas daily (`last_knowledge_of_server`); YNAB's categories, splits, memos and assignments win
     - matches YNAB deltas to synced transactions (§8.4) so there's only one row per real transaction
     - runs the categorizer in **shadow mode**: it records suggestions in `categorization_events`, but doesn't write categories. This doubles as the accuracy measurement for Phase 4.
     - shows a daily comparison: RTA and each category's available amount, YNAB vs Homebase
4. **Cutover** is the day YNAB delta imports stop and Homebase becomes the source of truth. Delete the YNAB token from Settings, and cancel the subscription before renewal. YNAB charges annually; the "🌳 YNAB subscription" category is the sinking fund. Keep a final YNAB export (CSV and API JSON) in backups.

---

## 11. AI assistant ("Ask")

### 11.1 Models (all IDs editable in Settings; these defaults are current as of Oct 2026)
| Use | Default model | Price (per MTok, in/out) |
|---|---|---|
| Chat | `claude-sonnet-5-5` | $2 / $10 |
| Deep analysis toggle | `claude-opus-5-5` | $4 / $20 |
| Categorization, normalization, digests | `claude-haiku-5-5` | $0.10 / $0.50 |
| Merchant web lookup | `claude-sonnet-5-5` + `web_search` | + $10 per 1k searches |

### 11.2 Agent loop
- `POST /api/ask` streams Server-Sent Events. Use `@anthropic-ai/sdk` with a manual tool loop, capped at 12 tool iterations per turn.
- Put prompt-caching breakpoints on the system prompt and tool definitions.
- Persist every message and tool call.
- **System prompt essentials:**
  - Today's date and time zone.
  - Who's speaking (Alex or Sam).
  - The household context from `household_memory`, the category tree, and the account list.
  - Rules:
    - **Never state a number without getting it from a tool.**
    - Always state the date range used.
    - Use the user's category names.
    - Keep answers short and lead with the number, then offer a chart.
    - Any change to data must go through a write tool, which requires confirmation.
    - Don't give individualized investment or tax advice beyond describing the household's own data; suggest a CPA or advisor for decisions.

### 11.3 Tools
**Read tools (run automatically):**
- `get_overview()`: RTA, overspent categories, unapproved count, net worth, last sync per account.
- `get_budget_month(month)`: every category's assigned/activity/available/target state.
- `query_transactions(filters)`: date range, categories, payees, accounts, amount range, text, approved/uncleared. Returns ≤ 200 rows plus totals.
- `spending_summary(group_by: category|group|payee|month|account, period, filters)`.
- `net_worth(period, granularity)` and `holdings(account?)`.
- `sql_query(sql)`: SELECT only, against the `homebase_ro` role and §5.5 views. The server enforces `LIMIT 500` and a 5-second timeout, and rejects anything that isn't a single SELECT/WITH.
- `lookup_merchant(name, city?)`: web search, cached into the payee record.
- `render_chart(spec)`: the client renders it with Recharts or ECharts. Spec: `{type: pie|bar|stacked_bar|line|area|sankey|table, title, series, x, y, format: currency|percent}`.
- `save_report(name, spec)`.

**Write tools (create a pending action card and run only after the user taps Confirm):**
- `recategorize(transaction_ids[], category_id)`
- `split_transaction(id, lines[])`
- `approve(transaction_ids[])`
- `create_rule(conditions, actions, apply_to_existing: bool)`
- `assign(month, category_id, amount)`
- `move_money(month, from, to, amount)`
- `auto_assign(month, mode, category_ids?)`
- `create_category(group, name)`
- `update_target(category_id, target)`
- `remember(fact)`: adds to `household_memory`.

Action cards show a human-readable diff, e.g. "Move 14 transactions ($612.40) from Misc → House Projects", with Confirm, Edit and Cancel. A confirmation applies to that card only. Every executed write goes to `audit_log` with `actor=ai, confirmed_by=user`.

### 11.4 Example prompts that must work (e2e tests against seeded data)
- "How much did we spend eating out this year vs last year?"
- "Where did all our money go in September?" (pie chart plus a top-5 list)
- "Categorize everything from Lowe's this month as House Projects and make a rule."
- "Are we on track for the Emergency Fund target?"
- "What's our net worth trend since we bought the house?"
- "How much is in Alex's 401k and how much did it grow last month?"
- "Which subscriptions went up in price?"
- "If we put $500/mo extra on the mortgage, when is it paid off?"
- "Fund all underfunded categories with what's left to assign."

### 11.5 Voice
- **Speech to text:**
  - Hold-to-talk mic button → `MediaRecorder` (audio/mp4 or PCM) → `POST /api/stt` → **whisper.cpp server on the host** (Metal, `small.en` model; switch to `base.en` if latency is over 2 seconds) → the transcript appears in the input box and auto-sends (setting).
  - **iOS Safari's Web Speech recognition doesn't work in home-screen apps; don't use it.**
  - Optional fallback: OpenAI `gpt-4o-mini-transcribe` (about $0.003/min) if an OpenAI key is configured.
- **Text to speech:**
  - When "Speak replies" is on, read a short spoken summary that the model returns in a separate `speech` field (no markdown, no tables) using `speechSynthesis`.
  - If the built-in voices sound bad, an optional v2 is a Kokoro-FastAPI container (`/v1/audio/speech`).
- Use history routing, not hash routing (hash route changes re-prompt for mic permission on iOS).

### 11.6 Proactive insights
- A **weekly digest** (Sunday 18:00) goes out as a Web Push notification and a pinned chat message. It's generated by Haiku from **pre-computed stats**, not the raw ledger. It covers:
  - spending vs assigned month to date
  - overspent categories
  - unapproved and uncategorized counts
  - unusual transactions (more than 3σ above that payee's or category's norm)
  - new or price-changed subscriptions
  - bills due in the next 7 days
  - net-worth change
- **Recurring detection:** group by payee, looking for a regular interval (weekly, monthly or yearly ± 3 days) and a stable amount. This feeds a Subscriptions view and price-increase alerts.
- **Alerts** (Web Push, each can be turned off):
  - a connection needs reconnecting
  - a category goes overspent
  - a large transaction (> $500)
  - card payment due in 3 days, using the statement due date if SimpleFIN `extra` provides it **[VERIFY]**; otherwise a user-set due date per card

### 11.7 Cost guardrails
- `ai_usage` records every call's tokens and cost.
- Settings shows the month-to-date AI cost and a **hard monthly cap** (default $8). At 80% of the cap, send a push. At 100%, chat is disabled and categorization falls back to rules and history only.
- Also set the Anthropic Console workspace spend limit (§3 #2) as a second safety net.

---

## 12. UI / UX

Mobile-first PWA. Bottom tab bar: **Plan · Activity · Wealth · Reports · Ask**. Settings sits behind the avatar in the top right. On desktop, use a left sidebar like YNAB's.

- Dark mode.
- iPhone safe areas.
- Tap targets ≥ 44px.
- `inputmode="decimal"` on amounts.
- Optimistic updates.
- Undo on every budget action.
- Pull-to-refresh recomputes from the DB. It does **not** trigger a bank sync, which is a separate rate-limited "Sync now" button.

### 12.1 Plan (budget)
- **Header:**
  - month switcher
  - RTA banner (green if > 0, gray if 0, red if < 0) with an **Assign** menu that holds the Auto-Assign options from §6.6
  - month note
- Filter chips: All, Overspent, Underfunded, Overfunded, Money Available, Snoozed.
- **Category groups** are collapsible, showing group totals. Each category row has:
  - emoji and name
  - a target progress bar with a status label ("Funded", "Fully Spent", "Spent $X of $Y", "Overspent $X of $Y", "$X more needed by …")
  - **Assigned** (tap to edit; accepts math like `+50` or `=200`)
  - Activity
  - **Available** pill: green (funded), yellow (credit overspending, or underfunded with an upcoming transaction), red (cash overspending), gray (0)
- **Category sheet** (opens on tap):
  - an available-balance breakdown (left over from last month, assigned, cash spending, credit spending)
  - the target editor
  - notes
  - recent transactions
  - per-category Auto-Assign
  - a "Move money" action
- **Month summary panel:**
  - left over from last month
  - assigned this month
  - activity
  - available
  - **Cost to Be Me**
  - assigned in future months
- The Credit Card Payments group is pinned at the top, as in YNAB.

### 12.2 Activity (transactions)
- **Review inbox** at the top, with a badge count of unapproved transactions. Each transaction is a card showing:
  - payee, amount, account and date
  - the AI suggestion as a chip, with confidence and explanation shown on tap
  - swipe right = approve, swipe left = change category
  - category picker: search plus recently used
  - Split and Mark as transfer actions
  - **Approve all high-confidence** button
- **Register:**
  - all accounts or one account, with search and filters
  - running balance
  - cleared toggle
  - a reconcile flow
  - a + button for manual transactions
  - an edit sheet with split support
- **Accounts list:** balance, "updated X ago", and a connection status dot (green/yellow/red) with fix instructions.

### 12.3 Wealth
- **Net worth** headline, with change versus last month, and an area chart (1M / 3M / YTD / 1Y / All) stacked by assets and liabilities.
- **Sections:**
  - Cash: checking and savings
  - Credit: the cards
  - Investments: brokerage
  - Retirement: 401k and IRAs, per person
  - Crypto: Coinbase, River
  - Home: value with its range, and equity
  - Mortgage: balance, payoff date
  - Business toggle: Mercury
- **Investment account detail:**
  - value over time
  - **monthly growth split into contributions vs market change**
  - holdings table
  - allocation donut (by asset class where it can be inferred)
- **Home detail:**
  - value history (monthly RentCast points with a range band)
  - comps list
  - equity chart (value − mortgage)
  - manual value override
- **Mortgage detail:**
  - amortization chart
  - interest paid so far
  - extra-payment / recast simulator

### 12.4 Reports
See §13.

### 12.5 Ask
- The chat thread streams answers.
- A mic button (hold to talk) and a speaker toggle.
- Suggested prompts when empty.
- Charts and tables appear inline. Each chart has a button to save it as a report.
- Pending action cards for confirmations.
- Conversation list, plus a "New chat" button.

### 12.6 Settings
- **Connections:** provider, status, last success, requests used today (SimpleFIN), test button, rotate key, reconnect instructions, last 4 characters of the secret.
- **New-account inbox:** name, kind, on/off budget, entity, sign.
- **Accounts:** edit and close.
- **Categories and groups:** create, reorder, hide, and **merge** (merging recategorizes history).
- **Targets.**
- **Rules:** list, create/edit, a "test against history" preview (N matches), hit counts, enable/disable.
- **Payees:** rename, merge, default category, merchant profile.
- **AI:**
  - model IDs
  - monthly cap
  - approval thresholds
  - "always review" categories
  - web lookup on/off
  - usage and cost chart
  - categorization accuracy chart
- **Household memory:** an editable list.
- **Users and PINs.**
- **Notifications:** per alert type.
- **Imports:** YNAB, CSV/OFX, River CSV, Fidelity positions CSV.
- **Backups:** last run, download the latest dump.

---

## 13. Reports

All reports take a period (month, quarter, YTD, last 12 months, custom), plus account and entity filters and a choice of category or group level. Each one can drill into transactions and export to CSV and PNG.

1. **Spending breakdown:** a donut by category or group, with a ranked list (amount and %), average monthly and daily spend, the most frequent category, and the largest outflow. This is YNAB's default Reflect view.
2. **Spending trends:** stacked bars per month by group or category, over 12 months, with an average line.
3. **Income vs expense:** monthly bars, a net line, and **savings rate**.
4. **Net worth:** stacked area (assets/liabilities) with a net line.
5. **Age of Money** over time.
6. **Category detail:** assigned vs spent per month, average, and how many months it met its target.
7. **Payees:** top payees by spend and by frequency, with a trend.
8. **Cash-flow sankey:** income sources → groups → categories (ECharts).
9. **Investment growth:** per account and total, contributions vs market change by month.
10. **Budget performance:** per category, % of months overspent, average overspend, and a suggested assignment.
11. **Subscriptions:** recurring charges, annualized cost, and price changes.
12. **Saved/custom reports**, created by the user or by Ask (`saved_reports.spec`), with pinning to the top.

---

## 14. Build phases and acceptance criteria

Work in order. Each phase ends with passing tests, a short `docs/phase-N.md` changelog, and a demo note for Alex. Use **seeded fake data** (`pnpm seed:demo`) for all UI work until real connectors are wired. The demo seed is deterministic: 18 months of realistic household data (the same category tree as Appendix A, two cards, a mortgage, a 401k, crypto). It ships with a `fixtures/demo-expected.json` holding the correct answers for every §11.4 prompt and every §13 report, which the tests assert against.

| Phase | Scope | Acceptance criteria |
|---|---|---|
| **0. Foundations** | Monorepo, Docker Compose (web, worker, postgres, tailscale, backup), env validation, encrypted secrets, PWA shell (manifest, icons, service worker), Tailscale Serve, user identification + PIN fallback, CLAUDE.md, CI scripts (`pnpm test`, `lint`, `typecheck`) | App installs to the iPhone home screen over `https://homebase.<tailnet>.ts.net` and opens standalone. Unreachable from off-tailnet. Restore-from-backup script works on a fresh DB. |
| **1. Data model + YNAB import + engine** | §5 schema, §7.9 importer, §6 engine, golden tests | Full YNAB history imported. **Parity diff is empty** for every month (RTA, assigned, activity, available, underfunded), and Cost to Be Me for Oct 2026 = YNAB's. Card-payment synthetic tests pass. |
| **2. Plan + Activity UI** | §12.1, §12.2 (manual data), move money, auto-assign, targets editor, reconcile, splits, scheduled transactions, undo | Alex can do a full month of budgeting on the phone without YNAB. Playwright e2e on iPhone 15 viewport passes for: assign, move, auto-assign underfunded, split, reconcile. |
| **3. SimpleFIN sync** | §7.1, §8 (jobs, ingest, transfer detection, matching), connection health, new-account inbox | Bank, card and brokerage balances (and holdings if present) sync 4×/day under the request budget. Pending → posted works. Card payments auto-pair as transfers. Zero duplicates between synced transactions and YNAB-imported/delta transactions over the 30-day backfill overlap and the first 2 weeks of the parallel run. |
| **4. Smart categorization** | §9 complete (rules, history, Haiku, web lookup, batch, approvals, learning) | On a held-out set of the last 60 days of real YNAB-categorized transactions, with rules, history and few-shot examples built **only from data before that window** (no leakage): **≥ 85% top-1 accuracy**, ≥ 60% auto-approved with ≥ 98% precision on auto-approved ones. AI cost < $1 for the test. |
| **5. Reports** | §13 items 1–7, 10–12 | Numbers match the engine and transaction views exactly (unit tests per report). Spending breakdown for Oct 2026 matches YNAB's Reflect total. |
| **6. Wealth** | Mercury, Coinbase, River (SimpleFIN / CSV / xpub), Fidelity CSV fallback, RentCast, mortgage amortization + events, net-worth snapshots, §12.3, reports 8–9 | Net worth page shows every account. Home value and mortgage update. Monthly investment growth shown. Business toggle works and Mercury never affects RTA. |
| **7. Ask + voice + digests** | §11 complete, Web Push | All §11.4 prompts give correct answers on seeded data. Write tools need confirmation and leave audit entries. Voice round-trip < 4 s for a 5 s question on the server. Weekly digest arrives as a push. Cost cap enforced. |
| **8. Gusto (optional)** | §7.8 | Last 6 payrolls imported and matched to deposits. 401k deferrals feed investment growth. |
| **9. Backlog** | Amazon/receipt splits, Kokoro TTS, rental property tracking, hands-free voice mode, YNAB-style "loans" interest estimation, sharing a read-only view | — |

The **parallel run** (§10) starts when Phase 3 ships. **Cutover**, the point where YNAB stops being the source of truth and is cancelled, happens once Phase 4 meets its targets and the parallel-run comparison has been clean for at least 2 weeks.

---

## 15. Engineering conventions (for Claude Code)

- **Workflow:** read this spec, then write `CLAUDE.md` (repo map, commands, conventions, "never" list) and `docs/decisions.md` (ADR-style log). For each phase: plan, implement, write and run tests, self-review the diff, update docs. Use subagents for parallel work (e.g. connectors vs UI) and a separate reviewer pass before closing a phase.
- **Repo layout:**
  ```
  apps/web            Next.js app (UI, server actions, /api/ask, /api/stt)
  apps/worker         pg-boss jobs
  packages/db         Drizzle schema, migrations, views, seed (demo + fixtures)
  packages/engine     budget engine (pure TS) + golden tests
  packages/connectors simplefin, mercury, coinbase, river, fidelity-csv, rentcast, ynab, gusto, csv
  packages/categorizer
  packages/ai         prompts, tools, model client, usage accounting
  packages/shared     money (milliunits), dates (America/New_York), zod types
  infra/              docker-compose.yml, tailscale/serve.json, launchd/whisper.plist, scripts/
  ```
- **"Never" list:**
  - no floats for money
  - no write calls to any financial API, including YNAB
  - no secrets, real transactions or YNAB fixtures committed (`fixtures/private/` is gitignored)
  - no inbound exposure (no Funnel, no port forwards)
  - no AI write without confirmation
  - no sending account numbers to the LLM
- **Testing:**
  - Engine coverage ≥ 95% lines.
  - Every connector has recorded-response tests (sanitized JSON fixtures).
  - Every report has numeric tests.
  - e2e tests use Playwright on the iPhone viewport.
- **Deploy:**
  - Develop on a dev machine.
  - Deploy to the server with `infra/scripts/deploy.sh`: git pull, `docker compose up -d --build`, run migrations, then a health check.
  - Also write `infra/scripts/install-whisper.sh` and `infra/scripts/restore.sh`.
- **Observability:** structured logs (pino), a `/health` page (DB, jobs, last sync per connection, AI spend), and job failure → Web Push to Alex.
- **Server care:** the server must not sleep. Document `pmset` settings, or use Amphetamine, and auto-start on power loss. Docker volumes go on the internal disk, and backups are copied to a second location.

---

## 16. Open decisions for Alex (defaults in **bold**, used if no answer)

1. "Local only": **tailnet-only via Tailscale Serve** (works away from home) vs strict home-LAN only (Caddy internal CA, no away access).
2. Off-host backup target: **an external drive via restic**, an iCloud Drive folder, or none.
3. Mortgage servicer name, and whether it's on SimpleFIN. Default: **amortization from loan terms**.
4. The business in the app: **view-only Mercury balances and transactions under a toggle** vs a full second budget for the business.
5. The second member's login: **Tailscale identity** (Tailscale on their phone) vs a shared device PIN. Also decide how they get on: **share only the Homebase node with them** (Tailscale node sharing, so they see nothing else), or invite them to the tailnet (then tighten the policy so they can't reach the other services on it).
9. If the server is on a different Tailscale account today: **move it to the household's tailnet** (re-pointing whatever else it serves), or put Homebase on that other tailnet instead. Claude Code reports, then asks (§4.5).
6. Auto-approve thresholds (§9.4): **defaults as written**.
7. Should a giving category become a `percent_of_income` target (e.g. 10% of deposits), replacing a fixed monthly set-aside? Default: **import as-is and offer the switch in the UI**.
8. App name: **Homebase**.

---

## 17. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A SimpleFIN/MX connection breaks (bank login change, MFA) | Connection health job + push. Reconnect happens on SimpleFIN's site. CSV import fallback. |
| A card issuer's system migration changes logins | Same as above. Watch for `con.auth` errors. |
| A workplace 401k login is blocked by aggregators | Link it to the main brokerage login first. Positions CSV fallback. |
| SimpleFIN's undocumented `holdings[]` changes | Defensive parsing; degrade to balance-only. |
| Budget math drifts from YNAB | Golden parity tests (§6.9) plus a parallel run (§10). |
| AI miscategorizes silently | Approval thresholds, "always review" categories, accuracy dashboard, easy undo, audit log. |
| AI spend runaway | Per-call accounting, app hard cap, Console workspace spend limit. |
| Gusto CLI can't run unattended | Phase 8 is optional; manual payroll import fallback. |
| Home server dies | Nightly dumps, off-host copy, tested restore script, and the whole stack in Compose. |
| iOS PWA quirks (mic permissions, storage eviction) | History routing, server as source of truth, app-shell-only caching. |

---

## 18. Running cost estimate

| Item | Monthly |
|---|---|
| SimpleFIN Bridge | $1.25 ($15/yr) |
| Claude: categorization (~150 tx/mo, most handled by rules/history; ~40 AI calls on Haiku) | < $0.10 |
| Claude: merchant web lookups (~20 new merchants/mo × $0.01 + tokens) | ~$0.30 |
| Claude: chat (~100 turns/mo on Sonnet 5.5 with caching, ~15k in / 1k out) | ~$3–5 |
| RentCast, Mercury, Coinbase, YNAB API, Tailscale (personal), whisper.cpp | $0 |
| **Total** | **≈ $5–7/mo**, vs YNAB's $109/yr ($9.08/mo) |

---

## Appendix A. Example YNAB setup (the shape of the demo seed)

Structure only: this is the tree `pnpm seed:demo` builds. It is modeled on a real YNAB budget's categories, with made-up people and every amount and target invented. The importer pulls a real plan's exact data, targets and history from the API.

- **Plan:** one YNAB plan. **Budget accounts:** Checking, Savings and two credit cards ("Cash Back Card", "Rewards Card"). Some accounts are closed. The business bank, brokerage, 401k, crypto and the mortgage live outside YNAB, so they're new in Homebase.
- **Category groups and categories:**
  - **Credit Card Payments:** one per card
  - **Bills:** Health Insurance, Trash, 🏠 Mortgage, 🛜 Internet, ⚡️ Electricity, 📱 Phone, 🛠 Auto insurance, 🎵 Music, Costco (membership), 🍎 Apple Storage, 🛡️ ID Protection, 📅 Family Calendar, 📰 News, 🌳 YNAB subscription
  - **Needs:** 👴 Alex's Retirement, 👵 Sam's Retirement, 🐢 Pets, 🚑 Medical Expenses, ⛽️ Gas, 🛒 Groceries, 🤷‍♂️ Misc, 🚗 Car Expenses
  - **Wants:** 🍽️ Eating Out, ❤️ Dates, 🍿 Entertainment, 🤝 Giving, 🎁 Gifts, 🏎️ Alex's Spending Money, 👗 Sam's Spending Money
  - **Savings:** Extra House Payments, House Projects, Taxes, 🚨 Emergency Fund, 💰 Savings
  - **Hidden:** an old "House Costs" catch-all that still has activity
- **Targets in use:** most Bills/Needs/Wants categories have monthly targets ("Funded", "Spent $X of $Y" states), for example Giving = "Set aside another $500 each month, by end of month". Savings categories mostly have none.
- **Workflow patterns that drive requirements:**
  - Dozens of transactions waiting for approval make approving a chore → §9.4 auto-approve.
  - Amazon orders on a card usually "need a category" and pile up as uncategorized activity → §9.1, §9.6.
  - Misc is the busiest category, with hardware-store runs landing there → §9.5 category health.
  - The payroll deposit arrives in Checking as "Inflow: Ready to Assign" → §8.3.
  - Reflect → Spending Breakdown, Spending Trends, Net Worth, Income v Expense and Age of Money are the reports people use → §13.
  - A month can end with overspending on credit in Misc and Eating Out (yellow) → §6.3/§6.4 parity cases.

## Appendix B. Key references
- SimpleFIN protocol: https://www.simplefin.org/protocol.html · Bridge developer guide: https://beta-bridge.simplefin.org/info/developers
- Sure (open-source finance app) SimpleFIN provider notes: https://docs.sure.am/providers/simplefin
- Mercury API: https://docs.mercury.com/docs/getting-started · Webhooks/MCP: https://docs.mercury.com/docs/connecting-mercury-mcp
- Coinbase App API key auth: https://docs.cdp.coinbase.com/coinbase-app/authentication-authorization/api-key-authentication · Transactions: https://docs.cdp.coinbase.com/coinbase-app/track-apis/transactions
- River activity export: https://support.river.com/hc/en-us/articles/45513824178963 · mempool.space API: https://mempool.space/api
- Gusto CLI: https://github.com/Gusto/gusto-cli · Gusto app integrations: https://docs.gusto.com/app-integrations/docs/introduction
- YNAB API: https://api.ynab.com/ · OpenAPI spec: https://api.ynab.com/papi/open_api_spec.yaml
- YNAB methodology: credit cards https://support.ynab.com/handling-credit-cards-overview-ry7cNub1s.md · targets https://support.ynab.com/how-to-use-targets-rk5kkI9ks.md · auto-assign https://support.ynab.com/auto-assign-a-guide-r1gBNbBJo.md · Age of Money https://support.ynab.com/en_us/age-of-money-H1ZS84W1s.md
- Actual Budget engine (MIT, reference): https://github.com/actualbudget/actual/tree/master/packages/loot-core/src/server/budget
- RentCast AVM: https://developers.rentcast.io/reference/property-valuation
- Claude API: models https://platform.claude.com/docs/en/models/overview · pricing https://platform.claude.com/docs/en/about-claude/pricing · structured outputs https://platform.claude.com/docs/en/build-with-claude/structured-outputs · batches https://platform.claude.com/docs/en/build-with-claude/batch-processing · web search tool https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- Tailscale Serve: https://tailscale.com/kb/1312/serve · Docker params: https://tailscale.com/docs/features/containers/docker/docker-params
- iOS speech recognition limitation: https://bugs.webkit.org/show_bug.cgi?id=225298
