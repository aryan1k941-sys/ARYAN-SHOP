'use strict';
/**
 * REST API clients. Key format:  ak_<clientId>_<secret>.  Only a SHA-256 hash is used for authentication; an AES-GCM encrypted copy
 * is kept so the OWNER can re-display it after confirming their password (the reference panel has a "SHOW KEY" button).
 */
const crypto = require('node:crypto');
const net = require('node:net');
const { HttpError, bad, notFound, unauthorized, forbidden, encrypt, decrypt, sha256, safeEqual, now, rand, b64u, str, num, randId } = require('../lib');

const PERMS = ['products.read', 'balance.read', 'orders.create', 'orders.read'];
const DEFAULT_RATE = 60; // requests / minute

function ipToInt(ip) { const p = ip.split('.').map(Number); return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]; }
function ipAllowed(ip, list) {
  if (!list || !list.length) return true;
  ip = String(ip || '').replace(/^::ffff:/, '');
  return list.some((rule) => {
    if (rule === ip) return true;
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(rule);
    if (m && net.isIPv4(ip)) { const bits = +m[2]; const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; return (ipToInt(ip) & mask) === (ipToInt(m[1]) & mask); }
    return false;
  });
}
const parseIps = (v) => {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\s,]+/);
  const out = arr.map((x) => String(x).trim()).filter(Boolean);
  for (const r of out) if (!(net.isIP(r) || /^\d+\.\d+\.\d+\.\d+\/\d{1,2}$/.test(r))) throw bad(`Invalid IP/CIDR: ${r}`);
  return out;
};

