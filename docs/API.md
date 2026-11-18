# REST API v1

Base: `https://your-domain/api/v1`. Auth: `Authorization: Bearer ak_…` (or `X-API-Key`). Keys are created in Admin → API Management or by Resellers in *API Access*. Per-key permissions (`products.read`, `balance.read`, `orders.create`, `orders.read`), IP allow-list, rate limit (`X-RateLimit-*`, 429 + `Retry-After`).
Errors: `{ "ok": false, "error": "…", "code": "…" }`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/products` | products.read | `?pid=151&category=ANDROID` |
| GET | `/balance` | balance.read | |
| POST | `/order` | orders.create | `{"pid":"151","duration":"1 HOUR","quantity":1}`; header `Idempotency-Key` prevents duplicates |
| GET | `/order/{order_id}` | orders.read | |
| GET | `/orders` | orders.read | `?page=1&limit=20&status=delivered` |

```bash
curl -X POST https://your-domain/api/v1/order \
  -H "Authorization: Bearer ak_YOUR_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" -d '{"pid":"151","duration":"1 HOUR","quantity":1}'
```
The same documentation is available live in Admin → API Documentation.
