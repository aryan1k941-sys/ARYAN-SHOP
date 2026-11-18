'use strict';
/**
 * ARYAN REST API v1 - real routes backed by the same order engine as the website.
 *   GET  /api/v1/products          GET /api/v1/balance        POST /api/v1/order
 *   GET  /api/v1/order/{order_id}  GET /api/v1/orders
 * Auth: "Authorization: Bearer ak_..." (or X-API-Key). Permissions, IP allowlist and per-key rate limit are enforced per request.
 */
const { HttpError, bad, notFound, round2, num, safeKey } = require('../lib');

module.exports = function (app, S) {
  const { db, apiClients, catalog, orders } = S;

  const V = (perm, handler) => async (ctx) => {
    const t0 = Date.now();
    ctx.onFinish = (status, ms) => { apiClients.logRequest(ctx, status, ms, ctx.logExtra || {}); };
    const a = await apiClients.authenticate(ctx, perm);
    ctx.uid = a.uid; ctx.user = a.user; ctx.client = a.client;
    if (ctx.rateHeaders) for (const [k, v] of Object.entries(ctx.rateHeaders)) ctx.res.setHeader(k, v);
    return handler(ctx);
  };
  const shapeOrder = (o) => ({
    order_id: o.id, status: o.status, pid: o.pid, product: o.productName, duration: o.duration, quantity: o.qty, delivered_quantity: o.deliveredQty ?? null, unit_price: o.unitPrice, total: o.total, refunded: o.refunded || 0,
    created_at: new Date(o.createdAt).toISOString(), keys: o.status === 'delivered' || o.status === 'partial' ? o.keys || [] : [], ...(o.failReason ? { error: o.failReason } : {}),
  });

  app.get('/api/v1/products', V('products.read', async (ctx) => {
    let list = catalog.publicView(await catalog.loadAll(), ctx.user.role);
    if (ctx.query.pid) list = list.filter((p) => String(p.pid) === String(ctx.query.pid));
    if (ctx.query.category) list = list.filter((p) => String(p.category).toLowerCase() === String(ctx.query.category).toLowerCase());
    return { count: list.length, products: list.map((p) => ({ pid: p.pid, name: p.name, category: p.category, status: p.status, description: p.description, plans: p.plans.map((x) => ({ plan_id: x.pk, duration: x.duration, price: x.price, currency: 'INR', delivery: x.delivery, stock: x.stock, available: x.available && p.status === 'ACTIVE' })) })) };
  }));

  app.get('/api/v1/balance', V('balance.read', async (ctx) => ({ username: ctx.user.username, role: ctx.user.role || 'User', balance: round2(ctx.user.balance), currency: 'INR' })));

  app.post('/api/v1/order', V('orders.create', async (ctx) => {
    const b = ctx.body || {}; const idem = b.idempotency_key || ctx.req.headers['idempotency-key'];
    if (!b.pid && !b.product_id) throw bad('"pid" (ARYAN PID ID) is required', 'missing_pid');
    if (!b.plan_id && !b.duration) throw bad('"duration" (e.g. "1 Day") or "plan_id" is required', 'missing_duration');
    const r = await orders.create({ uid: ctx.uid, pid: String(b.pid || b.product_id), planKey: b.plan_id && safeKey(b.plan_id) ? b.plan_id : undefined, duration: b.duration, qty: b.quantity ?? 1, idem, source: 'api', apiClientId: ctx.apiClientId, ip: ctx.ip });
    ctx.logExtra = { orderId: r.order.id };
    ctx.send(r.duplicate ? 200 : 201, { ok: true, duplicate: !!r.duplicate, ...shapeOrder(r.order), balance: round2(await db.get(`users/${ctx.uid}/balance`)) });
  }));

  app.get('/api/v1/order/:id', V('orders.read', async (ctx) => {
    const o = await db.get(`orders/${ctx.params.id}`); if (!o || o.uid !== ctx.uid) throw notFound('Order not found');
    return shapeOrder(o);
  }));

  app.get('/api/v1/orders', V('orders.read', async (ctx) => {
    const all = Object.values(await db.queryEq('orders', 'uid', ctx.uid)).sort((a, b) => b.createdAt - a.createdAt);
    const limit = Math.min(100, Math.max(1, parseInt(ctx.query.limit, 10) || 20)); const page = Math.max(1, parseInt(ctx.query.page, 10) || 1);
    const rows = ctx.query.status ? all.filter((o) => o.status === ctx.query.status) : all;
    return { total: rows.length, page, limit, orders: rows.slice((page - 1) * limit, page * limit).map(shapeOrder) };
  }));
};
