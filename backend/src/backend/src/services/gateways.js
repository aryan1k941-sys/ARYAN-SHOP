'use strict';
/**
 * Payment gateways (configurable, unlimited) + the deposit pipeline.
 *
 * Money rule: a payment is ONLY credited after the backend asks the provider (verify endpoint) and the provider says "paid"
 * for the right order id and amount. A user returning from the payment page, a browser call, or a webhook body is never trusted by itself.
 *
 * PRESET "zapupi" reproduces the request/response format your existing site already used with pay.zapupi.com:
 *   create : GET  <base>/api/qr.php?api_key&amount&customer_name&customer_phone&redirect_url  -> {status:"success", data:{order_id, checkout_url, amount, payable_amount}}
 *   verify : GET  <base>/api/verify-order.php?api_key&order_id                               -> {status:"success"|"expired"|"unauthorized"|..., data:{amount, utr}}
 * "generic" lets the admin map any other provider from ITS official documentation (endpoints, parameter names, response paths).
 * We do not invent provider formats: FAM Gateway ships unconfigured until its documentation values are entered.
 */
const crypto = require('node:crypto');
const { HttpError, bad, notFound, conflict, encrypt, decrypt, mask, now, str, round2, num, randId, slug, getPath, safeEqual, esc } = require('../lib');

const PRESETS = {
  zapupi: {
    label: 'ZapUPI / pay.zapupi.com (format used by the previous ARYAN integration)',
    baseUrl: 'http://pay.zapupi.com', createEndpoint: '/api/qr.php', verifyEndpoint: '/api/verify-order.php', createMethod: 'GET', verifyMethod: 'GET',
    params: { apiKey: 'api_key', amount: 'amount', name: 'customer_name', phone: 'customer_phone', redirect: 'redirect_url', orderId: 'order_id' },
    resp: { okPath: 'status', okValue: 'success', orderIdPath: 'data.order_id', checkoutPath: 'data.checkout_url', amountPath: 'data.amount', payablePath: 'data.payable_amount', messagePath: 'message',
      statusPath: 'status', paidValues: 'success', expiredValues: 'expired', unauthValues: 'unauthorized', verifyAmountPath: 'data.amount', utrPath: 'data.utr' },
    expiresInSec: 300,
  },
  generic: {
    label: 'Generic (fill from the provider documentation)', baseUrl: '', createEndpoint: '', verifyEndpoint: '', createMethod: 'GET', verifyMethod: 'GET',
    params: { apiKey: 'api_key', amount: 'amount', name: 'customer_name', phone: 'customer_phone', redirect: 'redirect_url', orderId: 'order_id' },
    resp: { okPath: 'status', okValue: 'success', orderIdPath: '', checkoutPath: '', amountPath: '', payablePath: '', messagePath: 'message', statusPath: 'status', paidValues: 'success', expiredValues: 'expired', unauthValues: 'unauthorized', verifyAmountPath: '', utrPath: '' },
    expiresInSec: 900,
  },
};
const list = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const FINAL = new Set(['success', 'failed', 'expired', 'cancelled']);

