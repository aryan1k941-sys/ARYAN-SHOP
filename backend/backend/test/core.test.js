'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aryan-test-'));
Object.assign(process.env, { DB_DRIVER: 'file', DATA_DIR: dir, ALLOW_PRIVATE_URLS: '1', ADMIN_AUTH: 'local', ADMIN_LOCAL_EMAIL: 'admin@test.local', PAYMENT_POLL: '0', NODE_ENV: 'test' });
const L = require('../src/lib');
const { build } = require('../src/config');
const { build: buildApp } = require('../src/app');
const { seed } = require('../scripts/seed-demo');

let S, base, gw, sup, gwOrders = new Map(), supMode = 'ok', supCalls = 0, gwDown = false;
const api = async (method, url, body, token, headers = {}) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j, headers: r.headers };
};
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test.before(async () => {
  process.env.ADMIN_LOCAL_PASSWORD_HASH = await L.hashPassword('Admin@12345');
  gw = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const q = Object.fromEntries(u.searchParams); const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (gwDown) { res.writeHead(500); return res.end('down'); }
    if (u.pathname === '/api/qr.php') { const id = 'G' + (gwOrders.size + 1); gwOrders.set(id, { amount: Number(q.amount), status: 'pending', utr: '' }); return send({ status: 'success', data: { order_id: id, checkout_url: 'http://pay.test/' + id, amount: q.amount, payable_amount: q.amount } }); }
    if (u.pathname === '/api/verify-order.php') { if (q.api_key !== 'gwkey') return send({ status: 'unauthorized' }); const o = gwOrders.get(q.order_id); if (!o) return send({ status: 'failed' }); return send(o.status === 'success' ? { status: 'success', data: { amount: String(o.reportAmount ?? o.amount), utr: o.utr } } : { status: o.status }); }
    res.writeHead(404); res.end();
  });
  sup = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { supCalls++; const f = Object.fromEntries(new URLSearchParams(b)); res.writeHead(supMode === 'http500' ? 500 : 200, { 'Content-Type': 'application/json' }); if (supMode !== 'ok') return res.end(JSON.stringify({ status: 'error', message: 'Supplier stock empty' })); res.end(JSON.stringify({ status: 'success', keys: Array.from({ length: +f.quantity }, (_, i) => `SUPKEY-${f.product_id}-${i}`) })); }); });
  const gp = await listen(gw), sp = await listen(sup);
  const cfg = build(); const built = buildApp(cfg, { logger: { log() {}, warn() {}, error() {} } }); S = built.S;
  await seed(S, { supplierUrl: `http://127.0.0.1:${sp}/api`, gatewayUrl: `http://127.0.0.1:${gp}` });
  await S.db.update('payment_gateways/GW_ZAPUPI', { secrets: { apiKeyEnc: L.encrypt('gwkey') } });
  const port = await listen(built.app.server); base = `http://127.0.0.1:${port}`;
});
test.after(() => { S.stop(); gw.close(); sup.close(); S.cfg && 0; setTimeout(() => process.exit(0), 100); });

let tokenUser, uidUser;
test('register, duplicate username blocked, login, wrong password', async () => {
  const r = await api('POST', '/api/auth/register', { name: 'Test', email: 't@x.com', username: 'tester', password: 'secret1' });
  assert.equal(r.status, 200); tokenUser = r.body.token; uidUser = r.body.uid;
  assert.equal((await api('POST', '/api/auth/register', { name: 'T2', email: 't2@x.com', username: 'TESTER', password: 'secret1' })).status, 409);
  assert.equal((await api('POST', '/api/auth/login', { username: 'tester', password: 'bad' })).status, 401);
  const ok = await api('POST', '/api/auth/login', { username: 'tester', password: 'secret1' }); assert.equal(ok.status, 200);
  const u = await S.db.get(`users/${uidUser}`); assert.ok(u.passwordHash && !u.password, 'password stored hashed only');
  const me = await api('GET', '/api/me', null, tokenUser); assert.equal(me.body.user.balance, 0); assert.equal(me.body.user.passwordHash, undefined);
});

test('legacy plain-text password account is upgraded on first login', async () => {
  await S.db.set('users/UID-9-legacy', { username: 'legacy', email: 'Legacy@Old.com', password: 'oldpass1', balance: 5, role: 'User', status: 'Active' });
  assert.equal((await api('POST', '/api/auth/login', { username: 'legacy', password: 'wrong' })).status, 401);
  assert.equal((await api('POST', '/api/auth/login', { username: 'legacy', password: 'oldpass1' })).status, 200);
  const u = await S.db.get('users/UID-9-legacy'); assert.ok(u.passwordHash); assert.equal(u.password, undefined);
});

