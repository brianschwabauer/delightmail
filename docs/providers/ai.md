# AI triage (AI Gateway)

1. Cloudflare → **AI → AI Gateway** → create a gateway (e.g. `delightmail`).
2. Add a **dynamic route** named `email-triage`. In its visual editor pick the
   real model (any provider), add fallback chains / budgets / A-B splits.
3. Set `AI_GATEWAY_NAME=delightmail` and `AI_TRIAGE_ROUTE=dynamic/email-triage`.
   Provider keys live in the gateway's BYOK store, not in the app.
4. In Settings → AI, enable triage, choose a mode (quarantine recommended), edit
   your policy, and "Test against recent mail".

Swap models anytime in the dashboard — **zero code deploys**, instant rollback.
Guardrails (never trash known correspondents, never act on urgent mail, a
confidence floor, JSON-only output with no tools) are enforced in code regardless
of the model.
