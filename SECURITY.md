# Security Policy

## Reporting a vulnerability
Please email **brian@showandtour.com** with details. Do not open a public issue
for security problems. We aim to acknowledge within 72 hours.

## Posture
- Secrets (OAuth refresh tokens, IMAP passwords) are AES-GCM encrypted under
  `CREDENTIALS_ENCRYPTION_KEY` before touching DO storage; decrypted only inside
  the SyncEngine at use time.
- Email HTML is sanitized at ingest AND rendered inside a sandboxed, CSP-pinned
  iframe — scripts can never execute even if sanitization misses something.
- Webhooks are OIDC-verified; `email()` is platform-authenticated. Both are
  idempotent, so replay is harmless.
- The AI model only ever returns JSON — no tools, no send, no permanent deletes.
- Tenant isolation is structural: each user's mail lives in its own Durable Object
  (separate SQLite file); R2 keys are org-prefixed and never public.
