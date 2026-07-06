# Gmail setup

1. Create a Google Cloud project → **APIs & Services → Enabled APIs** → enable the
   **Gmail API**.
2. **OAuth consent screen**: External, add scopes `gmail.modify`, `gmail.send`,
   `openid`, `email`, `profile`. Set publishing status to **In production** and do
   NOT submit for verification — personal use keeps working (up to 100 users;
   one "unverified app" interstitial appears at connect time). Testing status
   would expire refresh tokens every 7 days.
3. **Credentials → OAuth client ID → Web application**. Authorized redirect URI:
   `https://mail.yourdomain.com/api/accounts/google/callback`.
4. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

### Realtime (optional)
Create a Pub/Sub topic, grant `gmail-api-push@system.gserviceaccount.com` the
Publisher role, and add a **push subscription** to
`https://server.yourdomain.com/webhooks/gmail` with OIDC auth. Set
`GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_AUDIENCE`, `GMAIL_PUSH_SA_EMAIL`. Omit to poll
every `GMAIL_POLL_SECONDS` (default 90).

> `gmail.modify` cannot hard-delete. `D` (delete forever) trashes remotely and
> hard-deletes locally. Set `GMAIL_FULL_SCOPE=on` to request full scope instead.