test('products list shows NAME, PID ID, price, duration and never leaks stock keys or supplier data', async () => {
  const r = await api('GET', '/api/products', null, tokenUser); assert.equal(r.status, 200);
  const p = r.body.products.find((x) => x.pid === '151'); assert.equal(p.name, 'BALA MODS 151'); assert.equal(p.plans[0].duration, '1 HOUR'); assert.equal(p.plans[0].price, 15);
  const txt = JSON.stringify(r.body); assert.ok(!txt.includes('DEMO-152'), 'no keys'); assert.ok(!txt.includes('supplier'), 'no supplier info'); assert.ok(!txt.includes('9876'));
  assert.equal(r.body.products.find((x) => x.pid === '152').plans[0].delivery, 'STOCK');
});

test('purchase: insufficient funds -> 402 and nothing deducted / no order left', async () => {
  const before = Object.keys((await S.db.get('orders')) || {}).length;
  const r = await api('POST', '/api/orders', { pid: '152', duration: '1 DAY', qty: 1 }, tokenUser); assert.equal(r.status, 402);
  assert.equal(Object.keys((await S.db.get('orders')) || {}).length, before); assert.equal(await S.db.get(`users/${uidUser}/balance`), 0);
});

test('deposit: server verifies with provider, credits exactly once, replays are harmless', async () => {
  const c = await api('POST', '/api/payments', { amount: 100, phone: '9876543210' }, tokenUser); assert.equal(c.status, 200, JSON.stringify(c.body));
  const id = c.body.payment.id; assert.equal(c.body.payment.status, 'pending');
  // user "returns to the site" without paying -> NOT credited
  let v = await api('POST', `/api/payments/${id}/verify`, null, tokenUser); assert.equal(v.body.payment.status, 'pending'); assert.equal(v.body.balance, 0);
  const gid = (await S.db.get(`auto_payments/${id}`)).gatewayOrderId; gwOrders.get(gid).status = 'success'; gwOrders.get(gid).utr = 'UTR123';
  v = await api('POST', `/api/payments/${id}/verify`, null, tokenUser); assert.equal(v.body.payment.status, 'success'); assert.equal(v.body.balance, 100);
  await Promise.all([1, 2, 3, 4].map(() => api('POST', `/api/payments/${id}/verify`, null, tokenUser)));
  assert.equal(await S.db.get(`users/${uidUser}/balance`), 100, 'credited once only');
  const tx = Object.values((await S.db.get(`users/${uidUser}/transactions`)) || {}).filter((t) => t.type === 'Deposit'); assert.equal(tx.length, 1);
});

test('deposit: amount mismatch is not credited; duplicate UTR is not credited', async () => {
  const c = await api('POST', '/api/payments', { amount: 50, phone: '9876543210' }, tokenUser); const id = c.body.payment.id; const gid = (await S.db.get(`auto_payments/${id}`)).gatewayOrderId;
  Object.assign(gwOrders.get(gid), { status: 'success', utr: 'UTR-MM', reportAmount: 5 });
  assert.equal((await api('POST', `/api/payments/${id}/verify`, null, tokenUser)).body.payment.status, 'mismatch');
  await S.db.set('auto_payments/' + id + '/status', 'cancelled');
  const c2 = await api('POST', '/api/payments', { amount: 60, phone: '9876543210' }, tokenUser); const id2 = c2.body.payment.id; const g2 = (await S.db.get(`auto_payments/${id2}`)).gatewayOrderId;
  Object.assign(gwOrders.get(g2), { status: 'success', utr: 'UTR123' }); // same UTR as the earlier credited payment
  assert.equal((await api('POST', `/api/payments/${id2}/verify`, null, tokenUser)).body.payment.status, 'review');
  assert.equal(await S.db.get(`users/${uidUser}/balance`), 100);
});

