'use strict';
/**
 * Order engine - used by the website AND the REST API v1, so the rules are identical:
 *   validate (maintenance, account, product, plan, price from DB, stock/supplier availability)
 *   -> atomic wallet debit (never below zero) -> fulfil (stock keys or supplier by priority with fallback)
 *   -> on any failure automatic refund + ledger entry -> delivery records + referral commission + notifications.
 */
const { HttpError, bad, notFound, conflict, forbidden, unauthorized, round2, now, randId, sha256, num, esc, durKey, pushKey } = require('../lib');

function createOrders({ db, wallet, catalog, suppliers, telegram, log }) {
  const money = (n) => '₹' + round2(n).toFixed(2);

  async function takeStock(productKey, planKey, qty) {
    let taken = [];
    const res = await db.transaction(`key_stock/${productKey}/${planKey}`, (cur) => {
      taken = []; const entries = cur ? Object.entries(cur) : [];
      if (entries.length < qty) return undefined;
      const rest = {}; entries.forEach(([id, v], i) => { if (i < qty) taken.push({ id, key: v }); else rest[id] = v; });
      return Object.keys(rest).length ? rest : null;
    });
    if (!res.committed || taken.length !== qty) return null;
    return taken;
  }
  async function putStockBack(productKey, planKey, taken) {
    await db.transaction(`key_stock/${productKey}/${planKey}`, (cur) => { const o = cur || {}; taken.forEach((t) => { o[t.id] = t.key; }); return o; });
  }

  async function payReferral(user, uid, amount, orderId) {
    const refUid = user.referredBy; if (!refUid || refUid === uid) return;
    const cfg = (await db.get('site_settings/reseller_upgrade')) || {};
    const pct = cfg.commissionPct != null ? Number(cfg.commissionPct) : 1;
    if (!(pct > 0)) return;
    const c = Math.round(amount * pct) / 100; if (!(c > 0)) return;
    if (!(await db.get(`users/${refUid}/username`))) return;
    try { await wallet.credit(refUid, c, { type: 'Commission', description: `Referral commission from ${user.username}`, source: 'referral', orderId }); } catch (e) { log.warn('commission failed', e.message); }
  }

  /**
   * @returns {Promise<{order:object, keys:string[], duplicate?:boolean}>}
   */
  async function create({ uid, productKey, pid, planKey, duration, qty, idem, source = 'web', apiClientId = null, ip = '' }) {
    qty = parseInt(qty, 10);
    if (!(qty >= 1 && qty <= 100)) throw bad('Quantity must be between 1 and 100', 'bad_quantity');
    const maint = await db.get('site_settings/maintenance');
    if (maint && maint.enabled) throw new HttpError(503, maint.message || 'Site is under maintenance', 'maintenance');
    const user = await db.get(`users/${uid}`); if (!user) throw unauthorized('Account not found');
    if (user.banned === true || user.status === 'Banned') throw forbidden('Your account is suspended/banned');
    if (user.status === 'OFF') throw forbidden('Your reseller panel is switched OFF by admin');

    if (!productKey && pid) productKey = await catalog.findByPid(pid);
    if (!productKey) throw notFound('Product not found (check PID ID)');
    const [p] = await catalog.loadAll(productKey);
    if (!p) throw notFound('Product not found');
    if (p.status === 'INACTIVE') throw conflict('This product is inactive', 'product_inactive');
    if (p.maintenance) throw conflict('This product is under maintenance', 'product_maintenance');
    let plan = planKey ? p.plans.find((x) => x.pk === planKey) : null;
    if (!plan && duration) plan = p.plans.find((x) => durKey(x.duration) === durKey(duration));
    if (!plan) throw notFound('Duration/plan not found for this product');
    const route = catalog.routeFor(plan, qty);
    if (!route) throw conflict(plan.stock > 0 ? `Only ${plan.stock} key(s) in stock` : 'Out of stock', 'out_of_stock');

    const isRes = user.role === 'Reseller';
    const unit = round2(isRes && plan.rprice != null ? plan.rprice : plan.price);
    const total = round2(unit * qty);
    if (!(total > 0)) throw conflict('This plan has no price set', 'no_price');

    let idemPath = null;
    if (idem) {
      idemPath = `order_idem/${uid}/${sha256(String(idem)).slice(0, 32)}`;
      const c = await db.transaction(idemPath, (cur) => (cur ? undefined : { orderId: '', ts: now() }));
      if (!c.committed) {
        const ex = c.value;
        if (ex && ex.orderId) { const o = await db.get(`orders/${ex.orderId}`); return { order: o, keys: o.keys || [], duplicate: true }; }
        throw conflict('A request with this idempotency key is still in progress', 'idempotency_in_progress');
      }
    }
    const releaseIdem = async () => { if (idemPath) { try { await db.remove(idemPath); } catch {} } };

    const orderId = randId('ORD');
    const base = {
      id: orderId, uid, username: user.username || '', source, apiClientId, productKey, pid: p.pid, productName: p.name, planKey: plan.pk, duration: plan.duration,
      qty, unitPrice: unit, total, role: user.role || 'User', status: 'pending_payment', deliveryType: route.type, createdAt: now(), ip,
    };
    await db.set(`orders/${orderId}`, base);
    const d = await wallet.debit(uid, total, { type: 'Generation', description: `Generated ${qty} Key for ${p.name}`, source, orderId });
    if (!d.ok) { await db.remove(`orders/${orderId}`); await releaseIdem(); throw new HttpError(402, `Insufficient balance. Required ${money(total)}, available ${money(d.balance)}`, 'insufficient_funds'); }
    await db.update(`orders/${orderId}`, { status: 'processing', debitTx: d.txId, balanceAfter: d.balance });
    if (idemPath) await db.update(idemPath, { orderId });

    const refund = async (amt, why) => { if (!(amt > 0)) return; const r = await wallet.credit(uid, amt, { type: 'Refund', description: `Refund: ${why} (${p.name})`, source: 'system', orderId }); await db.update(`orders/${orderId}`, { refunded: round2((await db.get(`orders/${orderId}/refunded`)) || 0) + round2(amt), balanceAfter: r.balance }); };

    let keys = [], stockTaken = null, supplierId = null, mappingId = null, cost = 0, lastErr = null;
    try {
      if (route.type === 'stock') {
        stockTaken = await takeStock(productKey, plan.pk, qty);
        if (stockTaken) keys = stockTaken.map((t) => String(t.key));
      }
      if (!keys.length && plan.mappings.length) {
        for (const m of plan.mappings) {
          try { const r = await suppliers.buy(m.supplierId, m, qty, orderId); keys = r.keys.slice(0, qty); supplierId = m.supplierId; mappingId = m.id; cost = round2(num(m.cost) * keys.length); break; }
          catch (e) { lastErr = e; }
        }
      }
      if (!keys.length) throw lastErr || new HttpError(409, 'Stock ended, please try again', 'out_of_stock');
    } catch (e) {
      await refund(total, e.code === 'out_of_stock' ? 'out of stock' : 'delivery failed');
      await db.update(`orders/${orderId}`, { status: 'failed', failReason: e.message, failedAt: now() });
      telegram.notify('order', `⚠️ <b>Order failed</b> ${esc(orderId)}\n@${esc(user.username)} · ${esc(p.name)} (PID ${esc(p.pid)}) ×${qty}\n${esc(e.message)}\nRefunded ${money(total)}`, { uid });
      throw e instanceof HttpError ? e : new HttpError(502, 'Delivery failed, amount refunded', 'delivery_failed');
    }

    const got = keys.length;
    try {
      const ts = new Date().toISOString();
      const ups = {};
      keys.forEach((k) => { ups[`users/${uid}/generatedKeys/${pushKey()}`] = { product: p.name, pid: p.pid, duration: plan.duration, qty: 1, keyCode: k, timestamp: ts, source: 'stock', supplier: !!supplierId, price: unit, orderId }; });
      await db.update('', ups);
      await db.transaction(`users/${uid}/keyCount`, (c) => (Number(c) || 0) + got);
    } catch (e) { log.error('[orders] could not write legacy key records', orderId, e.message); }
    const refundAmt = got < qty ? round2(unit * (qty - got)) : 0;
    const delivered = round2(unit * got);
    const order = { status: got < qty ? 'partial' : 'delivered', keys, deliveredQty: got, total: delivered, supplierId, mappingId, cost, profit: round2(delivered - cost), deliveredAt: now() };
    try { await db.update(`orders/${orderId}`, order); }
    catch (e) { log.error('[orders] CRITICAL could not save order keys', orderId, JSON.stringify(keys)); throw new HttpError(500, 'Order saved partially. Contact support with order ' + orderId, 'order_save_failed'); }
    if (refundAmt > 0) await refund(refundAmt, 'supplier delivered fewer keys than requested');
    await payReferral(user, uid, delivered, orderId);

    telegram.notify('order', `🛒 <b>New order</b> ${esc(orderId)}\n@${esc(user.username)} · ${esc(p.name)} · PID <b>${esc(p.pid)}</b>\n${esc(plan.duration)} ×${got} · ${money(delivered)} · ${source.toUpperCase()}`, { adminToo: true });
    telegram.notify('delivery', `✅ <b>Delivered</b> ${esc(p.name)} (${esc(plan.duration)}) ×${got}. Open your panel → Key History.`, { uid, adminToo: false });
    return { order: { ...base, ...order, id: orderId }, keys };
  }

  async function refundOrder(orderId, by, reason) {
    const o = await db.get(`orders/${orderId}`); if (!o) throw notFound('Order not found');
    const left = round2((o.total || 0) - (o.refunded || 0));
    if (o.status === 'refunded' || !(left > 0)) throw conflict('Order already fully refunded');
    if (o.status === 'failed') throw conflict('Failed orders are refunded automatically');
    await wallet.credit(o.uid, left, { type: 'Refund', description: `Admin refund for ${orderId}${reason ? ': ' + reason : ''}`, source: 'admin', orderId, by });
    await db.update(`orders/${orderId}`, { status: 'refunded', refunded: round2((o.refunded || 0) + left), refundedAt: now(), refundedBy: by, refundReason: reason || '' });
    return { refunded: left };
  }

  /** Admin finishes a stuck order by supplying the keys manually (wallet was already debited). */
  async function manualDeliver(orderId, keys, by) {
    const o = await db.get(`orders/${orderId}`); if (!o) throw notFound('Order not found');
    if (!['processing', 'needs_review', 'pending_payment'].includes(o.status)) throw conflict('Only stuck orders can be delivered manually');
    keys = [...new Set((keys || []).map((k) => String(k).trim()).filter(Boolean))]; if (!keys.length) throw bad('Provide at least one key');
    const ts = new Date().toISOString(); const ups = {};
    for (const k of keys) ups[`users/${o.uid}/generatedKeys/${pushKey()}`] = { product: o.productName, pid: o.pid, duration: o.duration, qty: 1, keyCode: k, timestamp: ts, source: 'stock', price: o.unitPrice, orderId };
    ups[`orders/${orderId}/status`] = 'delivered'; ups[`orders/${orderId}/keys`] = keys; ups[`orders/${orderId}/deliveredQty`] = keys.length; ups[`orders/${orderId}/deliveredAt`] = now(); ups[`orders/${orderId}/manualBy`] = by;
    await db.update('', ups);
    return { delivered: keys.length };
  }

  /** Orders that never finished (server crash mid-flight) are flagged for admin review - never auto-refunded because a supplier may have delivered. */
  async function sweepStuck() {
    const cut = now() - 10 * 60 * 1000; let n = 0;
    for (const st of ['processing', 'pending_payment']) {
      const o = await db.queryEq('orders', 'status', st);
      for (const [id, v] of Object.entries(o)) if (v.createdAt < cut) { await db.update(`orders/${id}`, { status: 'needs_review' }); n++; }
    }
    return n;
  }

  return { create, refundOrder, manualDeliver, sweepStuck };
}

module.exports = { createOrders };
