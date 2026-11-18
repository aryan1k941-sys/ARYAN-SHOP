'use strict';
/**
 * Supplier panels (upstream key sellers). Credentials are AES-256-GCM encrypted in suppliers/{id}/secrets and never returned to browsers
 * except through the explicit, password-confirmed, audited "reveal" admin action.
 *
 * Request format is configurable. PRESET "reseller_v1" reproduces the call your existing site already made:
 *   POST <apiUrl>  (form)  api_key, action=buy, product_id, duration, quantity   + header x-master-key
 * Other providers: choose "custom" and set field names exactly as in THEIR documentation. Nothing is guessed.
 */
const { HttpError, bad, notFound, encrypt, decrypt, mask, now, str, getPath, randId, num } = require('../lib');

const PRESETS = {
  reseller_v1: {
    label: 'Reseller API v1 (form POST + x-master-key) - same as the previous ARYAN integration',
    apiUrl: 'https://bantibhaiya.to/api/reseller_v1.php', bodyFormat: 'form', authMode: 'body', masterHeader: 'x-master-key',
    fields: { apiKey: 'api_key', action: 'action', pid: 'product_id', duration: 'duration', qty: 'quantity' }, buyAction: 'buy', balanceAction: '',
    keysPath: 'keys', singleKeyPath: 'key', errorPath: 'message',
  },
  custom: { label: 'Custom (set everything per provider documentation)', apiUrl: '', bodyFormat: 'form', authMode: 'body', masterHeader: '', fields: { apiKey: 'api_key', action: 'action', pid: 'product_id', duration: 'duration', qty: 'quantity' }, buyAction: 'buy', balanceAction: '', keysPath: 'keys', singleKeyPath: 'key', errorPath: 'message' },
};

