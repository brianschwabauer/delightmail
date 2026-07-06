# Custom domain (kill Google Workspace)

1. Add your domain to Cloudflare → **Email → Email Routing**. Cloudflare sets the
   MX + SPF records automatically.
2. Enable the **catch-all** rule → action **Send to a Worker** → `delightmail-server`.
3. In DelightMail → Settings → Accounts, add the domain. This maps the domain to
   your mailbox so inbound mail routes to you; first-seen aliases auto-create
   identities (catch-all ⇒ infinite addresses).

### Sending
- **Email Service** (recommended): onboard the domain in the Cloudflare dashboard
  (DKIM/SPF/DMARC managed for you). The `EMAIL` send binding is already declared.
- **Or any SMTP relay** (Resend/Postmark/SES): set `SMTP_RELAY_HOST/PORT/USER/PASS`.

Verify deliverability with mail-tester.com — you want passing DKIM/SPF/DMARC.
