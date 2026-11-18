'use strict';
/** Admin API (part 1): auth/roles/audit, dashboard, users, products, PID/price/duration, mappings, orders, transactions, stock. */
const { HttpError, bad, notFound, forbidden, conflict, unauthorized, signToken, verifyToken, verifyPassword, hashPassword, round2, num, now, str, slug, sha256, safeKey, durKey, safeEqual } = require('../lib');

const ROLE_PERMS = {
  super: ['*'],
  manager: ['dashboard', 'users.read', 'users.write', 'products', 'stock', 'orders', 'transactions', 'maintenance', 'announcements', 'media', 'tickets', 'wallet.read'],
  finance: ['dashboard', 'users.read', 'transactions', 'wallet', 'wallet.read', 'orders', 'gateways', 'suppliers'],
  support: ['dashboard', 'users.read', 'orders', 'tickets', 'transactions', 'announcements'],
};
const can = (role, perm) => { const p = ROLE_PERMS[role] || []; return p.includes('*') || p.includes(perm) || (perm.includes('.') && p.includes(perm.split('.')[0])); };

module.exports = function (app, S) {
  const { db, cfg, auth, catalog, wallet, orders, rl } = S;
  const eKey = (e) => slug(String(e).toLowerCase());

  /* ---------- admin identity ---------- */
  async function verifyCredentials(email, password) {
    email = String(email || '').trim().toLowerCase();
    if (!email || !password) throw bad('Enter email and password');
    if (cfg.admin.mode === 'firebase') {
      if (!cfg.firebase.webApiKey) throw new HttpError(503, 'Backend not configured: set FIREBASE_WEB_API_KEY (or use ADMIN_AUTH=local)', 'not_configured');
      let r;
      try { r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(cfg.firebase.webApiKey)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: false }), signal: AbortSignal.timeout(15000) }); }
      catch { throw new HttpError(502, 'Could not reach Firebase Auth', 'upstream_unreachable'); }
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.email) throw new HttpError(401, 'Incorrect email or password', 'invalid_credentials');
      return String(j.email).toLowerCase();
    }
    if (!cfg.admin.localEmail || !cfg.admin.localPasswordHash) throw new HttpError(503, 'Backend not configured: set ADMIN_LOCAL_EMAIL and ADMIN_LOCAL_PASSWORD_HASH (npm run hash-password)', 'not_configured');
    const ok = email === cfg.admin.localEmail && (await verifyPassword(password, cfg.admin.localPasswordHash));
    if (!ok) throw new HttpError(401, 'Incorrect email or password', 'invalid_credentials');
    return email;
  }
  async function roleFor(email) {
    if (cfg.admin.emails.includes(email) || (cfg.admin.mode === 'local' && email === cfg.admin.localEmail)) return 'super';
    const r = await db.get(`admin_roles/${eKey(email)}`); return r && r.role && ROLE_PERMS[r.role] ? r.role : null;
  }
  const ipOk = (ip) => !cfg.admin.ipAllowlist.length || cfg.admin.ipAllowlist.includes(ip);
  async function audit(ctx, action, target, detail) {
    try { await db.push('admin_audit', { email: ctx.admin ? ctx.admin.email : '', action, target: target || '', detail: detail ? String(detail).slice(0, 300) : '', ip: ctx.ip, ts: now() }); } catch {}
  }
  S.audit = audit; S.ROLE_PERMS = ROLE_PERMS; S.verifyAdminPassword = async (ctx) => {
    const lim = rl.hit(`areveal:${ctx.admin.email}`, 6, 600000); if (!lim.ok) throw Object.assign(new HttpError(429, 'Too many attempts', 'rate_limited'), { retryAfter: lim.retryAfter });
    const e = await verifyCredentials(ctx.admin.email, ctx.body.password).catch(() => { throw forbidden('Password is incorrect'); });
    if (e !== ctx.admin.email) throw forbidden('Password is incorrect');
  };

  /** Route guard. perm = permission string or null (any admin). */
  const A = (perm, handler) => async (ctx) => {
    if (!ipOk(ctx.ip)) throw new HttpError(403, 'Your IP is not allowed to access the admin API', 'ip_blocked');
    const h = String(ctx.req.headers.authorization || ''); const p = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : '', cfg.jwtSecret);
    if (!p || p.t !== 'admin') throw unauthorized('Admin login required');
    const epoch = (await db.get('admin_security/epoch')) || 0; if ((p.e || 0) !== epoch) throw unauthorized('Session expired, login again');
    const role = await roleFor(p.email); if (!role) throw unauthorized('Admin access revoked');
    ctx.admin = { email: p.email, role };
    if (perm && !can(role, perm)) throw forbidden(`Your role (${role}) cannot do this`);
    return handler(ctx);
  };
  S.A = A;

  app.post('/api/admin/login', async (ctx) => {
    if (!ipOk(ctx.ip)) throw new HttpError(403, 'Your IP is not allowed to access the admin API', 'ip_blocked');
    const a = rl.hit(`alogin:ip:${ctx.ip}`, 10, 15 * 60000), b = rl.hit(`alogin:em:${String(ctx.body.email || '').toLowerCase()}`, 6, 15 * 60000);
    if (!a.ok || !b.ok) throw Object.assign(new HttpError(429, 'Too many attempts. Try again later.', 'rate_limited'), { retryAfter: Math.max(a.retryAfter, b.retryAfter) });
    const email = await verifyCredentials(ctx.body.email, ctx.body.password);
    const role = await roleFor(email);
    if (!role) { await audit({ ip: ctx.ip }, 'login_denied', email, 'not in ADMIN_EMAILS / admin_roles'); throw forbidden(cfg.admin.emails.length ? 'This account is not an authorised admin' : 'No admin is authorised yet: set ADMIN_EMAILS in the backend .env'); }
    const epoch = (await db.get('admin_security/epoch')) || 0;
    const token = signToken({ t: 'admin', email, e: epoch }, cfg.jwtSecret, cfg.adminTokenTtl);
    await audit({ admin: { email }, ip: ctx.ip }, 'login', email);
    return { token, admin: { email, role, permissions: ROLE_PERMS[role] } };
  });
  app.get('/api/admin/me', A(null, async (ctx) => ({ admin: { email: ctx.admin.email, role: ctx.admin.role, permissions: ROLE_PERMS[ctx.admin.role] } })));

  const paginate = (arr, q, def = 50) => { const size = Math.min(200, Math.max(1, parseInt(q.size, 10) || def)); const page = Math.max(1, parseInt(q.page, 10) || 1); return { total: arr.length, page, size, items: arr.slice((page - 1) * size, page * size) }; };
  S.paginate = paginate;

  /* ---------- dashboard (real records only) ---------- */
  app.get('/api/admin/dashboard', A('dashboard', async () => S.cached('dash', 8000, async () => {
    const [users, orders_, pays, clients, usage, gws, sups, prods, mgmt] = await Promise.all([db.get('users'), db.get('orders'), db.get('auto_payments'), db.get('api_clients'), db.get('api_usage'), db.get('payment_gateways'), db.get('suppliers'), db.get('store_products'), db.get('store_management')]);
    const U = Object.values(users || {}); const monthAgo = now() - 30 * 86400000;
    const O = Object.values(orders_ || {}); const done = O.filter((o) => o.status === 'delivered' || o.status === 'partial' || o.status === 'refunded');
    const sales = done.reduce((a, o) => a + num(o.total) - (o.status === 'refunded' ? num(o.refunded) : 0), 0);
    const cost = done.reduce((a, o) => a + num(o.cost), 0);
    const P = Object.values(pays || {}); const cnt = (f) => P.filter(f).length;
    const day = (ts) => new Date(ts).toISOString().slice(5, 10);
    const series = {}; for (let i = 13; i >= 0; i--) series[day(now() - i * 86400000)] = { sales: 0, orders: 0 };
    done.forEach((o) => { const k = day(o.createdAt); if (series[k]) { series[k].sales += num(o.total); series[k].orders += 1; } });
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, ''); let apiToday = 0;
    Object.values(usage || {}).forEach((d) => { const t = d[today]; if (t) apiToday += num(t.ok) + num(t.errors); });
    return {
      users: { total: U.length, active: U.filter((u) => num(u.lastLoginAt || u.joinedAt) > monthAgo).length, resellers: U.filter((u) => u.role === 'Reseller').length, banned: U.filter((u) => u.banned === true || u.status === 'Banned').length, walletTotal: round2(U.reduce((a, u) => a + num(u.balance), 0)) },
      products: { total: Object.keys(mgmt || {}).length, inactive: Object.values(prods || {}).filter((p) => String(p.status || '').toUpperCase() === 'INACTIVE').length, plans: Object.values(mgmt || {}).reduce((a, p) => a + Object.keys(p).length, 0) },
      orders: { total: O.length, delivered: O.filter((o) => o.status === 'delivered').length, failed: O.filter((o) => o.status === 'failed').length, review: O.filter((o) => o.status === 'needs_review').length },
      payments: { success: cnt((p) => p.status === 'success'), pending: cnt((p) => p.status === 'pending'), failed: cnt((p) => ['failed', 'expired', 'cancelled'].includes(p.status)), review: cnt((p) => ['mismatch', 'review'].includes(p.status)), amountReceived: round2(P.filter((p) => p.status === 'success').reduce((a, p) => a + num(p.amount), 0)) },
      money: { sales: round2(sales), supplierCost: round2(cost), profit: round2(sales - cost) },
      api: { clients: Object.keys(clients || {}).length, requestsTotal: Object.values(clients || {}).reduce((a, c) => a + num(c.requests), 0), requestsToday: apiToday },
      gateways: Object.entries(gws || {}).map(([id, g]) => ({ id, name: g.name, enabled: !!g.enabled, status: g.status || 'unknown', note: g.statusNote || '' })),
      suppliers: Object.entries(sups || {}).map(([id, s]) => ({ id, name: s.name, enabled: s.enabled !== false, status: s.status || 'unknown', note: s.statusNote || '', ok: num(s.stats && s.stats.ok), failed: num(s.stats && s.stats.failed) })),
      series: Object.entries(series).map(([d, v]) => ({ d, sales: round2(v.sales), orders: v.orders })),
      recent: O.sort((a, b) => b.createdAt - a.createdAt).slice(0, 8).map((o) => ({ id: o.id, username: o.username, product: o.productName, pid: o.pid, duration: o.duration, total: o.total, status: o.status, ts: o.createdAt })),
    };
  })));

  /* ---------- users ---------- */
  const userView = (uid, u) => ({ uid, username: u.username || '', name: u.name || '', email: u.email || '', role: u.role || 'User', balance: round2(u.balance), status: u.status || 'Active', banned: u.banned === true || u.status === 'Banned', joinedAt: u.joinedAt || null, lastLoginAt: u.lastLoginAt || null, keys: num(u.keyCount), referredBy: u.referredBy || '', telegram: !!u.telegramChatId, hasLegacyPassword: typeof u.password === 'string' });
  app.get('/api/admin/users', A('users.read', async (ctx) => {
    const q = String(ctx.query.q || '').toLowerCase(); const role = ctx.query.role;
    let rows = Object.entries((await db.get('users')) || {}).map(([id, u]) => userView(id, u));
    if (q) rows = rows.filter((u) => [u.username, u.email, u.name, u.uid].some((v) => String(v).toLowerCase().includes(q)));
    if (role) rows = rows.filter((u) => u.role === role);
    if (ctx.query.banned === '1') rows = rows.filter((u) => u.banned);
    rows.sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0));
    return paginate(rows, ctx.query, 50);
  }));
  app.patch('/api/admin/users/:uid', A('users.write', async (ctx) => {
    const u = await db.get(`users/${ctx.params.uid}`); if (!u) throw notFound('User not found'); const b = ctx.body; const ups = {};
    if (b.role !== undefined) { if (!['User', 'Reseller'].includes(b.role)) throw bad('Role must be User or Reseller'); ups.role = b.role; }
    if (b.banned !== undefined) { ups.banned = !!b.banned; ups.status = b.banned ? 'Banned' : (u.status === 'Banned' ? 'Active' : u.status || 'Active'); }
    if (b.panel !== undefined) ups.status = b.panel === 'OFF' ? 'OFF' : 'ON';
    if (b.name !== undefined) ups.name = str(b.name, 80);
    await db.update(`users/${ctx.params.uid}`, ups); await audit(ctx, 'user_update', ctx.params.uid, JSON.stringify(ups)); return {};
  }));
  app.post('/api/admin/users/:uid/balance', A('wallet', async (ctx) => {
    const uid = ctx.params.uid; if (!(await db.get(`users/${uid}/username`))) throw notFound('User not found');
    const amount = round2(ctx.body.amount); if (!(amount > 0) || amount > 10000000) throw bad('Enter a valid amount');
    const note = str(ctx.body.note, 120); let r;
    if (ctx.body.action === 'add') r = await wallet.credit(uid, amount, { type: 'Deposit', source: 'admin', description: note ? `Admin added balance: ${note}` : 'Admin ne balance add kiya', by: ctx.admin.email });
    else if (ctx.body.action === 'deduct') { r = await wallet.debit(uid, amount, { type: 'AdminDebit', source: 'admin', description: note ? `Admin removed balance: ${note}` : 'Admin ne balance remove kiya', by: ctx.admin.email }); if (!r.ok) throw bad('User does not have enough balance'); }
    else throw bad('action must be add or deduct');
    await audit(ctx, 'wallet_' + ctx.body.action, uid, `₹${amount} ${note}`); S.cache.delete('dash');
    return { balance: r.balance };
  }));
  app.post('/api/admin/users/:uid/reset-link', A('users.write', async (ctx) => {
    if (!(await db.get(`users/${ctx.params.uid}/username`))) throw notFound('User not found');
    const token = await auth.issueReset(ctx.params.uid, 60); await audit(ctx, 'reset_link', ctx.params.uid);
    const base = cfg.publicUrl || (ctx.req.headers.origin || `http://${ctx.req.headers.host}`);
    return { link: `${base}/?reset=${token}`, expiresInMin: 60 };
  }));
  app.post('/api/admin/users/:uid/logout', A('users.write', async (ctx) => { await auth.logoutAll(ctx.params.uid); await audit(ctx, 'user_logout_all', ctx.params.uid); return {}; }));
  app.delete('/api/admin/users/:uid', A('*', async (ctx) => {
    const u = await db.get(`users/${ctx.params.uid}`); if (!u) throw notFound('User not found');
    const ups = { [`users/${ctx.params.uid}`]: null };
    if (u.username) ups[`usernames/${slug(String(u.username).toLowerCase())}`] = null; if (u.email) ups[`emails/${slug(String(u.email).toLowerCase())}`] = null;
    await db.update('', ups); await audit(ctx, 'user_delete', ctx.params.uid, u.username); return {};
  }));

  /* ---------- products / PID / price / duration ---------- */
  async function adminProducts() {
    const list = await catalog.loadAll(); const sups = (await db.get('suppliers')) || {};
    return list.map((p) => ({
      ...p, plans: p.plans.map((pl) => {
        const m = pl.mappings[0]; const cost = m ? num(m.cost) : null;
        return { pk: pl.pk, duration: pl.duration, price: pl.price, rprice: pl.rprice, stock: pl.stock, cost, profitUser: cost == null ? null : round2(pl.price - cost), profitReseller: cost == null || pl.rprice == null ? null : round2(pl.rprice - cost), mappings: pl.allMappings.map((x) => ({ id: x.id, supplierId: x.supplierId, supplier: (sups[x.supplierId] || {}).name || x.supplierId, supplierPid: x.supplierPid, supplierDuration: x.supplierDuration, cost: x.cost, enabled: x.enabled !== false, priority: x.priority })) };
      }),
    }));
  }
  app.get('/api/admin/products', A('products', async () => ({ products: await adminProducts(), nextPid: await catalog.nextPid() })));
  app.post('/api/admin/products', A('products', async (ctx) => { const r = await catalog.saveProduct(null, ctx.body); await audit(ctx, 'product_create', r.key, `PID ${r.pid}`); return r; }));
  app.put('/api/admin/products/:key', A('products', async (ctx) => {
    if (!safeKey(ctx.params.key) || !(await db.get(`store_management/${ctx.params.key}`))) throw notFound('Product not found');
    const r = await catalog.saveProduct(ctx.params.key, ctx.body); await audit(ctx, 'product_update', r.key, `PID ${r.pid}`); return r;
  }));
  app.delete('/api/admin/products/:key', A('products', async (ctx) => { if (!safeKey(ctx.params.key)) throw bad('Bad key'); await catalog.deleteProduct(ctx.params.key); await audit(ctx, 'product_delete', ctx.params.key); return {}; }));
  app.patch('/api/admin/products/:key/status', A('products', async (ctx) => {
    const k = ctx.params.key; if (!(await db.get(`store_management/${k}`))) throw notFound('Product not found');
    await db.set(`store_products/${k}/status`, String(ctx.body.status).toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE'); await audit(ctx, 'product_status', k, ctx.body.status); return {};
  }));
  app.put('/api/admin/products/:key/pid', A('products', async (ctx) => { if (!(await db.get(`store_management/${ctx.params.key}`))) throw notFound('Product not found'); await catalog.setPid(ctx.params.key, str(ctx.body.pid, 20)); await audit(ctx, 'pid_change', ctx.params.key, ctx.body.pid); return {}; }));
  app.post('/api/admin/pids/assign-missing', A('products', async (ctx) => { const n = await catalog.ensurePids(); await audit(ctx, 'pid_assign_missing', '', String(n)); return { assigned: n }; }));
  app.post('/api/admin/prices', A('products', async (ctx) => {
    const rows = Array.isArray(ctx.body.rows) ? ctx.body.rows : []; if (!rows.length || rows.length > 500) throw bad('Send 1-500 price rows'); const ups = {};
    for (const r of rows) {
      if (!safeKey(r.key) || !safeKey(r.pk)) throw bad('Bad product/plan key'); const p = round2(r.price), rp = round2(r.rprice);
      if (!(p >= 0) || !(rp >= 0)) throw bad('Prices must be 0 or more');
      ups[`store_management/${r.key}/${r.pk}/priceRate`] = p; ups[`store_management/${r.key}/${r.pk}/resellerPrice`] = rp;
    }
    for (const k of Object.keys(ups)) { const [, key, pk] = k.split('/'); if (!(await db.get(`store_management/${key}/${pk}/daysPlan`))) throw notFound(`Plan not found: ${key}/${pk}`); }
    await db.update('', ups); await audit(ctx, 'prices_update', '', `${rows.length} rows`); return { updated: rows.length };
  }));
  app.get('/api/admin/durations', A('products', async () => {
    const m = {}; (await catalog.loadAll()).forEach((p) => p.plans.forEach((pl) => { const k = durKey(pl.duration); (m[k] ||= { label: pl.duration, variants: new Set(), count: 0, products: [] }); m[k].variants.add(pl.duration); m[k].count++; m[k].products.push({ key: p.key, name: p.name, pid: p.pid, pk: pl.pk, duration: pl.duration, price: pl.price }); }));
    return { durations: Object.values(m).map((d) => ({ ...d, variants: [...d.variants] })).sort((a, b) => b.count - a.count) };
  }));
  app.post('/api/admin/durations/rename', A('products', async (ctx) => {
    const to = str(ctx.body.to, 60); if (!to) throw bad('New duration label required'); const from = durKey(ctx.body.from); if (!from) throw bad('Old duration required');
    const mgmt = (await db.get('store_management')) || {}; const ups = {}; let n = 0; const clash = [];
    for (const [k, plans] of Object.entries(mgmt)) {
      if (ctx.body.productKey && ctx.body.productKey !== k) continue;
      const hit = Object.entries(plans).filter(([, p]) => durKey(p.daysPlan) === from); if (!hit.length) continue;
      const others = Object.entries(plans).filter(([pk, p]) => durKey(p.daysPlan) === durKey(to) && !hit.find(([h]) => h === pk));
      if (others.length) { clash.push(k); continue; }
      hit.forEach(([pk]) => { ups[`store_management/${k}/${pk}/daysPlan`] = to; n++; });
    }
    if (n) await db.update('', ups);
    await audit(ctx, 'duration_rename', '', `${ctx.body.from} -> ${to} (${n})`);
    return { renamed: n, skippedBecauseDuplicate: clash };
  }));

  /* ---------- PID mappings ---------- */
  app.get('/api/admin/mappings', A('suppliers', async () => {
    const [maps, sups, prods] = await Promise.all([db.get('pid_mappings'), db.get('suppliers'), catalog.loadAll()]); const pm = Object.fromEntries(prods.map((p) => [p.key, p]));
    return {
      mappings: Object.entries(maps || {}).map(([id, m]) => {
        const p = pm[m.productKey]; const pl = p && p.plans.find((x) => x.pk === m.planKey);
        return { id, ...m, supplier: (sups && sups[m.supplierId] || {}).name || m.supplierId, aryanPid: p ? p.pid : m.aryanPid, productName: p ? p.name : '(deleted)', duration: pl ? pl.duration : '', sellPrice: pl ? pl.price : null, resellerPrice: pl ? pl.rprice : null, profit: pl ? round2(pl.price - num(m.cost)) : null, profitReseller: pl && pl.rprice != null ? round2(pl.rprice - num(m.cost)) : null };
      }).sort((a, b) => String(a.aryanPid).localeCompare(String(b.aryanPid), undefined, { numeric: true })),
    };
  }));
  app.post('/api/admin/mappings', A('suppliers', async (ctx) => { const id = await catalog.saveMapping(null, ctx.body); await audit(ctx, 'mapping_create', id, `${ctx.body.supplierPid} -> ${ctx.body.productKey}`); return { id }; }));
  app.put('/api/admin/mappings/:id', A('suppliers', async (ctx) => { const id = await catalog.saveMapping(ctx.params.id, ctx.body); await audit(ctx, 'mapping_update', id); return { id }; }));
  app.delete('/api/admin/mappings/:id', A('suppliers', async (ctx) => { await catalog.deleteMapping(ctx.params.id); await audit(ctx, 'mapping_delete', ctx.params.id); return {}; }));

  /* ---------- orders ---------- */
  app.get('/api/admin/orders', A('orders', async (ctx) => {
    let rows = Object.values((await db.get('orders')) || {}); const q = String(ctx.query.q || '').toLowerCase();
    if (ctx.query.status) rows = rows.filter((o) => o.status === ctx.query.status);
    if (ctx.query.source) rows = rows.filter((o) => o.source === ctx.query.source);
    if (ctx.query.delivery) rows = rows.filter((o) => o.deliveryType === ctx.query.delivery);
    if (ctx.query.supplierId) rows = rows.filter((o) => o.supplierId === ctx.query.supplierId);
    if (q) rows = rows.filter((o) => [o.id, o.username, o.productName, o.pid, ...(o.keys || [])].some((v) => String(v || '').toLowerCase().includes(q)));
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const sum = { count: rows.length, revenue: round2(rows.filter((o) => ['delivered', 'partial'].includes(o.status)).reduce((a, o) => a + num(o.total), 0)), cost: round2(rows.reduce((a, o) => a + num(o.cost), 0)) };
    const p = paginate(rows, ctx.query, 50); p.items = p.items.map((o) => ({ ...o, keys: ctx.admin.role === 'support' ? (o.keys || []).map((k) => k.slice(0, 4) + '••••') : o.keys }));
    return { ...p, summary: sum };
  }));
  app.post('/api/admin/orders/:id/refund', A('wallet', async (ctx) => { const r = await orders.refundOrder(ctx.params.id, ctx.admin.email, str(ctx.body.reason, 120)); await audit(ctx, 'order_refund', ctx.params.id, `₹${r.refunded}`); S.cache.delete('dash'); return r; }));
  app.post('/api/admin/orders/:id/deliver', A('orders', async (ctx) => { const r = await orders.manualDeliver(ctx.params.id, Array.isArray(ctx.body.keys) ? ctx.body.keys : String(ctx.body.keys || '').split(/\r?\n/), ctx.admin.email); await audit(ctx, 'order_manual_deliver', ctx.params.id); return r; }));

  /* ---------- transactions & wallets ---------- */
  app.get('/api/admin/transactions', A('transactions', async (ctx) => {
    let rows = Object.entries((await db.get('transactions')) || {}).map(([id, t]) => ({ id, ...t })); const q = String(ctx.query.q || '').toLowerCase();
    if (ctx.query.type) rows = rows.filter((t) => t.type === ctx.query.type);
    if (ctx.query.dir) rows = rows.filter((t) => t.direction === ctx.query.dir);
    if (q) rows = rows.filter((t) => [t.username, t.description, t.orderId, t.paymentId, t.uid].some((v) => String(v || '').toLowerCase().includes(q)));
    rows.forEach((t) => { t.ts = t.ts || Date.parse(t.date) || 0; }); rows.sort((a, b) => b.ts - a.ts);
    const sum = { in: round2(rows.filter((t) => t.direction === 'in').reduce((a, t) => a + num(t.amount), 0)), out: round2(rows.filter((t) => t.direction === 'out').reduce((a, t) => a + num(t.amount), 0)), count: rows.length };
    return { ...paginate(rows, ctx.query, 50), summary: sum };
  }));
  app.get('/api/admin/wallets', A('wallet.read', async (ctx) => {
    const q = String(ctx.query.q || '').toLowerCase(); let rows = Object.entries((await db.get('users')) || {}).map(([id, u]) => ({ uid: id, username: u.username || '', role: u.role || 'User', balance: round2(u.balance), banned: u.banned === true }));
    if (q) rows = rows.filter((u) => u.username.toLowerCase().includes(q) || u.uid.toLowerCase().includes(q)); rows.sort((a, b) => b.balance - a.balance);
    return { ...paginate(rows, ctx.query, 50), total_balance: round2(rows.reduce((a, u) => a + u.balance, 0)) };
  }));

  /* ---------- key stock ---------- */
  app.get('/api/admin/stock', A('stock', async () => {
    const prods = await catalog.loadAll(); const rows = [];
    prods.forEach((p) => p.plans.forEach((pl) => rows.push({ key: p.key, pid: p.pid, name: p.name, pk: pl.pk, duration: pl.duration, stock: pl.stock, suppliers: pl.allMappings.length })));
    return { rows, total: rows.reduce((a, r) => a + r.stock, 0) };
  }));
  const maskKey = (k) => { k = String(k); return k.length <= 8 ? k.slice(0, 2) + '••••' : k.slice(0, 4) + '••••' + k.slice(-3); };
  app.get('/api/admin/stock/:key/:pk', A('stock', async (ctx) => { const o = (await db.get(`key_stock/${ctx.params.key}/${ctx.params.pk}`)) || {}; return { keys: Object.entries(o).slice(0, 200).map(([id, k]) => ({ id, masked: maskKey(k) })), total: Object.keys(o).length }; }));
  app.post('/api/admin/stock', A('stock', async (ctx) => {
    const { productKey, planKey } = ctx.body; if (!safeKey(productKey) || !safeKey(planKey)) throw bad('Select a product and duration');
    if (!(await db.get(`store_management/${productKey}/${planKey}`))) throw notFound('Plan not found');
    const lines = [...new Set((Array.isArray(ctx.body.keys) ? ctx.body.keys : String(ctx.body.keys || '').split(/\r?\n/)).map((x) => String(x).trim()).filter(Boolean))];
    if (!lines.length) throw bad('Paste at least one key'); if (lines.some((l) => l.length > 500)) throw bad('A key is too long');
    const existing = new Set(Object.values((await db.get(`key_stock/${productKey}/${planKey}`)) || {})); const fresh = lines.filter((k) => !existing.has(k));
    if (!fresh.length) throw conflict('All these keys are already in stock');
    const { pushKey } = require('../lib'); const ups = {}; fresh.forEach((k) => { ups[`${pushKey()}`] = k; });
    await db.update(`key_stock/${productKey}/${planKey}`, ups); await audit(ctx, 'stock_add', `${productKey}/${planKey}`, `${fresh.length} keys`);
    return { added: fresh.length, duplicates: lines.length - fresh.length };
  }));
  app.delete('/api/admin/stock/:key/:pk', A('stock', async (ctx) => { await db.remove(`key_stock/${ctx.params.key}/${ctx.params.pk}`); await audit(ctx, 'stock_clear', `${ctx.params.key}/${ctx.params.pk}`); return {}; }));
  app.delete('/api/admin/stock/:key/:pk/:id', A('stock', async (ctx) => { await db.remove(`key_stock/${ctx.params.key}/${ctx.params.pk}/${ctx.params.id}`); await audit(ctx, 'stock_remove_one', `${ctx.params.key}/${ctx.params.pk}`); return {}; }));
};
module.exports.ROLE_PERMS = ROLE_PERMS;
