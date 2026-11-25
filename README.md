# Big Bucks

Big Bucks is a self-hosted budgeting app for one household. It does the job YNAB does: every dollar goes into a bucket, card spending moves money into the card's payment bucket, and the plan always adds up. Bank, card, investment and crypto accounts update on their own, new transactions arrive already sorted into buckets, and an Ask tab answers questions about your own money with charts. It installs on a phone like an app (a PWA) and runs on a small home server under Docker.

- **Landing page:** https://bigbucks.ridgelineva.com
- **Live demo:** https://budget-demo.ridgelineva.com (a made-up household; it resets every night)

The code still uses the working name `homebase` for its packages, containers and databases.

## What it does

- **A bucket budget.** Monthly buckets with goals, savings buckets you add to as money comes in, overflow that rolls leftovers into next month, "Ready to save", splits, scheduled transactions, and undo for every budget move.
- **A YNAB-style engine.** Ready to Assign, cash versus credit overspending, credit card payment categories, every YNAB target type plus percent of income, auto-assign and Age of Money, computed in exact milliunits. Parity tests compare it with YNAB's own month figures (synthetic fixtures ship with the repo).
- **Accounts that keep themselves current.** SimpleFIN Bridge brings in banks, cards, brokerages and 401ks, with pending-to-posted matching, transfer pairing and duplicate detection. There are also connectors for Mercury (a business account kept off the household budget), Coinbase, River (activity CSV or a watch-only xpub), Fidelity positions CSV, RentCast home values, a mortgage amortization schedule, optional Gusto payroll, CSV/OFX/QFX files and a one-time YNAB import. Every connector is read-only, enforced in code and checked by tests.
- **Categorization that learns.** Your rules first, then your own history, then Claude with structured output, then a single web lookup for a merchant it has never seen. Anything it isn't sure of waits in a review queue, and repeated corrections become rules.
- **Reflect.** Spending breakdown, spending trends, income versus expense with a savings rate, net worth, Age of Money, payees, a cash-flow diagram, investment growth split into contributions and market change, budget performance, subscriptions with price changes, and saved reports.
- **Investments.** Every investment account together or one at a time, holdings and per-fund history, plus hand-entered assets priced every hour.
- **Ask.** A chat that answers from your data through tools (budget, transactions, net worth, a read-only SQL layer over reporting views), draws charts, and proposes changes that only happen after you confirm them. Voice input goes through a local whisper.cpp server.
- **Alerts.** Web Push for overspending, large transactions, card due dates, a broken connection, stale backups and AI spend, plus a weekly digest.
- **Security.** Username and password sign-in (argon2id, lockout, per-IP limits) or Tailscale identity. Every page checks the session itself. Stored credentials are encrypted with AES-256-GCM, the AI's SQL runs as a read-only database role, and long digit runs are masked before any text reaches the model. Backups run nightly with a restore drill, and nothing publishes a port.

## Stack

TypeScript (strict) in a pnpm monorepo. Next.js 16 (App Router) with React 19, Tailwind 4 and Serwist for the PWA; Recharts and ECharts for charts. Postgres (16 in development, 18 in production) with Drizzle ORM, and pg-boss for background jobs. Zod at every boundary. The Anthropic SDK for Claude. Vitest and Playwright for tests. Docker Compose under OrbStack on a Mac, with a Tailscale Serve sidecar and an optional Cloudflare Tunnel, and whisper.cpp for speech-to-text.

| Path | Contents |
|---|---|
| `apps/web` | The Next.js PWA: UI, server actions, `/api/ask`, `/api/stt` |
| `apps/worker` | pg-boss jobs (sync, categorize, snapshots, digests, backup checks) and the import CLIs |
| `packages/engine` | The pure budget engine and its parity tests |
| `packages/connectors` | SimpleFIN, Mercury, Coinbase, River, Fidelity CSV, RentCast, YNAB, Gusto, CSV/OFX, amortization |
| `packages/categorizer` | Payee cleanup, rules, history and the AI pipeline |
| `packages/ai` | Claude client, prompts, agent tools, cost accounting and redaction |
| `packages/db` | Schema, migrations, reporting views, encryption and the demo seed |
| `packages/core`, `packages/shared` | Domain logic shared by web and worker; money and date helpers |
| `infra` | The Compose file, Dockerfiles, Tailscale Serve config and server scripts |

Design and decisions live in `docs/spec.md` and `docs/decisions.md`; the server guide is `docs/server-setup.md`.

## Run it locally