function createApiClients({ db, rl }) {
  const view = (id, c) => ({
    id, name: c.name, uid: c.uid, username: c.username || '', enabled: c.enabled !== false, permissions: c.permissions || [], ipAllowlist: c.ipAllowlist || [], rateLimit: num(c.rateLimit, DEFAULT_RATE),
    keyPrefix: c.keyPrefix || '', createdAt: c.createdAt, lastUsedAt: c.lastUsedAt || null, requests: num(c.requests), selfService: !!c.selfService, revokedAt: c.revokedAt || null,
  });

  function makeKey(id) { const secret = b64u(rand(30)); return { key: `ak_${id}_${secret}`, secret }; }

  async function create({ name, uid, permissions, ipAllowlist, rateLimit, createdBy, selfService = false }) {
    const user = await db.get(`users/${uid}`); if (!user) throw notFound('Wallet owner (user) not found');
    const id = randId('C', 3).toLowerCase().replace(/[^a-z0-9]/g, '');
    const { key, secret } = makeKey(id);
    const perms = (permissions || PERMS).filter((p) => PERMS.includes(p));
    const rec = {
      name: str(name || `${user.username} API`, 60), uid, username: user.username || '', enabled: true, permissions: perms, ipAllowlist: parseIps(ipAllowlist), rateLimit: Math.min(1000, Math.max(1, parseInt(rateLimit, 10) || DEFAULT_RATE)),
      hash: sha256(secret), keyEnc: encrypt(key), keyPrefix: key.slice(0, 14) + '…', createdAt: now(), createdBy: createdBy || uid, selfService, requests: 0,
    };
    await db.set(`api_clients/${id}`, rec);
    return { id, key, client: view(id, rec) };
  }
  async function regenerate(id) {
    const c = await db.get(`api_clients/${id}`); if (!c) throw notFound('API client not found');
    const { key, secret } = makeKey(id);
    await db.update(`api_clients/${id}`, { hash: sha256(secret), keyEnc: encrypt(key), keyPrefix: key.slice(0, 14) + '…', enabled: true, revokedAt: null, regeneratedAt: now() });
    return { key };
  }
  async function revoke(id) { const c = await db.get(`api_clients/${id}`); if (!c) throw notFound('API client not found'); await db.update(`api_clients/${id}`, { enabled: false, revokedAt: now() }); }
  async function update(id, d) {
    const c = await db.get(`api_clients/${id}`); if (!c) throw notFound('API client not found');
    const ups = {};
    if (d.name !== undefined) ups.name = str(d.name, 60);
    if (d.enabled !== undefined) { ups.enabled = !!d.enabled; if (d.enabled) ups.revokedAt = null; }
    if (d.permissions) ups.permissions = d.permissions.filter((p) => PERMS.includes(p));
    if (d.ipAllowlist !== undefined) ups.ipAllowlist = parseIps(d.ipAllowlist);
    if (d.rateLimit !== undefined) ups.rateLimit = Math.min(1000, Math.max(1, parseInt(d.rateLimit, 10) || DEFAULT_RATE));
    await db.update(`api_clients/${id}`, ups);
  }
  async function revealKey(id) { const c = await db.get(`api_clients/${id}`); if (!c || !c.keyEnc) throw notFound('API key not found'); return decrypt(c.keyEnc); }
  async function remove(id) { await db.remove(`api_clients/${id}`); }
  async function list() { const all = (await db.get('api_clients')) || {}; return Object.entries(all).map(([id, c]) => view(id, c)).sort((a, b) => b.createdAt - a.createdAt); }
  async function forUser(uid) { const m = await db.queryEq('api_clients', 'uid', uid); const e = Object.entries(m).filter(([, c]) => c.selfService); return e.length ? view(e[0][0], e[0][1]) : null; }

  /** Authenticates an incoming request. Throws 401/403/429. Returns { id, client, user }. */
  async function authenticate(ctx, need) {
    const h = String(ctx.req.headers.authorization || ''); const raw = (h.startsWith('Bearer ') ? h.slice(7) : '') || String(ctx.req.headers['x-api-key'] || '');
    const m = /^ak_([a-z0-9]+)_([A-Za-z0-9_-]{20,})$/.exec(raw.trim());
    const ipLim = rl.hit(`api:ip:${ctx.ip}`, 300, 60000);
    if (!ipLim.ok) throw Object.assign(new HttpError(429, 'Too many requests', 'rate_limited'), { retryAfter: ipLim.retryAfter });
    if (!m) throw unauthorized('Missing or malformed API key. Send "Authorization: Bearer <key>".');
    const c = await db.get(`api_clients/${m[1]}`);
    if (!c || !safeEqual(sha256(m[2]), c.hash)) throw unauthorized('Invalid API key');
    ctx.apiClientId = m[1];
    if (c.enabled === false) throw forbidden('API key is disabled or revoked');
    if (!ipAllowed(ctx.ip, c.ipAllowlist)) throw new HttpError(403, `IP ${ctx.ip} is not in this key's allowlist`, 'ip_not_allowed');
    if (need && !(c.permissions || []).includes(need)) throw new HttpError(403, `This key does not have the "${need}" permission`, 'missing_permission');
    const lim = rl.hit(`api:key:${m[1]}`, num(c.rateLimit, DEFAULT_RATE), 60000);
    ctx.rateHeaders = { 'X-RateLimit-Limit': String(num(c.rateLimit, DEFAULT_RATE)), 'X-RateLimit-Remaining': String(lim.remaining) };
    if (!lim.ok) throw Object.assign(new HttpError(429, 'Rate limit exceeded', 'rate_limited'), { retryAfter: lim.retryAfter });
    const user = await db.get(`users/${c.uid}`);
    if (!user || user.banned === true || user.status === 'Banned' || user.status === 'OFF') throw forbidden('The account behind this API key is not active');
    return { id: m[1], client: c, user, uid: c.uid };
  }

  async function logRequest(ctx, status, ms, extra = {}) {
    if (!ctx.apiClientId) return;
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    try {
      await db.push('api_logs', { clientId: ctx.apiClientId, method: ctx.method, path: ctx.path, status, ms, ip: ctx.ip, ts: now(), ...extra });
      await db.transaction(`api_usage/${ctx.apiClientId}/${day}/${status >= 400 ? 'errors' : 'ok'}`, (c) => (Number(c) || 0) + 1);
      await db.update(`api_clients/${ctx.apiClientId}`, { lastUsedAt: now() });
      await db.transaction(`api_clients/${ctx.apiClientId}/requests`, (c) => (Number(c) || 0) + 1);
    } catch {}
  }

  return { PERMS, create, regenerate, revoke, update, revealKey, remove, list, forUser, authenticate, logRequest, view, ipAllowed };
}

module.exports = { createApiClients, PERMS, ipAllowed };
