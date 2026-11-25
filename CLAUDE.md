# Big Bucks (repo: homebase)

Self-hosted household finance app (a YNAB replacement) built for one household. The UI is branded "Big Bucks" (`apps/web/src/lib/brand.ts`); packages, containers and databases are still named `homebase`. Full spec: `docs/spec.md` (source of truth). Decisions: `docs/decisions.md`. Open blockers: `docs/stoppers.md` (private; not in the public repository).

## Repo map
- `apps/web` — Next.js 16 App Router PWA (UI, server actions, `/api/ask`, `/api/stt`)
- `apps/worker` — pg-boss jobs (sync, categorize, snapshots, digests, backups), YNAB import CLI
- `packages/shared` — money (bigint milliunits), dates (America/New_York), enums
- `packages/db` — Drizzle schema, migrations, reporting views, crypto, demo seed
- `packages/engine` — pure budget engine (YNAB-equivalent) + golden tests
- `packages/connectors` — simplefin, mercury, coinbase, river, fidelity-csv, rentcast, ynab, gusto, csv, amortization
- `packages/categorizer` — payee normalization, rules, history, AI categorization pipeline
- `packages/ai` — Claude client, prompts, agent tools, usage accounting, redaction
- `infra/` — docker-compose (app, worker, Postgres, backups, Tailscale sidecar, cloudflared, the public demo), Dockerfiles, tailscale serve config, whisper launchd, scripts

## Commands
- `pnpm install` · `pnpm test` · `pnpm typecheck` · `pnpm lint`
- `pnpm db:dev` — local Postgres (Homebrew postgres@16) on port 54329, data in `.dev/pgdata`
- `pnpm db:migrate` · `pnpm seed:demo` · `pnpm dev`

## Conventions
- Money is `bigint` milliunits everywhere ($1.00 = 1000n). Use `@homebase/shared` helpers. Never floats.
- Dates are `YYYY-MM-DD` strings in America/New_York; months are `YYYY-MM-01`.
- TypeScript strict; Zod at every boundary (env, API, AI output).
- Workspace packages export TypeScript source directly (`exports: ./src/index.ts`); no build step for packages.
- Every page, `generateMetadata` and route handler under `apps/web/src/app/(app)` checks the session itself as its first statement (`requireUser()` / `requireAdmin()`; route handlers `getCurrentUser()` / `apiUser()`). The layout's check isn't enough; `src/server/page-auth.test.ts` enforces it.
- The demo seed, fixtures, tests and docs are fictional: made-up people (Alex and Sam), business (Northwind Studio), amounts, towns, addresses, merchants and banks (Contoso, Woodgrove, Fabrikam, Litware, Proseware). App code and UI text name no household: "the admin", "the business". Keep it that way.

## Never
- floats for money
- write calls to any financial API (YNAB, banks, Mercury, Coinbase, Gusto). Only exception: SimpleFIN one-time claim POST.
- commit secrets, real transactions or YNAB exports (`fixtures/private/` is gitignored), or the household's real names, places, banks, hostnames and figures
- open inbound ports: no port forwards, no Tailscale Funnel. The only ways in are Tailscale Serve (tailnet) and the outbound-only Cloudflare Tunnel (the app's own sign-in, and the demo).
- AI writes without user confirmation
- send account numbers to the LLM