You need Node 24 or later, pnpm 10 (`corepack enable`) and Homebrew `postgresql@16` with its binaries (`initdb`, `pg_ctl`) on your `PATH`.

```sh
pnpm install
pnpm db:dev        # Postgres on port 54329, data in .dev/pgdata
export DATABASE_URL=postgres://homebase@localhost:54329/homebase   # what db:dev prints
pnpm db:migrate
pnpm seed:demo     # the made-up demo household
HOMEBASE_DEV_USER=alex@example.com pnpm dev    # http://localhost:3000, signed in as the demo admin
```

`HOMEBASE_DEV_USER` only works when `NODE_ENV` is `development`. Run the checks with `pnpm typecheck`, `pnpm lint` and `pnpm test`; the integration tests use `TEST_DATABASE_URL` (default `postgres://homebase@localhost:54329/homebase_test`). Playwright runs with `pnpm --filter @homebase/web e2e`.

## Host it yourself

`docs/server-setup.md` walks through every step. In short, for a Mac running OrbStack that you can reach as the SSH alias `homebase-server`:

1. **Bootstrap the checkout and secrets.** The script never uses sudo, and prints whatever is still left to do.
   ```sh
   ssh homebase-server 'HOMEBASE_REPO=<owner>/<repo> bash -s' < infra/scripts/server-bootstrap.sh
   ```
   It clones the repository to `~/homebase`, creates `.env` from `.env.example`, and fills in `POSTGRES_PASSWORD`, `DATABASE_URL`, `HOMEBASE_RO_PASSWORD`, `HOMEBASE_MASTER_KEY`, `DEMO_POSTGRES_PASSWORD` and `DEMO_MASTER_KEY`. The master key is printed once: keep it in a password manager, because without it a restored backup can't read any saved bank or API credential.
2. **Add your own values to `~/homebase/.env`.** `TS_AUTHKEY` is a reusable Tailscale auth key tagged `tag:homebase`. Optional: `CLOUDFLARE_TUNNEL_TOKEN` for a public hostname through Cloudflare Tunnel, `VAPID_SUBJECT` (a `mailto:` address for Web Push), and the first-run connector secrets `ANTHROPIC_API_KEY`, `SIMPLEFIN_ACCESS_URL`, `MERCURY_TOKEN`, `RENTCAST_API_KEY` and `YNAB_TOKEN`, which move into encrypted Settings → Connections on first start.
3. **Optional speech-to-text:** `ssh homebase-server 'bash ~/homebase/infra/scripts/install-whisper.sh'`.
4. **Deploy** from your dev machine with `infra/scripts/deploy.sh`. It pulls, builds, runs migrations, starts the stack and checks `/api/health`.
5. **Create the household** and sign in over your tailnet at `https://homebase.<your-tailnet>.ts.net`:
   ```sh
   ssh homebase-server '~/homebase/infra/scripts/compose.sh exec worker pnpm --filter @homebase/worker setup:household --admin <tailscale login> --name <name>'
   ```
   Then set usernames and passwords in Settings → Users & passwords. To bring in an existing YNAB budget (read-only, with `YNAB_TOKEN` set), run `compose.sh exec worker pnpm import:ynab` the same way (add `--plan <name>` if you have more than one plan).
6. **Backups** run every night into `~/homebase/backups`. Prove that a restore works with `ssh homebase-server '~/homebase/infra/scripts/restore.sh --drill'`.

Other settings: `TZ`, `TS_HOSTNAME`, `WHISPER_URL`, `HOMEBASE_CF_ACCESS_TEAM` and `HOMEBASE_CF_ACCESS_AUD` (optional Cloudflare Access), `HOMEBASE_DEMO` and `HOMEBASE_DEMO_URL` (demo mode, and the demo link on the sign-in page), `HOMEBASE_DEV_USER` and `HOMEBASE_DEV_PASSWORD` (development only).

## About the data

The household in the demo, the seed (`packages/db/src/seed/demo.ts`), the tests and the docs is fictional: Alex and Sam, and Alex's business, Northwind Studio. Every amount, account, address, town and local merchant is made up, and the banks use sample names (Contoso, Woodgrove, Fabrikam, Litware, Proseware). The category tree is modeled on a real budget's, without its amounts or targets. Real services (SimpleFIN, Mercury, Coinbase, River, Fidelity, RentCast, Gusto, YNAB) appear only to exercise their connectors. Real exports never go in the repository; `fixtures/private/` is gitignored for them.

Big Bucks is an independent project and is not affiliated with YNAB (You Need A Budget).

## License

MIT. See [LICENSE](LICENSE).
