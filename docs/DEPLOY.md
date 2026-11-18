# Deployment

Any Node host works (VPS, Render, Railway, Fly.io…). The backend is one process; state lives in Firebase.

**VPS + systemd + nginx**
```ini
# /etc/systemd/system/aryan.service
[Service]
WorkingDirectory=/srv/aryan/backend
ExecStart=/usr/bin/node server.js
Restart=always
User=aryan
EnvironmentFile=/srv/aryan/backend/.env
```
nginx: `proxy_pass http://127.0.0.1:3000;` with `proxy_set_header X-Forwarded-For $remote_addr;`, TLS via certbot, and set `TRUST_PROXY=1`.

**Checklist**
- HTTPS only; `PUBLIC_URL` is the https URL (payment return + webhook URLs are built from it).
- `NODE_ENV=production`, secrets from environment / secret manager, `.env` and service-account file `chmod 600`.
- Firebase rules deployed (deny-all). Open Admin → Security Settings: every check should be green.
- Uploaded media: with `DB_DRIVER=firebase` files go to Firebase Storage (set `FIREBASE_STORAGE_BUCKET`).
- Payment webhooks: give each provider `https://your-domain/webhooks/payment/<gatewayId>` (shown on the gateway card). Webhooks never credit by themselves; the server always re-verifies with the provider.
- Telegram: Admin → Telegram Bot → Set webhook (needs HTTPS PUBLIC_URL).
- Keep one running instance (rate limiter and cache are in-memory) or put a shared limiter in front.