function createSuppliers({ db, net }) {
  const getSecrets = (s) => ({ apiKey: decrypt(s.secrets && s.secrets.apiKeyEnc), password: decrypt(s.secrets && s.secrets.passwordEnc), masterKey: decrypt(s.secrets && s.secrets.masterKeyEnc) });

  function view(id, s) {
    const sec = s.secrets || {};
    return {
      id, name: s.name, enabled: s.enabled !== false, priority: num(s.priority, 100), preset: s.preset || 'custom', apiUrl: s.apiUrl || '', balanceUrl: s.balanceUrl || '', balanceAction: s.balanceAction || '', balancePath: s.balancePath || '',
      bodyFormat: s.bodyFormat || 'form', authMode: s.authMode || 'body', masterHeader: s.masterHeader || '', buyAction: s.buyAction || 'buy', fields: s.fields || PRESETS.custom.fields,
      keysPath: s.keysPath || 'keys', singleKeyPath: s.singleKeyPath || 'key', errorPath: s.errorPath || 'message', extraFields: s.extraFields || {},
      username: s.username || '', apiKeyMask: sec.apiKeyEnc ? mask(decrypt(sec.apiKeyEnc)) : '', passwordMask: sec.passwordEnc ? mask('x'.repeat(12)) : '', masterKeyMask: sec.masterKeyEnc ? mask('x'.repeat(12)) : '',
      status: s.status || 'unknown', statusNote: s.statusNote || '', lastTestAt: s.lastTestAt || null, lastBalance: s.lastBalance ?? null, stats: s.stats || { ok: 0, failed: 0 }, createdAt: s.createdAt || null,
    };
  }

  async function list() { const all = (await db.get('suppliers')) || {}; return Object.entries(all).map(([id, s]) => view(id, s)).sort((a, b) => a.priority - b.priority); }

  async function save(id, d) {
    const cur = id ? await db.get(`suppliers/${id}`) : null; if (id && !cur && !d.createWithId) throw notFound('Supplier not found');
    const preset = PRESETS[d.preset] ? d.preset : (cur && cur.preset) || 'custom';
    const base = PRESETS[preset];
    const name = str(d.name, 80); if (!name) throw bad('Supplier name is required');
    const apiUrl = str(d.apiUrl || (cur && cur.apiUrl) || base.apiUrl, 400);
    if (apiUrl) await net.assertSafeUrl(apiUrl);
    const balanceUrl = str(d.balanceUrl, 400); if (balanceUrl) await net.assertSafeUrl(balanceUrl);
    const f = { ...base.fields, ...((cur && cur.fields) || {}), ...(d.fields || {}) };
    for (const k of Object.keys(f)) f[k] = str(f[k], 40);
    let extra = d.extraFields !== undefined ? d.extraFields : (cur && cur.extraFields) || {};
    if (typeof extra === 'string') { try { extra = extra.trim() ? JSON.parse(extra) : {}; } catch { throw bad('Extra fields must be valid JSON, e.g. {"android_id":"abc"}'); } }
    if (typeof extra !== 'object' || Array.isArray(extra)) throw bad('Extra fields must be a JSON object');
    const rec = {
      ...(cur || {}), name, preset, enabled: d.enabled !== false, priority: Math.max(1, parseInt(d.priority, 10) || 100), apiUrl, balanceUrl,
      balanceAction: str(d.balanceAction ?? base.balanceAction, 40), balancePath: str(d.balancePath, 60), bodyFormat: d.bodyFormat === 'json' ? 'json' : 'form',
      authMode: ['body', 'bearer', 'basic'].includes(d.authMode) ? d.authMode : (base.authMode || 'body'), masterHeader: str(d.masterHeader ?? base.masterHeader, 60),
      buyAction: str(d.buyAction ?? base.buyAction, 40), fields: f, keysPath: str(d.keysPath || base.keysPath, 60), singleKeyPath: str(d.singleKeyPath || base.singleKeyPath, 60), errorPath: str(d.errorPath || base.errorPath, 60),
      extraFields: extra, username: str(d.username ?? (cur && cur.username) ?? '', 120), updatedAt: now(), createdAt: (cur && cur.createdAt) || now(),
    };
    const sec = { ...((cur && cur.secrets) || {}) };
    if (d.apiKey) sec.apiKeyEnc = encrypt(String(d.apiKey).trim());
    if (d.password) sec.passwordEnc = encrypt(String(d.password));
    if (d.masterKey) sec.masterKeyEnc = encrypt(String(d.masterKey).trim());
    rec.secrets = sec;
    if (!rec.stats) rec.stats = { ok: 0, failed: 0 };
    const sid = id || randId('SUP', 3);
    await db.set(`suppliers/${sid}`, rec);
    return sid;
  }

  async function remove(id) {
    const maps = (await db.get('pid_mappings')) || {};
    if (Object.values(maps).some((m) => m && m.supplierId === id)) throw new HttpError(409, 'Remove or re-map this supplier\'s PID mappings first', 'in_use');
    await db.remove(`suppliers/${id}`);
  }

  function redactor(secrets) {
    const vals = Object.values(secrets).filter((v) => v && String(v).length >= 4);
    return (text) => { let t = String(text ?? ''); for (const v of vals) t = t.split(v).join('[redacted]'); return t; };
  }

  function buildRequest(s, secrets, params) {
    const f = s.fields || PRESETS.custom.fields; const headers = {};
    const data = { ...(s.extraFields || {}) };
    if (s.authMode === 'bearer') headers.Authorization = `Bearer ${secrets.apiKey}`;
    else if (s.authMode === 'basic') headers.Authorization = 'Basic ' + Buffer.from(`${s.username || ''}:${secrets.password || secrets.apiKey}`).toString('base64');
    else if (secrets.apiKey) data[f.apiKey || 'api_key'] = secrets.apiKey;
    if (s.masterHeader && secrets.masterKey) headers[s.masterHeader] = secrets.masterKey;
    Object.assign(data, params);
    let body;
    if (s.bodyFormat === 'json') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(data); }
    else { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(Object.entries(data).map(([k, v]) => [k, String(v)])).toString(); }
    return { headers, body, data };
  }

  async function log(rec) { try { await db.push('supplier_logs', { ts: now(), ...rec }); } catch {} }
  async function bump(id, ok) { try { await db.transaction(`suppliers/${id}/stats/${ok ? 'ok' : 'failed'}`, (c) => (Number(c) || 0) + 1); } catch {} }

  /** Buy `qty` keys for a mapping. Throws HttpError(502) on supplier failure (caller refunds). */
  async function buy(supplierId, mapping, qty, orderId) {
    const s = await db.get(`suppliers/${supplierId}`); if (!s) throw notFound('Supplier not found');
    const secrets = getSecrets(s); const red = redactor(secrets); const f = s.fields || PRESETS.custom.fields;
    const params = { [f.action || 'action']: s.buyAction || 'buy', [f.pid || 'product_id']: mapping.supplierPid, [f.duration || 'duration']: mapping.supplierDuration, [f.qty || 'quantity']: String(qty) };
    const { headers, body, data } = buildRequest(s, secrets, params);
    const sent = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, red(v)]));
    let r;
    try { r = await net.safeFetch(s.apiUrl, { method: 'POST', headers, body, timeoutMs: 25000 }); }
    catch (e) { await log({ supplierId, kind: 'buy', orderId, ok: false, error: e.message, request: sent }); await bump(supplierId, false); throw new HttpError(502, 'Supplier unreachable', 'supplier_unreachable'); }
    let keys = [];
    if (r.json) {
      const k = getPath(r.json, s.keysPath || 'keys'); const one = getPath(r.json, s.singleKeyPath || 'key');
      keys = Array.isArray(k) ? k.filter(Boolean).map(String) : (one ? [String(one)] : []);
    }
    const ok = r.ok && keys.length > 0;
    const msg = r.json ? String(getPath(r.json, s.errorPath || 'message') || getPath(r.json, 'error') || '') : '';
    await log({ supplierId, kind: 'buy', orderId, ok, httpStatus: r.status, ms: r.ms, request: sent, response: red(r.text).slice(0, 600), error: ok ? '' : (msg || 'No keys returned') });
    await bump(supplierId, ok);
    if (!ok) throw new HttpError(502, red(msg) || 'Supplier did not return a key', 'supplier_failed');
    return { keys, partial: keys.length < qty };
  }

  async function checkBalance(supplierId) {
    const s = await db.get(`suppliers/${supplierId}`); if (!s) throw notFound('Supplier not found');
    if (!(s.balanceUrl || s.balanceAction)) throw new HttpError(400, 'Balance check is not configured. Add the balance endpoint/action from the supplier documentation.', 'not_configured');
    const secrets = getSecrets(s); const red = redactor(secrets); const f = s.fields || PRESETS.custom.fields;
    const { headers, body } = buildRequest(s, secrets, s.balanceAction ? { [f.action || 'action']: s.balanceAction } : {});
    const url = s.balanceUrl || s.apiUrl;
    let r; try { r = await net.safeFetch(url, { method: 'POST', headers, body }); } catch (e) { await log({ supplierId, kind: 'balance', ok: false, error: e.message }); throw e; }
    const bal = s.balancePath && r.json ? getPath(r.json, s.balancePath) : undefined;
    const ok = r.ok && r.json != null;
    await log({ supplierId, kind: 'balance', ok, httpStatus: r.status, ms: r.ms, response: red(r.text).slice(0, 400) });
    await db.update(`suppliers/${supplierId}`, { lastBalance: bal !== undefined ? bal : null, lastTestAt: now() });
    if (!ok) throw new HttpError(502, 'Supplier rejected the balance request (check credentials)', 'supplier_failed');
    return { balance: bal !== undefined ? bal : null, raw: bal === undefined ? red(r.text).slice(0, 300) : undefined };
  }

  async function test(supplierId) {
    const s = await db.get(`suppliers/${supplierId}`); if (!s) throw notFound('Supplier not found');
    const t = now(); let status, note, extra = {};
    try {
      if (s.balanceUrl || s.balanceAction) { const b = await checkBalance(supplierId); status = 'connected'; note = b.balance != null ? `Authenticated. Balance: ${b.balance}` : 'Authenticated (balance field not mapped)'; extra = b; }
      else {
        const r = await net.safeFetch(s.apiUrl, { method: 'GET', timeoutMs: 12000 });
        status = 'reachable'; note = `Server reachable (HTTP ${r.status}). Credentials NOT verified - configure a balance endpoint to verify them.`;
      }
    } catch (e) { status = 'error'; note = e.message; }
    await db.update(`suppliers/${supplierId}`, { status, statusNote: note, lastTestAt: t });
    return { status, note, ...extra };
  }

  async function reveal(supplierId) {
    const s = await db.get(`suppliers/${supplierId}`); if (!s) throw notFound('Supplier not found');
    const x = getSecrets(s); return { username: s.username || '', apiKey: x.apiKey, password: x.password, masterKey: x.masterKey };
  }

  return { PRESETS, list, save, remove, buy, checkBalance, test, reveal, view, getSecrets };
}

module.exports = { createSuppliers, PRESETS };
