# Self-hosting DelightMail

DelightMail runs entirely in **your** Cloudflare account. The only data that ever
leaves it is (a) calls to your chosen AI provider (which see truncated message
text, and only if you enable triage) and (b) standard mail protocols. No
telemetry. AI triage can be turned off entirely.

A personal instance costs about **$5/mo** (Workers Paid) plus pennies of R2/AI.

## 0. Prerequisites

- A Cloudflare account (Workers **Paid** plan — Durable Objects + Email need it).
- Node 22+ and `pnpm`, and `wrangler` (`npx wrangler login`).
- A domain on Cloudflare if you want vanity addresses (optional).

## 1. Clone + install

```sh
git clone https://github.com/brianschwabauer/mail.brianschwabauer.com delightmail
cd delightmail
pnpm install
cp server/.dev.vars.example server/.dev.vars   # dev works with the defaults
```

## 2. Create resources

```sh
wrangler r2 bucket create delightmail
wrangler kv namespace create CACHE      # copy the id into BOTH wrangler configs
```

Put the KV namespace id in `wrangler.jsonc` (`kv_namespaces`) and
`server/wrangler.toml` (`[[kv_namespaces]]`), replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

## 3. Generate + push secrets

Required for anything to work:

```sh
openssl rand -hex 32   # → JWT_KEY_SECRET (same value on both workers)
openssl rand -hex 32   # → CREDENTIALS_ENCRYPTION_KEY
```

Create a `secrets.env` (git-ignored) and push to both workers:

```
JWT_KEY_SECRET="<hex from above>"
CREDENTIALS_ENCRYPTION_KEY="<hex from above>"
OWNER_EMAIL="you@example.com"
MAIL_FROM="mail@yourdomain.com"
```

```sh
pnpm run secrets secrets.env
```

`PUBLIC_APP_URL` and other non-secret tunables go in the wrangler config `vars`.

## 4. Deploy (server FIRST)

The app worker binds the Durable Objects cross-script, so the server must exist
first:

```sh
cd server && wrangler deploy      # delightmail-server
cd .. && pnpm build && wrangler deploy   # delightmail (the app)
```

Point `mail.yourdomain.com` at the app worker (Workers → your worker → Custom
Domains), sign in with your `OWNER_EMAIL`, and connect accounts.

The startup env check logs exactly what's missing or misconfigured — read the
worker logs after the first request if sign-in doesn't work.

## Provider setup (all optional)

Every external dependency is optional except Cloudflare itself.

### Gmail (OAuth + Gmail API) — `docs/providers/gmail.md`

`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. Set the OAuth consent screen to **In
production** (do NOT complete verification for personal use) so refresh tokens
don't expire every 7 days. Add push with `GMAIL_PUBSUB_TOPIC` /
`GMAIL_PUSH_AUDIENCE` / `GMAIL_PUSH_SA_EMAIL`, or omit them to poll.

### Custom domain (Email Routing + Email Service) — `docs/providers/domain.md`

Add the domain to **Email Routing**, enable **catch-all → Send to Worker →
`delightmail-server`**. Register it in Settings → Accounts. For sending, onboard
the domain to **Email Service**, or point it at any SMTP relay via `SMTP_RELAY_*`.

### AI triage (AI Gateway) — `docs/providers/ai.md`

Create an AI Gateway with a **dynamic route** named `email-triage`. Set
`AI_GATEWAY_NAME` (+ `AI_TRIAGE_ROUTE=dynamic/email-triage`). Pick the actual
model in the dashboard — swap it anytime with no deploy.

### Web push — `docs/providers/push.md`

Generate a VAPID keypair and set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` /
`VAPID_SUBJECT`. Omit to disable push.

### IMAP/SMTP

Any provider with an app password. **Note (R1):** IMAP over Workers sockets is
gated on a compatibility spike — the connection test in Settings → Accounts tells
you whether it works on your deployment.

## Environment variable reference

See the table in the top-level `README.md`.
