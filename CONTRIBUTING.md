# Contributing

DelightMail is MIT-licensed and doubles as the flagship dogfood app for the
[delightstack](https://github.com/brianschwabauer/delightstack) toolkit.

## Layout
- `src/` — SvelteKit app worker (UI + `/api/*`). `src/lib/mail/*` is the pure,
  exhaustively-tested domain layer (no I/O).
- `server/src/` — the DO-hosting worker (MailboxServer, SyncEngine, adapters).
- `docs/` — self-hosting + provider walkthroughs.

## Dev
```sh
pnpm install
pnpm dev:worker   # terminal 1 — DOs + dev RPC bridge (port 8787)
pnpm dev          # terminal 2 — the app (port 5174)
```
Set `CLOUDFLARE_ACCOUNT_ID` if your machine has multiple CF accounts.

## Before a PR
```sh
pnpm check   # svelte-check (app) + tsc (server)
pnpm test    # vitest — keep the domain layer at 100% intent coverage
pnpm build
```

## Rules of the road
- New mail logic goes in `src/lib/mail/*` as a **pure, tested** function; the DO
  glue calls it. This keeps the risky parts unit-testable.
- The AI never gets tools — it returns JSON; only the app takes actions.
- Never lose mail: capture raw to R2 before parsing in every ingest path.
