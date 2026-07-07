# DelightMail

A keyboard-first, ad-free, self-hostable email client on Cloudflare — unifying
multiple Gmail accounts, custom-domain vanity addresses, and an AI triage layer
that keeps marketing noise out of the inbox.

Built on [delightstack](https://github.com/brianschwabauer/delightstack)
(SvelteKit + Cloudflare Workers + Durable Objects). MIT licensed. The full build
specification lives in [`PLAN.html`](./PLAN.html).

> Working title. The deployed instance is simply **"Mail"** in the UI.

## Why

Replace the Gmail *interface* (ads, upsells, no multi-account) — not the Gmail
*infrastructure* — with one calm, extremely fast, fully-owned client, and use the
same app for custom-domain mail so the Google Workspace subscription can go away.

- ⚡ **Fast by construction** — every navigation renders from a local IndexedDB +
  Orama mirror in <100ms; the network is consulted after paint.
- ⌨️ **Keyboard-first, yazi-inspired** — `j/k` navigate, single letters act
  (`a` archive, `d` trash, `r` reply…), `g`-chords jump, `Ctrl+K` command palette,
  `?` help.
- 🧘 **Calm** — AI triage moves noise out before you see it, with a reviewable
  quarantine and full audit trail so nothing important is silently lost.
- 🔓 **Own the archive** — every message is permanently mirrored to your own R2 +
  SQLite; if a Gmail account closes tomorrow, nothing is lost.
- 📱 **An app, not a tab** — installable PWA with offline reading + web push.

## Status

Implemented against `PLAN.html` §15 milestones (each verified: typecheck + unit
tests + production build; core flows exercised in a real browser):

| Phase | Scope | State |
| ----- | ----- | ----- |
| P0 | Foundation — scaffold, auth (magic link + passkeys), org bootstrap, mail shell, CI | ✅ |
| P1 | Read path — Gmail mirror + virtualized list/read UI + core keys | ✅ |
| P2 | Action path — optimistic two-way sync + undo + full keyboard + command palette | ✅ |
| P3 | Compose & send — editor, reply/fwd threading, outbox + undo-send, Gmail transport | ✅ |
| P4 | Custom domain — Email Routing ingest + Email Service/SMTP outbound | ✅ |
| P5 | AI triage & unsubscribe — gateway dynamic route, guardrails, quarantine, audit | ✅ |
| P6 | PWA & mobile — service worker, offline, web push, swipe actions | ✅ |
| P7 | Generic IMAP/SMTP — add-account + adapter (live polling gated on the R1 spike) | ◑ |
| P8 | Open-source release — docs, env validation, secrets script, CI | ✅ |

Live-infrastructure paths (Gmail sync, Email Routing, AI Gateway, web push,
deploy) are implemented and typecheck/bundle, but need the corresponding
credentials/config to fully exercise — see [`docs/SELF_HOSTING.md`](./docs/SELF_HOSTING.md).

## Architecture

Two Cloudflare Workers (see `PLAN.html` §2):

- **App worker** (root) — SvelteKit UI + `/api/*` routes.
- **Server worker** (`server/`) — hosts all Durable Objects (`MailboxServer`
  per user, `SyncEngine` per account, `AuthServer`, `AppWebsocketServer`,
  `RateLimiterServer`) plus the inbound `email()` handler and Gmail webhook.

The app binds the DOs cross-script via `script_name`, so **the server deploys
first**. Pure, unit-tested mail logic (MIME, threading, sanitize, unsubscribe,
identity, compose, triage) lives in `src/lib/mail/*` and is shared by both.

## Develop

```sh
pnpm install
cp server/.dev.vars.example server/.dev.vars   # dev works with the defaults
export CLOUDFLARE_ACCOUNT_ID=<id>   # if your machine has multiple CF accounts

pnpm dev:worker    # terminal 1 — DO-hosting server worker + dev RPC bridge (:8787)
pnpm dev           # terminal 2 — the SvelteKit app (:5174)
```

Open http://localhost:5174, enter your `OWNER_EMAIL`. First contact creates a
passwordless account and signs you in; then register a passkey or use magic
links. (Magic-link emails are logged to the server-worker console in dev.)

> Leave `JWT_KEY_SECRET` unset in `server/.dev.vars` so the app and the AuthServer
> DO share the same fallback secret in dev.

## Checks

```sh
pnpm check     # svelte-check (app) + tsc (server)
pnpm test      # vitest — pure mail domain logic (128 tests)
pnpm build     # production build (both workers)
```

## Deploy

Full guide + provider walkthroughs: [`docs/SELF_HOSTING.md`](./docs/SELF_HOSTING.md).
Short version:

```sh
wrangler r2 bucket create delightmail
wrangler kv namespace create CACHE          # id → both wrangler configs
pnpm run secrets secrets.env                # push JWT/credentials/OWNER_EMAIL/…
wrangler deploy --config server/wrangler.toml   # server FIRST (explicit config)
pnpm build && wrangler deploy                    # then the app (root config)
```

## Environment variables

| Variable | Req. | Purpose |
| --- | --- | --- |
| `PUBLIC_APP_URL` | ✓ | Canonical origin, e.g. `https://mail.example.com` |
| `JWT_KEY_SECRET` | ✓ | Auth signing secret — 64-char hex (`openssl rand -hex 32`), **same on both workers** |
| `CREDENTIALS_ENCRYPTION_KEY` | ✓ | AES-GCM key for stored mail credentials — 64-char hex |
| `OWNER_EMAIL` / `SIGNUPS_ENABLED` | ✓ / – | Signup allowlist; multi-tenant switch (default closed) |
| `MAIL_FROM` | ✓ | Transactional sender for magic links (via EMAIL binding or SMTP relay) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | – | Gmail OAuth (omit → Gmail connect hidden) |
| `GMAIL_PUBSUB_TOPIC` / `GMAIL_PUSH_AUDIENCE` / `GMAIL_PUSH_SA_EMAIL` | – | Gmail push (omit → poll every `GMAIL_POLL_SECONDS`, default 90) |
| `AI_GATEWAY_NAME` / `AI_TRIAGE_ROUTE` | – | AI triage via a gateway dynamic route (§7.1) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | – | Web push |
| `SMTP_RELAY_HOST/PORT/USER/PASS` | – | Transactional + cf_domain sending without Email Service |
| `STRIPE_SECRET_KEY` / … | – | Billing (hosted mode only) |
| `SEND_DAILY_LIMIT` / `IMAGE_PROXY` / `GMAIL_FULL_SCOPE` | – | Tunables (defaults 100 / off / off) |

Bindings (in the wrangler configs, not secrets): `MAILBOX`, `SYNC`, `AUTH`, `WS`,
`RATE_LIMITER` (DOs); `R2`; `KV`; `AI`; `EMAIL` (send).

## License

MIT — see [`LICENSE`](./LICENSE). Contributions welcome; see
[`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`SECURITY.md`](./SECURITY.md).
