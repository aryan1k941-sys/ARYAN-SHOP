'use strict';
/**
 * LOCAL DEMO ONLY.  node scripts/demo.js
 * Starts: (1) a mock supplier and (2) a mock UPI gateway (ZapUPI response format) on localhost, (3) the real ARYAN backend on :3000
 * with a throw-away JSON database seeded with DEMO data. The mocks exist only so the full flow can be tried offline - they are not used in production.
 *   User  : demo / demo1234          Reseller : reseller / reseller123
 *   Admin : admin@aryan.local / Admin@12345  (http://localhost:3000/admin)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'data-demo');
fs.rmSync(dir, { recursive: true, force: true });
process.env.DB_DRIVER = 'file'; process.env.DATA_DIR = dir; process.env.ALLOW_PRIVATE_URLS = '1'; process.env.ADMIN_AUTH = 'local';
process.env.ADMIN_LOCAL_EMAIL = 'admin@aryan.local'; process.env.PORT = process.env.PORT || '3000'; process.env.PAYMENT_POLL = '1';
const { hashPassword } = require('../src/lib');

const orders = new Map(); let seq = 1000;
const mockGw = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const q = Object.fromEntries(u.searchParams); const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/api/qr.php') { const id = 'ZP' + (++seq); orders.set(id, { amount: Number(q.amount), paid: false }); return send({ status: 'success', data: { order_id: id, checkout_url: `http://127.0.0.1:${mockGw.address().port}/pay/${id}`, amount: q.amount, payable_amount: q.amount } }); }
  if (u.pathname === '/api/verify-order.php') { const o = orders.get(q.order_id); if (!o) return send({ status: 'failed', message: 'not found' }); return send(o.paid ? { status: 'success', data: { amount: String(o.amount), utr: 'UTR' + q.order_id } } : { status: 'pending' }); }
  if (u.pathname.startsWith('/pay/')) { const id = u.pathname.split('/')[2]; if (req.method === 'GET' && u.searchParams.get('paid') === '1' && orders.has(id)) orders.get(id).paid = true; res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<body style="font-family:sans-serif;background:#0b0d14;color:#fff;padding:40px"><h2>DEMO payment page (mock gateway)</h2><p>Order ${id} - ₹${(orders.get(id) || {}).amount}</p><p>${orders.get(id) && orders.get(id).paid ? '✅ Marked as paid. Go back to ARYAN and press "Check status" (or wait ~20s).' : `<a style="color:#00e5ff" href="?paid=1">Simulate: I have paid</a>`}</p></body>`); }
  res.writeHead(404); res.end();
});
const mockSup = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const f = Object.fromEntries(new URLSearchParams(b)); res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.headers['x-master-key'] !== 'demo-master-key-456' || f.api_key !== 'demo-supplier-api-key-123') return res.end(JSON.stringify({ status: 'error', message: 'Invalid credentials' }));
    if (f.action !== 'buy') return res.end(JSON.stringify({ status: 'error', message: 'Unknown action' }));
    const n = parseInt(f.quantity, 10) || 1; res.end(JSON.stringify({ status: 'success', keys: Array.from({ length: n }, (_, i) => `SUP-${f.product_id}-${Math.random().toString(36).slice(2, 10).toUpperCase()}${i}`) }));
  });
});

(async () => {
  await new Promise((r) => mockGw.listen(0, '127.0.0.1', r)); await new Promise((r) => mockSup.listen(0, '127.0.0.1', r));
  process.env.ADMIN_LOCAL_PASSWORD_HASH = await hashPassword('Admin@12345');
  const { build } = require('../src/config'); const { build: buildApp } = require('../src/app'); const { seed } = require('./seed-demo');
  const cfg = build(); const { app, S } = buildApp(cfg);
  await seed(S, { supplierUrl: `http://127.0.0.1:${mockSup.address().port}/api/reseller_v1.php`, gatewayUrl: `http://127.0.0.1:${mockGw.address().port}` });
  app.server.listen(cfg.port, cfg.host, async () => { await S.start(); console.log(`\nARYAN DEMO running → http://localhost:${cfg.port}   (admin: /admin)\n  user: demo / demo1234   reseller: reseller / reseller123   admin: admin@aryan.local / Admin@12345\n`); });
})();
