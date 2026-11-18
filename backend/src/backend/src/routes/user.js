'use strict';
/** Logged-in user endpoints (Bearer token from /api/auth/login). */
const { HttpError, bad, notFound, forbidden, conflict, round2, now, str, num, safeKey } = require('../lib');

module.exports = function (app, S) {
  const { db, auth, orders, gateways, catalog, apiClients, telegram, wallet } = S;
  const U = (handler) => async (ctx) => {
    const h = String(ctx.req.headers.authorization || '');
    const a = await auth.authenticate(h.startsWith('Bearer ') ? h.slice(7) : '');
    ctx.uid = a.uid; ctx.user = a.user;
    const lim = S.rl.hit(`u:${a.uid}`, 240, 60000); if (!lim.ok) throw Object.assign(new HttpError(429, 'Too many requests', 'rate_limited'), { retryAfter: lim.retryAfter });
    return handler(ctx);
  };
  const profile = (uid, u) => ({
    uid, username: u.username || '', name: u.name || '', email: u.email || '', role: u.role || 'User', balance: round2(u.balance), status: u.status || 'Active', joinedAt: u.joinedAt || null,
    telegramLinked: !!u.telegramChatId, referredBy: u.referredBy || '',
  });
  const sortDesc = (o, key) => Object.entries(o || {}).map(([id, v]) => ({ id, ...v })).sort((a, b) => (b[key] || 0) - (a[key] || 0));

  app.get('/api/me', U(async (ctx) => ({ user: profile(ctx.uid, ctx.user) })));
  app.patch('/api/me', U(async (ctx) => { const name = str(ctx.body.name, 80); if (!name) throw bad('Enter your name'); await db.update(`users/${ctx.uid}`, { name }); return {}; }));
  app.post('/api/me/password', U(async (ctx) => { const r = await auth.changePassword(ctx.uid, ctx.body.current, ctx.body.next); return r; }));
  app.post('/api/me/logout-all', U(async (ctx) => { await auth.logoutAll(ctx.uid); return {}; }));

  /* ---------- marketplace ---------- */
  app.get('/api/products', U(async (ctx) => {
    const list = catalog.publicView(await catalog.loadAll(), ctx.user.role);
    return { products: list, role: ctx.user.role || 'User' };
  }));
  app.get('/api/products/:key/download', U(async (ctx) => {
    const [p] = await catalog.loadAll(ctx.params.key); if (!p) throw notFound('Product not found');
    if (p.maintenance) throw conflict('Product under maintenance');
    if (!p.downloadUrl) throw notFound('Download link not set by admin yet');
    return { url: p.downloadUrl };
  }));

  /* ---------- orders / keys / history ---------- */
  app.post('/api/orders', U(async (ctx) => {
    const b = ctx.body; const idem = b.idempotencyKey || ctx.req.headers['idempotency-key'];
    const r = await orders.create({ uid: ctx.uid, productKey: b.productKey && safeKey(b.productKey) ? b.productKey : undefined, pid: b.pid, planKey: b.planKey, duration: b.duration, qty: b.qty || b.quantity || 1, idem, source: 'web', ip: ctx.ip });
    const bal = await db.get(`users/${ctx.uid}/balance`);
    return { order: r.order, keys: r.keys, balance: round2(bal), duplicate: !!r.duplicate };
  }));
  app.get('/api/orders', U(async (ctx) => {
    const o = await db.queryEq('orders', 'uid', ctx.uid);
    return { orders: sortDesc(o, 'createdAt').slice(0, 300).map((x) => ({ ...x, ip: undefined, debitTx: undefined })) };
  }));
  app.get('/api/keys', U(async (ctx) => {
    const k = (await db.get(`users/${ctx.uid}/generatedKeys`)) || {};
    return { keys: Object.entries(k).filter(([, v]) => v && v.source === 'stock').map(([id, v]) => ({ id, ...v })).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, 1000) };
  }));
  app.get('/api/transactions', U(async (ctx) => {
    const t = (await db.get(`users/${ctx.uid}/transactions`)) || {};
    const arr = Object.entries(t).map(([id, v]) => ({ id, ...v })); arr.forEach((v) => { v.ts = v.ts || Date.parse(v.date) || 0; });
    return { transactions: arr.sort((a, b) => b.ts - a.ts).slice(0, 500) };
  }));
  app.get('/api/me/stats', U(async (ctx) => {
    const o = Object.values(await db.queryEq('orders', 'uid', ctx.uid)).filter((x) => x.status === 'delivered' || x.status === 'partial');
    const d = new Date(); const today = d.toDateString(); let td = 0, mo = 0, spent = 0, keys = 0;
    for (const x of o) { const t = new Date(x.createdAt); const q = x.deliveredQty || x.qty || 0; keys += q; spent += x.total || 0; if (t.toDateString() === today) td += q; if (t.getMonth() === d.getMonth() && t.getFullYear() === d.getFullYear()) mo += q; }
    const dep = Object.values((await db.get(`users/${ctx.uid}/transactions`)) || {}).filter((t) => t && t.type === 'Deposit').reduce((a, t) => a + num(t.amount), 0);
    return { today: td, month: mo, totalKeys: keys, spent: round2(spent), deposited: round2(dep) };
  }));
  app.get('/api/leaderboard', U(async () => S.cached('leaderboard', 60000, async () => {
    const users = (await db.get('users')) || {}; const rows = [];
    for (const u of Object.values(users)) { const n = u.generatedKeys ? Object.values(u.generatedKeys).filter((k) => k && k.source === 'stock').length : parseInt(u.keyCount, 10) || 0; if (n > 0) rows.push({ username: u.username || 'unknown', role: u.role || 'User', keys: n, bal: num(u.balance) }); }
    rows.sort((a, b) => b.keys - a.keys || b.bal - a.bal);
    return { leaders: rows.slice(0, 5).map(({ bal, ...r }) => r) };
  })));

  /* ---------- deposits ---------- */
  app.post('/api/payments', U(async (ctx) => {
    const origin = S.cfg.publicUrl || (ctx.req.headers.origin && /^https?:\/\//.test(ctx.req.headers.origin) ? ctx.req.headers.origin : `http://${ctx.req.headers.host}`);
    return gateways.create({ uid: ctx.uid, amount: ctx.body.amount, phone: ctx.body.phone, returnUrl: `${origin}/?ap=return` });
  }));
  app.get('/api/payments', U(async (ctx) => {
    const p = await db.queryEq('auto_payments', 'uid', ctx.uid);
    return { payments: Object.entries(p).map(([id, v]) => ({ ...gateways.pubPayment(id, v), gatewayOrderId: v.gatewayOrderId || id })).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100) };
  }));
  app.post('/api/payments/:id/verify', U(async (ctx) => {
    const p = await db.get(`auto_payments/${ctx.params.id}`); if (!p || p.uid !== ctx.uid) throw notFound('Payment not found');
    const lim = S.rl.hit(`pv:${ctx.uid}`, 30, 60000); if (!lim.ok) throw Object.assign(new HttpError(429, 'Slow down', 'rate_limited'), { retryAfter: lim.retryAfter });
    const r = await gateways.verify(ctx.params.id); const bal = await db.get(`users/${ctx.uid}/balance`);
    return { ...r, balance: round2(bal) };
  }));
  app.post('/api/payments/:id/cancel', U(async (ctx) => gateways.cancel(ctx.uid, ctx.params.id)));

  /* ---------- referral / reseller ---------- */
  async function resellerCfg() { const d = (await db.get('site_settings/reseller_upgrade')) || {}; return { enabled: !!d.enabled, minBalance: num(d.minBalance, 10), commissionPct: d.commissionPct != null ? num(d.commissionPct) : 1 }; }
  app.get('/api/referral', U(async (ctx) => {
    const [cfg, links, mine] = await Promise.all([resellerCfg(), db.get('site_settings/links'), db.queryEq('users', 'referredBy', ctx.uid)]);
    const target = num(links && links.refTarget, 30); const refs = Object.entries(mine);
    let role = ctx.user.role || 'User';
    if (role !== 'Reseller' && refs.length >= target) { await db.update(`users/${ctx.uid}`, { role: 'Reseller' }); role = 'Reseller'; }
    return {
      code: ctx.uid, commissionPct: cfg.commissionPct, minBalance: cfg.minBalance, upgradeEnabled: cfg.enabled, target, role,
      referrals: refs.map(([id, u]) => ({ id, username: u.username, role: u.role || 'User', joinedAt: u.joinedAt || null, eligible: num(u.balance) >= cfg.minBalance })).sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0)),
    };
  }));
  app.post('/api/referral/:uid/make-reseller', U(async (ctx) => {
    const cfg = await resellerCfg(); if (!cfg.enabled) throw forbidden('Reseller upgrade is disabled by admin');
    const t = await db.get(`users/${ctx.params.uid}`); if (!t || t.referredBy !== ctx.uid) throw forbidden('This user did not join with your link');
    if (num(t.balance) < cfg.minBalance) throw bad(`User needs at least ₹${cfg.minBalance} in wallet`);
    await db.update(`users/${ctx.params.uid}`, { role: 'Reseller' }); return {};
  }));
  app.post('/api/me/upgrade-reseller', U(async (ctx) => {
    const cfg = await resellerCfg(); if (!cfg.enabled) throw forbidden('Reseller upgrade is disabled by admin');
    if (ctx.user.role === 'Reseller') return {};
    if (num(ctx.user.balance) < cfg.minBalance) throw bad(`You need at least ₹${cfg.minBalance} in your wallet. Please deposit first.`);
    await db.update(`users/${ctx.uid}`, { role: 'Reseller' }); return {};
  }));

  /* ---------- support ---------- */
  app.get('/api/tickets', U(async (ctx) => ({ tickets: sortDesc(await db.queryEq('tickets', 'uid', ctx.uid), 'createdAt') })));
  app.post('/api/tickets', U(async (ctx) => {
    const subject = str(ctx.body.subject, 120), message = str(ctx.body.message, 3000); if (!subject || !message) throw bad('Subject and message are required');
    const lim = S.rl.hit(`tk:${ctx.uid}`, 5, 3600000); if (!lim.ok) throw Object.assign(new HttpError(429, 'Too many tickets, try later', 'rate_limited'), { retryAfter: lim.retryAfter });
    const id = await db.push('tickets', { uid: ctx.uid, username: ctx.user.username || '', subject, message, status: 'open', reply: '', createdAt: now() });
    telegram.notify('admin', `🎫 <b>New ticket</b> from @${ctx.user.username}: ${subject.replace(/[<>&]/g, '')}`, { adminToo: true });
    return { id };
  }));

  /* ---------- API access (reseller) ---------- */
  const apiEligible = async (u) => { const s = (await db.get('site_settings/api')) || {}; return u.role === 'Reseller' && s.userSelfServe !== false; };
  app.get('/api/me/api', U(async (ctx) => {
    const eligible = await apiEligible(ctx.user); const c = await apiClients.forUser(ctx.uid);
    return { eligible, client: c, base: S.cfg.publicUrl || '' };
  }));
  app.post('/api/me/api', U(async (ctx) => {
    if (!(await apiEligible(ctx.user))) throw forbidden('API access is available for Reseller accounts');
    const action = ctx.body.action; const cur = await apiClients.forUser(ctx.uid);
    if (action === 'create') { if (cur) throw conflict('You already have an API key'); const r = await apiClients.create({ name: `${ctx.user.username} API`, uid: ctx.uid, selfService: true, createdBy: ctx.uid }); return { key: r.key, client: r.client }; }
    if (!cur) throw notFound('No API key yet');
    if (action === 'regenerate') { const r = await apiClients.regenerate(cur.id); return { key: r.key }; }
    if (action === 'revoke') { await apiClients.revoke(cur.id); return {}; }
    throw bad('Unknown action');
  }));
  app.post('/api/me/api/reveal', U(async (ctx) => {
    const lim = S.rl.hit(`rv:${ctx.uid}`, 5, 600000); if (!lim.ok) throw Object.assign(new HttpError(429, 'Too many attempts', 'rate_limited'), { retryAfter: lim.retryAfter });
    await auth.confirmPassword(ctx.uid, ctx.body.password);
    const cur = await apiClients.forUser(ctx.uid); if (!cur) throw notFound('No API key yet');
    return { key: await apiClients.revealKey(cur.id) };
  }));

  /* ---------- Telegram link ---------- */
  app.post('/api/me/telegram/link', U(async (ctx) => telegram.createLinkCode(ctx.uid)));
  app.delete('/api/me/telegram', U(async (ctx) => { await db.update(`users/${ctx.uid}`, { telegramChatId: null }); return {}; }));
};