function createGateways({ db, net, wallet, telegram, cfg, log }) {
  function isConfigured(g) {
    return !!(g.baseUrl && g.createEndpoint && g.verifyEndpoint && g.secrets && g.secrets.apiKeyEnc && g.resp && g.resp.orderIdPath && g.resp.checkoutPath && g.resp.verifyAmountPath !== undefined);
  }
  function view(id, g) {
    return {
      id, name: g.name, preset: g.preset || 'generic', enabled: !!g.enabled, priority: num(g.priority, 100), baseUrl: g.baseUrl || '', createEndpoint: g.createEndpoint || '', verifyEndpoint: g.verifyEndpoint || '',
      createMethod: g.createMethod || 'GET', verifyMethod: g.verifyMethod || 'GET', min: num(g.min, 1), max: num(g.max, 50000), params: g.params || PRESETS.generic.params, resp: g.resp || PRESETS.generic.resp,
      expiresInSec: num(g.expiresInSec, 300), apiKeyMask: g.secrets && g.secrets.apiKeyEnc ? mask('x'.repeat(14)) : '', webhookSecretSet: !!(g.secrets && g.secrets.webhookSecretEnc), webhookHeader: g.webhookHeader || '', webhookOrderIdPath: g.webhookOrderIdPath || '',
      configured: isConfigured(g), needsDocs: !isConfigured(g), status: g.status || 'unknown', statusNote: g.statusNote || '', lastTestAt: g.lastTestAt || null, stats: g.stats || { created: 0, failed: 0, paid: 0 }, webhookPath: `/webhooks/payment/${id}`,
    };
  }
  async function listAll() { const all = (await db.get('payment_gateways')) || {}; return Object.entries(all).map(([id, g]) => view(id, g)).sort((a, b) => a.priority - b.priority); }

  async function save(id, d) {
    const cur = id ? await db.get(`payment_gateways/${id}`) : null; if (id && !cur && !d.createWithId) throw notFound('Gateway not found');
    const preset = PRESETS[d.preset] ? d.preset : (cur && cur.preset) || 'generic'; const base = PRESETS[preset];
    const name = str(d.name, 60); if (!name) throw bad('Gateway name is required');
    const baseUrl = str(d.baseUrl ?? (cur && cur.baseUrl) ?? base.baseUrl, 300).replace(/\/$/, ''); if (baseUrl) await net.assertSafeUrl(baseUrl);
    const ep = (k) => { const v = str(d[k] ?? (cur && cur[k]) ?? base[k] ?? '', 200); if (v && !v.startsWith('/')) throw bad(`${k} must start with /`); return v; };
    const params = { ...base.params, ...((cur && cur.params) || {}), ...(d.params || {}) }; for (const k of Object.keys(params)) params[k] = str(params[k], 40);
    const resp = { ...base.resp, ...((cur && cur.resp) || {}), ...(d.resp || {}) }; for (const k of Object.keys(resp)) resp[k] = str(resp[k], 80);
    const min = Math.max(0.01, round2(d.min ?? (cur && cur.min) ?? 1)); const max = round2(d.max ?? (cur && cur.max) ?? 50000);
    if (!(max > min)) throw bad('Maximum amount must be greater than minimum');
    const rec = {
      ...(cur || {}), name, preset, enabled: !!d.enabled, priority: Math.max(1, parseInt(d.priority, 10) || 100), baseUrl, createEndpoint: ep('createEndpoint'), verifyEndpoint: ep('verifyEndpoint'),
      createMethod: d.createMethod === 'POST' ? 'POST' : 'GET', verifyMethod: d.verifyMethod === 'POST' ? 'POST' : 'GET', min, max, params, resp, expiresInSec: Math.min(3600, Math.max(60, parseInt(d.expiresInSec, 10) || base.expiresInSec || 300)),
      webhookHeader: str(d.webhookHeader ?? (cur && cur.webhookHeader) ?? '', 60).toLowerCase(), webhookOrderIdPath: str(d.webhookOrderIdPath ?? (cur && cur.webhookOrderIdPath) ?? '', 60), updatedAt: now(), createdAt: (cur && cur.createdAt) || now(),
    };
    const sec = { ...((cur && cur.secrets) || {}) };
    if (d.apiKey) sec.apiKeyEnc = encrypt(String(d.apiKey).trim());
    if (d.webhookSecret) sec.webhookSecretEnc = encrypt(String(d.webhookSecret).trim());
    rec.secrets = sec; if (!rec.stats) rec.stats = { created: 0, failed: 0, paid: 0 };
    if (rec.enabled && !isConfigured(rec)) throw bad('Cannot enable: this gateway is not fully configured (base URL, create/verify endpoints, API key and response paths are required - copy them from the provider documentation).', 'not_configured');
    const gid = id || randId('GW', 3);
    await db.set(`payment_gateways/${gid}`, rec);
    return gid;
  }
  async function remove(id) {
    const pend = await db.queryEq('auto_payments', 'gatewayId', id);
    if (Object.values(pend).some((p) => p.status === 'pending')) throw conflict('This gateway has pending payments - disable it instead of deleting', 'in_use');
    await db.remove(`payment_gateways/${id}`);
  }

  /* ---------- provider calls ---------- */
  const apiKeyOf = (g) => decrypt(g.secrets && g.secrets.apiKeyEnc);
  async function providerCall(g, kind, fields) {
    const p = g.params || PRESETS.generic.params; const method = kind === 'create' ? g.createMethod : g.verifyMethod; const ep = kind === 'create' ? g.createEndpoint : g.verifyEndpoint;
    const data = { [p.apiKey]: apiKeyOf(g), ...fields }; const url = new URL(g.baseUrl + ep);
    let init;
    if (method === 'POST') init = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.entries(data).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString() };
    else { for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v)); init = { method: 'GET' }; }
    const r = await net.safeFetch(url.toString(), { ...init, timeoutMs: 20000 });
    if (!r.json) throw new HttpError(502, 'Gateway returned an unreadable response', 'gateway_bad_response');
    return r.json;
  }
  async function bumpStat(id, k) { try { await db.transaction(`payment_gateways/${id}/stats/${k}`, (c) => (Number(c) || 0) + 1); } catch {} }

  async function gwCreate(id, g, { amount, name, phone, redirect }) {
    const p = g.params; const r = g.resp;
    const j = await providerCall(g, 'create', { [p.amount]: amount.toFixed(2), [p.name]: name, [p.phone]: phone, [p.redirect]: redirect });
    if (String(getPath(j, r.okPath)) !== String(r.okValue)) throw new HttpError(502, String(getPath(j, r.messagePath) || 'Gateway could not create the order'), 'gateway_rejected');
    const orderId = getPath(j, r.orderIdPath), checkoutUrl = getPath(j, r.checkoutPath);
    if (!orderId || !checkoutUrl) throw new HttpError(502, 'Gateway response is missing order id / checkout URL', 'gateway_bad_response');
    if (!/^https?:\/\//i.test(String(checkoutUrl))) throw new HttpError(502, 'Gateway returned an invalid checkout URL', 'gateway_bad_response');
    const got = r.amountPath ? Number(getPath(j, r.amountPath)) : amount;
    if (Number.isFinite(got) && Math.abs(got - amount) > 0.009) throw new HttpError(502, 'Gateway amount mismatch', 'gateway_amount_mismatch');
    const payable = r.payablePath ? Number(getPath(j, r.payablePath)) : amount;
    return { orderId: String(orderId), checkoutUrl: String(checkoutUrl), payable: Number.isFinite(payable) ? payable : amount };
  }
  /** -> { state: 'paid'|'expired'|'pending'|'unauthorized', amount, utr } */
  async function gwVerify(g, gatewayOrderId) {
    const r = g.resp; const j = await providerCall(g, 'verify', { [g.params.orderId]: gatewayOrderId });
    const st = String(getPath(j, r.statusPath) ?? '').toLowerCase();
    if (list(r.unauthValues).includes(st)) return { state: 'unauthorized' };
    if (list(r.paidValues).includes(st)) return { state: 'paid', amount: Number(getPath(j, r.verifyAmountPath)), utr: String(getPath(j, r.utrPath) || '') };
    if (list(r.expiredValues).includes(st)) return { state: 'expired' };
    return { state: 'pending' };
  }

  async function test(id) {
    const g = await db.get(`payment_gateways/${id}`); if (!g) throw notFound('Gateway not found');
    if (!isConfigured(g)) { await db.update(`payment_gateways/${id}`, { status: 'not_configured', statusNote: 'Documentation values missing', lastTestAt: now() }); return { status: 'not_configured', note: 'Gateway is not configured yet - enter base URL, endpoints, API key and response paths from the provider documentation.' }; }
    let status, note;
    try {
      const v = await gwVerify(g, 'ARYAN-TEST-' + Date.now());
      if (v.state === 'unauthorized') { status = 'error'; note = 'Provider says the API key is not authorised.'; } else { status = 'connected'; note = 'Provider reachable and API key accepted (checked with a test order id; no money moved).'; }
    } catch (e) { status = 'error'; note = e.message; }
    await db.update(`payment_gateways/${id}`, { status, statusNote: note, lastTestAt: now() });
    return { status, note };
  }
  async function reveal(id) { const g = await db.get(`payment_gateways/${id}`); if (!g) throw notFound('Gateway not found'); return { apiKey: apiKeyOf(g), webhookSecret: decrypt(g.secrets && g.secrets.webhookSecretEnc) }; }

  /* ---------- deposits ---------- */
  async function candidates(amount) {
    const all = (await db.get('payment_gateways')) || {};
    return Object.entries(all).filter(([, g]) => g.enabled && isConfigured(g) && amount >= num(g.min, 1) && amount <= num(g.max, 50000)).sort((a, b) => num(a[1].priority, 100) - num(b[1].priority, 100));
  }
  async function publicInfo() {
    const all = (await db.get('payment_gateways')) || {}; const on = Object.values(all).filter((g) => g.enabled && isConfigured(g));
    if (!on.length) return { enabled: false, min: 0, max: 0, gateways: [] };
    return { enabled: true, min: Math.min(...on.map((g) => num(g.min, 1))), max: Math.max(...on.map((g) => num(g.max, 50000))), gateways: on.map((g) => g.name) };
  }

  async function create({ uid, amount, phone, returnUrl }) {
    amount = round2(amount); phone = String(phone || '').replace(/\D/g, '');
    if (!(amount > 0)) throw bad('Enter a valid amount');
    if (phone.length !== 10) throw bad('Enter a 10 digit mobile number');
    const user = await db.get(`users/${uid}`); if (!user) throw notFound('Account not found');
    if (user.banned === true || user.status === 'Banned') throw new HttpError(403, 'Your account is suspended', 'forbidden');
    // re-use a still-open payment for the same amount (stops duplicate orders from double clicks)
    const open = await db.queryEq('auto_payments', 'uid', uid);
    for (const [id, p] of Object.entries(open)) if (p.status === 'pending' && p.gatewayId && Math.abs(p.amount - amount) < 0.001 && p.expiresAt > now() + 15000 && p.checkoutUrl) return { payment: pubPayment(id, p), reused: true };
    const cand = await candidates(amount);
    if (!cand.length) throw new HttpError(503, 'Auto payment is not available for this amount right now', 'no_gateway');
    let lastErr = null; const tried = [];
    for (const [gid, g] of cand) {
      try {
        const o = await gwCreate(gid, g, { amount, name: String(user.username || 'user').slice(0, 60), phone, redirect: returnUrl });
        const dup = await db.get(`payment_by_gw/${slug(gid)}_${slug(o.orderId)}`); if (dup) throw new HttpError(502, 'Gateway returned a duplicate order id', 'gateway_duplicate');
        const paymentId = randId('PAY');
        const rec = { uid, username: user.username || '', amount, payable: o.payable, gatewayId: gid, gatewayName: g.name, gatewayOrderId: o.orderId, checkoutUrl: o.checkoutUrl, status: 'pending', credited: false, createdAt: now(), expiresAt: now() + num(g.expiresInSec, 300) * 1000 };
        await db.update('', { [`auto_payments/${paymentId}`]: rec, [`payment_by_gw/${slug(gid)}_${slug(o.orderId)}`]: paymentId });
        await bumpStat(gid, 'created'); await db.update(`payment_gateways/${gid}`, { status: 'connected', statusNote: 'Last order created successfully' });
        return { payment: pubPayment(paymentId, rec), fallbackFrom: tried };
      } catch (e) {
        lastErr = e; tried.push({ gateway: g.name, error: e.message }); await bumpStat(gid, 'failed');
        await db.update(`payment_gateways/${gid}`, { status: 'error', statusNote: e.message, lastTestAt: now() });
        log.warn('[payments] gateway', g.name, 'failed, trying next:', e.message);
      }
    }
    telegram.notify('admin', `🚨 <b>All payment gateways failed</b>\n${tried.map((t) => `${esc(t.gateway)}: ${esc(t.error)}`).join('\n')}`, { adminToo: true });
    throw new HttpError(502, 'Payment gateways are unavailable right now. Please try again in a few minutes.', 'gateways_down');
  }
  const pubPayment = (id, p) => ({ id, amount: p.amount, status: p.status, gateway: p.gatewayName || '', checkoutUrl: p.status === 'pending' ? p.checkoutUrl : undefined, createdAt: p.createdAt, expiresAt: p.expiresAt, reference: p.reference || '', note: p.note || '' });

  async function finish(paymentId, patch) { await db.update(`auto_payments/${paymentId}`, { ...patch, updatedAt: now() }); }

  /** Server-side verification with the provider. Safe to call repeatedly (poller, user button, webhook). */
  async function verify(paymentId) {
    const p = await db.get(`auto_payments/${paymentId}`); if (!p) throw notFound('Payment not found');
    if (FINAL.has(p.status) || p.status === 'mismatch' || p.status === 'review') return { payment: pubPayment(paymentId, p) };
    if (!p.gatewayId) return { payment: pubPayment(paymentId, p) }; // legacy record (pre-upgrade)
    const g = await db.get(`payment_gateways/${p.gatewayId}`); if (!g) throw new HttpError(502, 'Gateway no longer exists', 'gateway_missing');
    await db.update(`auto_payments/${paymentId}`, { lastCheckAt: now() });
    const v = await gwVerify(g, p.gatewayOrderId);
    if (v.state === 'unauthorized') { await db.update(`payment_gateways/${p.gatewayId}`, { status: 'error', statusNote: 'Provider rejected API key' }); throw new HttpError(502, 'Gateway credentials rejected - contact admin', 'gateway_unauthorized'); }
    if (v.state === 'expired') { await finish(paymentId, { status: 'expired' }); return { payment: pubPayment(paymentId, { ...p, status: 'expired' }) }; }
    if (v.state === 'paid') return creditPayment(paymentId, p, v);
    if (now() > p.expiresAt + 15 * 60 * 1000) { await finish(paymentId, { status: 'expired', note: 'No payment received' }); return { payment: pubPayment(paymentId, { ...p, status: 'expired' }) }; }
    return { payment: pubPayment(paymentId, p) };
  }

  async function creditPayment(paymentId, p, v) {
    const ok = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 0.015;
    if (!ok(v.amount, p.amount) && !ok(v.amount, p.payable)) { await finish(paymentId, { status: 'mismatch', note: `Provider paid ₹${v.amount} but order was ₹${p.amount}`, reference: v.utr || '' }); telegram.notify('admin', `⚠️ <b>Payment amount mismatch</b> ${esc(paymentId)} (@${esc(p.username)}): ordered ₹${p.amount}, provider says ₹${v.amount}. Review in admin → Payment Gateways.`); return { payment: pubPayment(paymentId, { ...p, status: 'mismatch' }) }; }
    if (v.utr) {
      const u = await db.transaction(`utr_index/${slug(v.utr)}`, (c) => (c && c !== paymentId ? undefined : paymentId));
      if (!u.committed) { await finish(paymentId, { status: 'review', note: 'This UTR/reference was already used for another payment', reference: v.utr }); telegram.notify('admin', `⚠️ <b>Duplicate UTR</b> ${esc(v.utr)} on ${esc(paymentId)} - not credited.`); return { payment: pubPayment(paymentId, { ...p, status: 'review' }) }; }
    }
    const claim = await db.transaction(`auto_payments/${paymentId}/credited`, (c) => (c ? undefined : true));
    if (!claim.committed) { const cur = await db.get(`auto_payments/${paymentId}`); return { payment: pubPayment(paymentId, cur), already: true }; }
    try {
      await wallet.credit(p.uid, p.amount, { type: 'Deposit', description: `Auto Payment Deposit (UPI) - ${p.gatewayOrderId}`, source: 'gateway', paymentId, ref: v.utr || '' });
    } catch (e) { await db.set(`auto_payments/${paymentId}/credited`, false); throw e; }
    await finish(paymentId, { status: 'success', paidAt: now(), reference: v.utr || '' });
    await bumpStat(p.gatewayId, 'paid');
    telegram.notify('payment', `💰 <b>Deposit received</b> ₹${p.amount.toFixed(2)}\n@${esc(p.username)} · ${esc(p.gatewayName)}${v.utr ? ' · UTR ' + esc(v.utr) : ''}`, { uid: p.uid });
    return { payment: pubPayment(paymentId, { ...p, status: 'success', reference: v.utr || '' }) };
  }

  async function cancel(uid, paymentId) {
    const p = await db.get(`auto_payments/${paymentId}`); if (!p || p.uid !== uid) throw notFound('Payment not found');
    if (p.status !== 'pending') throw conflict('Payment is not pending');
    await finish(paymentId, { status: 'cancelled' });
    return { ok: true };
  }

  /** Webhook entry: signature (when configured) is checked, then the provider is asked - the body itself is never trusted. */
  async function webhook(gatewayId, { rawBody, headers, body, query }) {
    const g = await db.get(`payment_gateways/${gatewayId}`); if (!g) throw notFound('Unknown gateway');
    const secret = decrypt(g.secrets && g.secrets.webhookSecretEnc);
    let signed = 'none';
    if (secret) {
      const hn = g.webhookHeader; const given = hn ? String(headers[hn] || '').replace(/^sha256=/i, '') : '';
      if (!given) throw new HttpError(401, 'Missing signature', 'bad_signature');
      const hex = crypto.createHmac('sha256', secret).update(rawBody || '').digest('hex'); const b64 = crypto.createHmac('sha256', secret).update(rawBody || '').digest('base64');
      if (!safeEqual(given, hex) && !safeEqual(given, b64)) throw new HttpError(401, 'Invalid signature', 'bad_signature');
      signed = 'hmac-sha256';
    }
    const merged = { ...(query || {}), ...(body || {}) };
    const oid = getPath(merged, g.webhookOrderIdPath || 'order_id') ?? getPath(merged, g.resp.orderIdPath) ?? merged.order_id ?? merged.orderId;
    if (!oid) return { ignored: true };
    const paymentId = await db.get(`payment_by_gw/${slug(gatewayId)}_${slug(oid)}`);
    if (!paymentId) return { ignored: true };
    await db.push('payment_events', { gatewayId, paymentId, signature: signed, ts: now() });
    const r = await verify(paymentId);
    return { status: r.payment.status };
  }

  /** Background: credits payments even if the user closed the browser; expires old ones. */
  async function pollPending() {
    const open = await db.queryEq('auto_payments', 'status', 'pending'); let n = 0;
    for (const [id, p] of Object.entries(open)) {
      if (!p.gatewayId || now() - (p.lastCheckAt || 0) < 8000) continue;
      if (now() - p.createdAt > 24 * 3600 * 1000) { await finish(id, { status: 'expired', note: 'Timed out' }); continue; }
      try { await verify(id); n++; } catch (e) { log.warn('[poll]', id, e.message); }
      if (n >= 25) break;
    }
    return n;
  }

  /** Admin: money verified by hand (e.g. after a mismatch). Always audited by the caller. */
  async function adminApprove(paymentId, by, reason) {
    const p = await db.get(`auto_payments/${paymentId}`); if (!p) throw notFound('Payment not found');
    if (!['mismatch', 'review', 'pending', 'expired'].includes(p.status)) throw conflict('Payment cannot be approved in its current state');
    if (!reason) throw bad('A reason is required');
    const claim = await db.transaction(`auto_payments/${paymentId}/credited`, (c) => (c ? undefined : true));
    if (!claim.committed) throw conflict('Already credited');
    try { await wallet.credit(p.uid, p.amount, { type: 'Deposit', description: `Manual approval of deposit ${p.gatewayOrderId || paymentId}`, source: 'admin', paymentId, by }); }
    catch (e) { await db.set(`auto_payments/${paymentId}/credited`, false); throw e; }
    await finish(paymentId, { status: 'success', paidAt: now(), approvedBy: by, note: `Manually approved: ${reason}` });
    return { ok: true };
  }

  return { PRESETS, listAll, save, remove, test, reveal, create, verify, cancel, webhook, pollPending, publicInfo, adminApprove, pubPayment, view };
}

module.exports = { createGateways, PRESETS };
