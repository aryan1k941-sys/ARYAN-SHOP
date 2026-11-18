# Testing checklist

Automated: `cd backend && npm test` (23 tests: auth, no secret/supplier leakage, wallet concurrency, idempotency, payment verify-once/mismatch/duplicate UTR/fallback/webhook, supplier mapping/refund, API keys/permissions/IP/rate-limit, SSRF guard, CSP).

Manual (use the demo):
- [ ] User: register, login, wrong password rejected, forgot/reset, change password
- [ ] Marketplace shows NAME, PID ID, CATEGORY, STATUS, DURATION & price (U/R) — desktop table and mobile cards, nothing removed on mobile
- [ ] Search by name/PID, category + status filters, product details modal (all 7 labelled fields)
- [ ] Buy: insufficient balance blocked; success shows key, balance drops, order + key history updated; maintenance/inactive products blocked
- [ ] Wallet: with no gateway → “Backend not configured”; with a real gateway → pay, status check, credited exactly once
- [ ] Referral, Premium upgrade, Support ticket → admin reply visible, Telegram link code, API Access (show key needs password)
- [ ] Admin: all 26 pages open; add product with PID/price/duration; edit PID (duplicate rejected); price edit; duration rename; stock add/duplicate skip
- [ ] Supplier: add, test (“reachable, credentials NOT verified” unless balance endpoint configured), PID mapping 9876→151 shows profit
- [ ] Gateway: FAM Gateway cannot be enabled until configured from official docs; ZapUPI preset works
- [ ] API key: create, call each endpoint, revoke → 401; IP allow-list and rate-limit respond
- [ ] Add/Deduct balance writes ledger + audit; Security page checklist; logout-all admin
- [ ] View source of both HTML files: no keys, tokens, passwords
