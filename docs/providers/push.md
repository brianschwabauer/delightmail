# Web push (VAPID)

Generate a VAPID keypair (e.g. with `web-push generate-vapid-keys`, or any P-256
generator producing base64url keys):

```
VAPID_PUBLIC_KEY="<base64url uncompressed P-256 public key>"
VAPID_PRIVATE_KEY="<base64url raw private key>"
VAPID_SUBJECT="mailto:you@example.com"
```

Then Settings → Appearance → **Enable push notifications** on each device. iOS
requires the PWA installed to the Home Screen (16.4+). Omit the keys to disable
push entirely.
