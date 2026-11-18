# Installation

Requirements: Node.js 20+ (22 recommended). No `npm install` is needed for the demo; production adds one optional package (`firebase-admin`).

## 1. Try the demo (no Firebase, no secrets)
```bash
cd backend
npm run seed      # optional: creates demo data in ./data-demo
npm run demo      # http://localhost:3000
```
| Panel | URL | Login |
|---|---|---|
| User | `/` | `demo` / `demo1234` · reseller: `reseller` / `reseller123` |
| Admin | `/admin` | `admin@aryan.local` / `Admin@12345` |

The demo uses a local JSON database plus a **local mock supplier and mock UPI gateway so the flow can be clicked through offline**. These mocks exist only in `scripts/demo.js`; the real code paths are identical to production.

## 2. Production with your existing Firebase project
1. `cd backend && npm install` (installs `firebase-admin`).
2. Firebase console → Project settings → Service accounts → *Generate new private key* → save as `backend/service-account.json` (never commit it).
3. `cp .env.example .env`, then `npm run gen-secrets` and paste `JWT_SECRET` / `SECRETS_KEY`. **Back up SECRETS_KEY.**
4. Set `DB_DRIVER=firebase`, `PUBLIC_URL`, `ADMIN_EMAILS` (your Firebase Auth admin e-mail) and `FIREBASE_WEB_API_KEY`.
5. Migrate the existing data (see DATABASE.md): `npm run migrate -- --dry-run`, then `npm run migrate`.
6. Deploy `firebase/database.rules.json` (deny-all; only the backend touches data): `firebase deploy --only database`.
7. `npm start`. Open `/admin`, log in, and configure: Payment Gateways, Supplier Panels, Telegram, Branding.
8. **Revoke the Telegram bot token that was hard-coded in the old index.html** (BotFather → /revoke) and paste the new one in Admin → Telegram Bot.

`index.html` and `Admin.html` are served by the backend. To host them elsewhere set `<meta name="aryan-api-base" content="https://api.your-domain.com">` and `ALLOWED_ORIGINS`.

## Rebuilding the HTML
Sources are in `frontend-src/` (`shared.*`, `index.*`, `admin.*`). `python3 frontend-src/build.py` regenerates the two self-contained files.

## Payment gateways
On first start the backend creates **ZapUPI** (`http://pay.zapupi.com`, `/api/qr.php`, `/api/verify-order.php`) and **FAM Gateway** (`https://famgateway.in`) as *disabled* entries. Admin → Payment Gateways → ZapUPI → Edit → paste your API key → tick *Enabled* → Save, then press *Test*. FAM Gateway also needs its official endpoint/response details before it can be enabled.