test('gateway fallback: first gateway down -> next enabled gateway used', async () => {
  await S.db.update('payment_gateways/GW_ZAPUPI', { priority: 2 });
  const second = await S.db.get('payment_gateways/GW_ZAPUPI');
  await S.db.set('payment_gateways/GW_BACKUP', { ...second, name: 'Backup', priority: 1, baseUrl: 'http://127.0.0.1:1', enabled: true });
  const c = await api('POST', '/api/payments', { amount: 77, phone: '9876543210' }, tokenUser); assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal((await S.db.get(`auto_payments/${c.body.payment.id}`)).gatewayId, 'GW_ZAPUPI'); assert.equal(c.body.fallbackFrom.length, 1);
  await S.db.remove('payment_gateways/GW_BACKUP'); await S.db.update('payment_gateways/GW_ZAPUPI', { priority: 1 });
});

test('webhook: signature enforced when configured; body is never trusted (provider is asked)', async () => {
  await S.db.update('payment_gateways/GW_ZAPUPI', { webhookHeader: 'x-signature', webhookOrderIdPath: 'order_id', secrets: { apiKeyEnc: L.encrypt('gwkey'), webhookSecretEnc: L.encrypt('whsec') } });
  const c = await api('POST', '/api/payments', { amount: 120, phone: '9876543210' }, tokenUser); const id = c.body.payment.id; const gid = (await S.db.get(`auto_payments/${id}`)).gatewayOrderId;
  const body = JSON.stringify({ order_id: gid, status: 'success' });
  assert.equal((await fetch(`${base}/webhooks/payment/GW_ZAPUPI`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
  assert.equal((await fetch(`${base}/webhooks/payment/GW_ZAPUPI`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': 'deadbeef' }, body })).status, 401);
  const sig = crypto.createHmac('sha256', 'whsec').update(body).digest('hex'); const before = await S.db.get(`users/${uidUser}/balance`);
  let r = await fetch(`${base}/webhooks/payment/GW_ZAPUPI`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': sig }, body }); assert.equal(r.status, 200);
  assert.equal(await S.db.get(`users/${uidUser}/balance`), before, 'valid signature + body claiming success still not credited: provider says pending');
  Object.assign(gwOrders.get(gid), { status: 'success', utr: 'UTR-WH' });
  r = await fetch(`${base}/webhooks/payment/GW_ZAPUPI`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': sig }, body }); assert.equal((await r.json()).status, 'success');
  assert.equal(await S.db.get(`users/${uidUser}/balance`), before + 120);
});

test('purchase from stock: debit, key delivered, ledger + order, no double spend under concurrency', async () => {
  await S.db.update(`users/${uidUser}`, { balance: 100 });
  const rs = await Promise.all(Array.from({ length: 5 }, () => api('POST', '/api/orders', { pid: '152', duration: '1 DAY', qty: 1 }, tokenUser)));
  const okc = rs.filter((r) => r.status === 200).length; assert.equal(okc, 3, 'only 3 x ₹30 fit into ₹100'); assert.equal(rs.filter((r) => r.status === 402).length, 2);
  assert.equal(await S.db.get(`users/${uidUser}/balance`), 10);
  const keys = rs.filter((r) => r.status === 200).map((r) => r.body.keys[0]); assert.equal(new Set(keys).size, 3, 'each key delivered once');
  const o = rs.find((r) => r.status === 200).body.order; assert.equal(o.pid, '152'); assert.equal(o.status, 'delivered');
  const tx = Object.values((await S.db.get(`users/${uidUser}/transactions`)) || {}).filter((t) => t.type === 'Generation'); assert.equal(tx.length, 3);
});

test('idempotency: same key returns same order and charges once', async () => {
  await S.db.update(`users/${uidUser}`, { balance: 100 });
  const a = await api('POST', '/api/orders', { pid: '152', duration: '1 DAY', qty: 1, idempotencyKey: 'abc-1' }, tokenUser); const b = await api('POST', '/api/orders', { pid: '152', duration: '1 DAY', qty: 1, idempotencyKey: 'abc-1' }, tokenUser);
  assert.equal(a.status, 200); assert.equal(b.body.duplicate, true); assert.equal(a.body.order.id, b.body.order.id); assert.equal(await S.db.get(`users/${uidUser}/balance`), 70);
});

test('supplier route + PID mapping: supplier PID differs from ARYAN PID, cost/profit recorded', async () => {
  await S.db.update(`users/${uidUser}`, { balance: 100 }); supCalls = 0; supMode = 'ok';
  const r = await api('POST', '/api/orders', { pid: '151', duration: '1 HOUR', qty: 2 }, tokenUser); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.keys, ['SUPKEY-9876-0', 'SUPKEY-9876-1'], 'supplier PID 9876 used, not 151');
  assert.equal(r.body.order.total, 30); assert.equal(r.body.order.cost, 20); assert.equal(r.body.order.profit, 10); assert.equal(r.body.balance, 70);
});

test('supplier failure -> automatic refund + failed order + ledger entry', async () => {
  supMode = 'error'; const before = await S.db.get(`users/${uidUser}/balance`);
  const r = await api('POST', '/api/orders', { pid: '151', duration: '1 DAY', qty: 1 }, tokenUser); assert.equal(r.status, 502);
  assert.equal(await S.db.get(`users/${uidUser}/balance`), before, 'refunded');
  const o = Object.values(await S.db.get('orders')).find((x) => x.status === 'failed'); assert.ok(o);
  assert.ok(Object.values(await S.db.get(`users/${uidUser}/transactions`)).some((t) => t.type === 'Refund' && t.orderId === o.id)); supMode = 'ok';
  const logs = Object.values((await S.db.get('supplier_logs')) || {}); assert.ok(logs.every((l) => !JSON.stringify(l).includes('demo-supplier-api-key-123')), 'secrets never logged');
});

test('maintenance + inactive products cannot be bought', async () => {
  await S.db.update(`users/${uidUser}`, { balance: 1000 });
  assert.equal((await api('POST', '/api/orders', { pid: '67', duration: '1 DAYS', qty: 1 }, tokenUser)).status, 409);
  await S.db.set('store_products/BALA_MODS/status', 'INACTIVE'); assert.equal((await api('POST', '/api/orders', { pid: '152', duration: '1 DAY', qty: 1 }, tokenUser)).status, 409); await S.db.set('store_products/BALA_MODS/status', 'ACTIVE');
  await S.db.set('site_settings/maintenance', { enabled: true, message: 'brb' }); assert.equal((await api('POST', '/api/orders', { pid: '152', duration: '1 DAY', qty: 1 }, tokenUser)).status, 503); await S.db.remove('site_settings/maintenance');
});

let adminTok;
test('admin: login required, wrong password rejected, role enforced', async () => {
  assert.equal((await api('GET', '/api/admin/users')).status, 401); assert.equal((await api('GET', '/api/admin/users', null, tokenUser)).status, 401, 'user token is not an admin token');
  assert.equal((await api('POST', '/api/admin/login', { email: 'admin@test.local', password: 'nope' })).status, 401);
  const r = await api('POST', '/api/admin/login', { email: 'admin@test.local', password: 'Admin@12345' }); assert.equal(r.status, 200); adminTok = r.body.token;
  const us = await api('GET', '/api/admin/users', null, adminTok); assert.equal(us.status, 200); assert.ok(!JSON.stringify(us.body).includes('passwordHash')); assert.ok(!JSON.stringify(us.body).includes('"password"'));
});

test('admin: PID uniqueness, product CRUD, mapping duplicate prevention, profit calc', async () => {
  const dup = await api('POST', '/api/admin/products', { name: 'New Thing', pid: '151', plans: [{ duration: '1 DAY', price: 10, rprice: 8 }] }, adminTok); assert.equal(dup.status, 409);
  const ok = await api('POST', '/api/admin/products', { name: 'New Thing', pid: '900', category: 'TEST', plans: [{ duration: '1 DAY', price: 10, rprice: 8 }] }, adminTok); assert.equal(ok.status, 200);
  const pk = Object.keys(await S.db.get('store_management/New_Thing'))[0];
  const m = await api('POST', '/api/admin/mappings', { supplierId: 'SUP_DEMO', supplierPid: '777', supplierDuration: '1 Day', productKey: 'New_Thing', planKey: pk, cost: 6, sellPrice: 12, resellerPrice: 9 }, adminTok); assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal((await api('POST', '/api/admin/mappings', { supplierId: 'SUP_DEMO', supplierPid: '777', supplierDuration: '1 Day', productKey: 'New_Thing', planKey: pk, cost: 6 }, adminTok)).status, 409);
  const list = await api('GET', '/api/admin/mappings', null, adminTok); const row = list.body.mappings.find((x) => x.supplierPid === '777'); assert.equal(row.aryanPid, '900'); assert.equal(row.sellPrice, 12); assert.equal(row.profit, 6);
  assert.equal((await api('PUT', '/api/admin/products/New_Thing/pid', { pid: '76' }, adminTok)).status, 409);
});

test('admin: balance add/deduct creates ledger; supplier secrets masked, reveal needs password', async () => {
  const b = await api('POST', `/api/admin/users/${uidUser}/balance`, { action: 'add', amount: 25, note: 'bonus' }, adminTok); assert.equal(b.status, 200);
  assert.equal((await api('POST', `/api/admin/users/${uidUser}/balance`, { action: 'deduct', amount: 99999999 }, adminTok)).status, 400);
  const s = await api('GET', '/api/admin/suppliers', null, adminTok); const txt = JSON.stringify(s.body); assert.ok(!txt.includes('demo-supplier-api-key-123') && !txt.includes('demo-master-key-456'));
  assert.equal((await api('POST', '/api/admin/suppliers/SUP_DEMO/reveal', { password: 'wrong' }, adminTok)).status, 403);
  const rv = await api('POST', '/api/admin/suppliers/SUP_DEMO/reveal', { password: 'Admin@12345' }, adminTok); assert.equal(rv.body.apiKey, 'demo-supplier-api-key-123');
  const raw = JSON.stringify(await S.db.get('suppliers')); assert.ok(!raw.includes('demo-supplier-api-key-123'), 'stored encrypted at rest');
  const g = await api('GET', '/api/admin/gateways', null, adminTok); assert.ok(!JSON.stringify(g.body).includes('gwkey'));
  const e = await api('PUT', '/api/admin/gateways/GW_FAM', { name: 'FAM Gateway', enabled: true }, adminTok); assert.equal(e.status, 400, 'unconfigured FAM gateway cannot be enabled');
});

test('SSRF: supplier URL pointing to private network is blocked when private URLs are not allowed', async () => {
  const { createNet } = require('../src/services/netsafe'); const n = createNet({ allowPrivateUrls: false });
  for (const u of ['http://127.0.0.1/x', 'http://169.254.169.254/latest', 'http://localhost/', 'http://10.0.0.5/', 'ftp://x.com/', 'http://[::1]/']) await assert.rejects(n.assertSafeUrl(u), u);
});

let apiKey, clientId;
test('REST API v1: auth, permissions, order, status, list, balance, idempotency, logs', async () => {
  assert.equal((await api('GET', '/api/v1/products')).status, 401); assert.equal((await api('GET', '/api/v1/products', null, 'ak_x_notvalidkeynotvalidkey')).status, 401);
  const reseller = 'UID-222222-reseller'; const c = await api('POST', '/api/admin/api-clients', { name: 'Shop', uid: reseller, permissions: ['products.read', 'balance.read', 'orders.create', 'orders.read'], rateLimit: 100 }, adminTok); assert.equal(c.status, 200); apiKey = c.body.key; clientId = c.body.id;
  assert.ok(!(JSON.stringify(await S.db.get('api_clients'))).includes(apiKey), 'key not stored in clear');
  const p = await api('GET', '/api/v1/products', null, apiKey); assert.equal(p.status, 200); const bm = p.body.products.find((x) => x.pid === '152'); assert.equal(bm.plans[0].price, 20, 'reseller price');
  const bal = await api('GET', '/api/v1/balance', null, apiKey); assert.equal(bal.body.balance, 1500);
  const o = await api('POST', '/api/v1/order', { pid: '152', duration: '1 DAY', quantity: 2, idempotency_key: 'k1' }, apiKey); assert.equal(o.status, 201, JSON.stringify(o.body)); assert.equal(o.body.keys.length, 2); assert.equal(o.body.total, 40);
  const o2 = await api('POST', '/api/v1/order', { pid: '152', duration: '1 DAY', quantity: 2, idempotency_key: 'k1' }, apiKey); assert.equal(o2.body.duplicate, true); assert.equal((await api('GET', '/api/v1/balance', null, apiKey)).body.balance, 1460);
  const g = await api('GET', '/api/v1/order/' + o.body.order_id, null, apiKey); assert.equal(g.body.status, 'delivered'); assert.equal((await api('GET', '/api/v1/order/NOPE', null, apiKey)).status, 404);
  assert.equal((await api('GET', '/api/v1/orders?limit=5', null, apiKey)).body.orders.length >= 1, true);
  assert.equal((await api('POST', '/api/v1/order', { pid: '152' }, apiKey)).status, 400);
  await new Promise((r) => setTimeout(r, 200)); const logs = await api('GET', '/api/admin/api-logs?clientId=' + clientId, null, adminTok); assert.ok(logs.body.total >= 5); assert.ok(!JSON.stringify(logs.body).includes(apiKey));
  await api('PUT', `/api/admin/api-clients/${clientId}`, { permissions: ['products.read'] }, adminTok); assert.equal((await api('POST', '/api/v1/order', { pid: '152', duration: '1 DAY' }, apiKey)).status, 403);
  await api('PUT', `/api/admin/api-clients/${clientId}`, { permissions: ['products.read'], ipAllowlist: '203.0.113.9' }, adminTok); assert.equal((await api('GET', '/api/v1/products', null, apiKey)).status, 403, 'IP allowlist');
  await api('PUT', `/api/admin/api-clients/${clientId}`, { ipAllowlist: '' }, adminTok);
});
test('REST API v1: rate limit, revoke and regenerate', async () => {
  await api('PUT', `/api/admin/api-clients/${clientId}`, { rateLimit: 3 }, adminTok); S.rl.m.clear(); let last;
  for (let i = 0; i < 5; i++) last = await api('GET', '/api/v1/balance', null, apiKey); assert.equal(last.status, 403, 'balance.read removed earlier'); // permission set to products.read only
  S.rl.m.clear(); const rs = []; for (let i = 0; i < 5; i++) rs.push((await api('GET', '/api/v1/products', null, apiKey)).status); assert.deepEqual(rs, [200, 200, 200, 429, 429]);
  const r = await api('POST', `/api/admin/api-clients/${clientId}/regenerate`, null, adminTok); S.rl.m.clear(); assert.equal((await api('GET', '/api/v1/products', null, apiKey)).status, 401, 'old key dead'); assert.equal((await api('GET', '/api/v1/products', null, r.body.key)).status, 200);
  await api('POST', `/api/admin/api-clients/${clientId}/revoke`, null, adminTok); assert.equal((await api('GET', '/api/v1/products', null, r.body.key)).status, 403);
});

test('user self-service API key (reseller only), reveal needs password', async () => {
  const rl = (await api('POST', '/api/auth/login', { username: 'reseller', password: 'reseller123' })).body.token;
  assert.equal((await api('POST', '/api/me/api', { action: 'create' }, tokenUser)).status, 403);
  const c = await api('POST', '/api/me/api', { action: 'create' }, rl); assert.equal(c.status, 200); assert.ok(c.body.key.startsWith('ak_'));
  assert.equal((await api('POST', '/api/me/api/reveal', { password: 'x' }, rl)).status, 403); assert.equal((await api('POST', '/api/me/api/reveal', { password: 'reseller123' }, rl)).body.key, c.body.key);
});

test('password change invalidates old sessions; reset link flow', async () => {
  const c = await api('POST', '/api/me/password', { current: 'secret1', next: 'secret2' }, tokenUser); assert.equal(c.status, 200);
  assert.equal((await api('GET', '/api/me', null, tokenUser)).status, 401, 'old token revoked'); tokenUser = c.body.token; assert.equal((await api('GET', '/api/me', null, tokenUser)).status, 200);
  const rl = await api('POST', `/api/admin/users/${uidUser}/reset-link`, null, adminTok); const t = rl.body.link.split('reset=')[1];
  assert.equal((await api('POST', '/api/auth/reset', { token: t, password: 'newpass9' })).status, 200); assert.equal((await api('POST', '/api/auth/reset', { token: t, password: 'again99' })).status, 400, 'single use');
  assert.equal((await api('POST', '/api/auth/login', { username: 'tester', password: 'newpass9' })).status, 200);
});

test('dashboard reports real numbers', async () => {
  const d = await api('GET', '/api/admin/dashboard', null, adminTok); assert.equal(d.status, 200);
  assert.ok(d.body.users.total >= 4); assert.ok(d.body.orders.total >= 5); assert.equal(d.body.payments.success, 2); assert.ok(d.body.money.sales > 0);
});

test('security headers + HTML CSP nonce', async () => {
  fs.writeFileSync(path.join(dir, 'index.html'), '<script nonce="__NONCE__">1</script>'); S.cfg.frontendDir = dir;
  const r = await fetch(base + '/'); const h = r.headers.get('content-security-policy'); const m = /nonce-([^']+)'/.exec(h); assert.ok(m); assert.ok((await r.text()).includes(`nonce="${m[1]}"`)); assert.equal(r.headers.get('x-frame-options'), 'DENY');
});
