# AI triage

## Claude (recommended)

1. Create an API key at platform.claude.com.
2. Set it on the **server** worker:
   `npx wrangler secret put ANTHROPIC_API_KEY --config server/wrangler.jsonc`
   (and `ANTHROPIC_API_KEY="…"` in `server/.dev.vars` for local dev).
3. In Settings → AI, enable triage, choose a mode (quarantine recommended), edit
   your policy, and "Test against recent mail".

Triage asks Claude Haiku 5.5 first and gets a second opinion from Claude
Sonnet 5.5 only when Haiku wants to move a message but isn't sure. Most mail never
reaches a model: people you've written to, threads you've replied in, your rules
and the built-in notification rules (npm, Sentry, GitHub bots, …) are decided in
code. Settings → AI shows the per-model token and dollar totals.

## AI Gateway (alternative)

Without `ANTHROPIC_API_KEY`, triage uses a Cloudflare AI Gateway dynamic route:

1. Cloudflare → **AI → AI Gateway** → create a gateway (e.g. `delightmail`).
2. Add a **dynamic route** named `email-triage` and pick the model there.
3. Set `AI_GATEWAY_NAME=delightmail` and `AI_TRIAGE_ROUTE=dynamic/email-triage`.

Guardrails (never trash known correspondents, never act on urgent mail, a
confidence floor, JSON-only output with no tools) are enforced in code regardless
of the model.
