# ARYAN — Digital Products & Reseller Platform (upgraded)

```
index.html / Admin.html   self-contained user & admin panels (built from frontend-src/)
backend/                  Node.js API (zero dependencies; firebase-admin for production)
firebase/                 deny-all database & storage rules, firebase.json
docs/                     INSTALL, DEPLOY, DATABASE, API, TESTING
frontend-src/             editable sources + build.py
shots/                    demo screenshots (desktop + mobile)
```
Quick demo: `cd backend && npm run demo` → http://localhost:3000 (admin at /admin). See docs/INSTALL.md.

Honest limits: FAM Gateway and any supplier-specific balance/stock endpoints need the provider's official documentation/credentials — the panel shows “Not configured / Not connected” until you enter them, and never fakes success.
