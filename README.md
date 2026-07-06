# DelightMail

A keyboard-first, ad-free, self-hostable email client on Cloudflare — unifying
multiple Gmail accounts, custom-domain vanity addresses, and an AI triage layer
that keeps marketing noise out of the inbox.

Built on [delightstack](https://github.com/brianschwabauer/delightstack)
(SvelteKit + Cloudflare Workers + Durable Objects). MIT licensed. The full build
specification lives in [`PLAN.html`](./PLAN.html).

> Working title. The deployed instance is simply **"Mail"** in the UI.

## Status

Implemented incrementally against `PLAN.html` §15 milestones:

| Phase | Scope | State |
| ----- | ----- | ----- |
| P0 | Foundation — scaffold, auth (magic link + passkeys), org bootstrap, mail shell, CI | ✅ |
| P1 | Read path — Gmail mirror, list/read UI, core keys | in progress |
| P2 | Action path — two-way sync, full keyboard surface | — |
| P3 | Compose & send — Gmail transport | — |
| P4 | Custom domain — Email Routing + Email Service | — |
| P5 | AI triage & unsubscribe | — |
| P6 | PWA & mobile | — |
| P7 | Generic IMAP/SMTP | — |
| P8 | Open-source release | — |

## Architecture

Two Cloudflare Workers (see `PLAN.html` §2):

- **App worker** (root) — SvelteKit UI + `/api/*` routes.
- **Server worker** (`server/`) — hosts all Durable Object classes
  (`MailboxServer`, `SyncEngine`, `AuthServer`, `AppWebsocketServer`,
  `RateLimiterServer`) plus the inbound `email()` handler and Gmail webhook.

The app binds the DOs cross-script via `script_name`, so **the server deploys
first**.

## Develop

```sh
pnpm install
cp server/.dev.vars.example server/.dev.vars   # dev works with defaults

# If your machine has multiple Cloudflare accounts, export the one to use
# (the AI binding forces a remote proxy that must pick an account):
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>

# terminal 1 — the DO-hosting server worker (also the dev RPC bridge)
pnpm dev:worker

# terminal 2 — the SvelteKit app
pnpm dev
```

Open http://localhost:5174 and enter your `OWNER_EMAIL`. First contact creates a
passwordless account and signs you straight in; afterward you can register a
passkey or use a magic link. (Real magic-link emails need a mail provider; in
dev the link is logged to the server-worker console.)

> Dev note: leave `JWT_KEY_SECRET` unset in `server/.dev.vars` so the app and the
> AuthServer DO share the same fallback secret. In production, `wrangler secret
> put JWT_KEY_SECRET` the same value on **both** workers.

## Checks

```sh
pnpm check     # svelte-check (app)
pnpm test      # vitest — pure mail domain logic (threading, actions, views…)
pnpm build     # production build
```

## Deploy

See `PLAN.html` §13 (full deploy guide + provider walkthroughs land in P8).
Short version:

```sh
wrangler r2 bucket create delightmail
wrangler kv namespace create CACHE        # put the id in both wrangler configs
cd server && wrangler deploy              # server FIRST
cd .. && pnpm build && wrangler deploy     # then the app
```
