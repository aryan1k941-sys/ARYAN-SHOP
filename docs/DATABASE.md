# Database structure & migration

All existing paths are preserved: `users/`, `store_products/`, `store_management/`, `key_stock/`, `transactions/`, `auto_payments/`, `auto_payment_settings/`, `site_settings/maintenance`, `product_maintenance/`.

## New / extended paths
| Path | Purpose |
|---|---|
| `store_products/{key}/pid, category, status, description, imageUrl, thumbnailUrl, bannerUrl, videoUrl, …` | PID ID + product fields (NAME, PID ID, PRICE via plans, DURATION, STATUS, CATEGORY, DESCRIPTION) |
| `store_management/{key}/{planKey}` `{daysPlan, priceRate, resellerPrice}` | DURATION + PRICE per plan (unchanged) |
| `pid_index/{pid}` | unique PID lock |
| `pid_mappings/{id}`, `pid_map_index/*` | supplier PID → ARYAN plan mapping, cost, priority, duplicate prevention |
| `suppliers/{id}` | supplier config; secrets AES-256-GCM encrypted |
| `payment_gateways/{id}` | gateway config; secrets encrypted |
| `orders/{id}`, `order_idem/*` | orders + idempotency |
| `api_clients/{id}`, `api_logs/*`, `api_usage/*` | REST API keys (hashed), logs, usage |
| `telegram_settings`, `telegram_links/*` | bot settings (token encrypted), link codes |
| `branding`, `media/{id}` | logo/favicon/banners, media library |
| `usernames/*`, `emails/*` | unique login indexes |
| `admin_roles/*`, `admin_audit/*`, `admin_security/epoch` | admin roles, audit trail, logout-all |
| `tickets/*`, `announcements/*` | support & announcements |

## Migration (`npm run migrate`, idempotent, additive)
`--dry-run` shows the plan. It: hashes plain-text passwords (scrypt) and removes the plain text; builds username/e-mail indexes; assigns a PID to every product lacking one; moves `supplier_settings` into an encrypted supplier (+ mappings for products that had `supplierPid`; cost is set to 0 — set real costs in Admin → PID Management); moves `auto_payment_settings.apiKey` into the encrypted ZapUPI gateway; copies legacy per-user transactions into the global ledger. Nothing is renamed or deleted. `--purge-legacy` additionally removes the old plain-text keys **after** you verified everything.

## Firebase rules
`firebase/database.rules.json` denies all client access. Only the backend (Admin SDK) reads/writes. The previous client-side-only design cannot be secured with rules, which is why the new HTML talks to the backend API.
