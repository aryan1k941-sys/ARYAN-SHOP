'use strict';
/**
 * Small shared helpers: errors, ids, money, crypto (scrypt, HMAC tokens, AES-256-GCM), rate limiter.
 * Zero dependencies - only Node built-ins.
 */
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}
const bad = (m, code) => new HttpError(400, m, code || 'bad_request');
const unauthorized = (m) => new HttpError(401, m || 'Login required', 'unauthorized');
const forbidden = (m) => new HttpError(403, m || 'Not allowed', 'forbidden');
const notFound = (m) => new HttpError(404, m || 'Not found', 'not_found');
const conflict = (m, code) => new HttpError(409, m, code || 'conflict');

const now = () => Date.now();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const rand = (n = 16) => crypto.randomBytes(n);
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randId = (prefix, bytes = 6) => `${prefix}${Date.now().toString(36).toUpperCase()}${rand(bytes).toString('hex').toUpperCase().slice(0, bytes * 2 - 4)}`;

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}

/* ---------- escaping / validation ---------- */
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
/** Firebase-safe key: letters, digits, underscore, dash. */
const slug = (t) => String(t || '').trim().replace(/[^a-zA-Z0-9]/g, '_');
const isEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(e);
const isUsername = (u) => /^[a-z0-9_.-]{3,30}$/.test(u);
const safeKey = (k) => /^[A-Za-z0-9_\-]{1,128}$/.test(String(k));

/** Normalise a duration label so "1 DaYs", "1 day", "1 DAY" can be compared. */
function durKey(label) {
  return String(label || '').toLowerCase().replace(/\s+/g, ' ').replace(/\bdays\b/g, 'day').replace(/\bhours\b/g, 'hour').replace(/\bmonths\b/g, 'month').trim();
}

/* ---------- passwords (scrypt) ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };
function scryptAsync(pw, salt, o) {
  return new Promise((res, rej) => crypto.scrypt(pw, salt, o.len, { N: o.N, r: o.r, p: o.p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
}
async function hashPassword(pw) {
  const salt = rand(16);
  const k = await scryptAsync(String(pw), salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${k.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, saltB, hashB] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const hash = Buffer.from(hashB, 'base64');
    const k = await scryptAsync(String(pw), Buffer.from(saltB, 'base64'), { N: +N, r: +r, p: +p, len: hash.length });
    return crypto.timingSafeEqual(k, hash);
  } catch { return false; }
}

/* ---------- signed tokens (HMAC-SHA256) ---------- */
function signToken(payload, secret, ttlSec) {
  const body = { ...payload, iat: Math.floor(now() / 1000), exp: Math.floor(now() / 1000) + ttlSec };
  const p = b64u(JSON.stringify(body));
  const s = crypto.createHmac('sha256', secret).update(p).digest('base64url');
  return `${p}.${s}`;
}
function verifyToken(token, secret) {
  try {
    const [p, s] = String(token).split('.');
    if (!p || !s) return null;
    const exp = crypto.createHmac('sha256', secret).update(p).digest('base64url');
    if (!safeEqual(s, exp)) return null;
    const body = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!body.exp || body.exp < Math.floor(now() / 1000)) return null;
    return body;
  } catch { return null; }
}

/* ---------- secrets at rest (AES-256-GCM) ---------- */
let SECRET_KEY = null;
function setSecretsKey(b64) {
  const k = Buffer.from(String(b64), 'base64');
  if (k.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes, base64 encoded (run: npm run gen-secrets)');
  SECRET_KEY = k;
}
function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  if (!SECRET_KEY) throw new Error('SECRETS_KEY not set');
  const iv = rand(12);
  const c = crypto.createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${b64u(iv)}.${b64u(c.getAuthTag())}.${b64u(ct)}`;
}
function decrypt(blob) {
  if (!blob) return '';
  const [v, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1') throw new Error('Bad secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', SECRET_KEY, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
const mask = (s) => { s = String(s || ''); return s ? '•'.repeat(Math.min(14, Math.max(8, s.length))) : ''; };

/* ---------- in-memory rate limiter (sliding window per key) ---------- */
class RateLimiter {
  constructor() { this.m = new Map(); setInterval(() => this.gc(), 60000).unref(); }
  hit(key, limit, windowMs) {
    const t = now();
    const arr = (this.m.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= limit) { this.m.set(key, arr); return { ok: false, retryAfter: Math.ceil((windowMs - (t - arr[0])) / 1000), remaining: 0 }; }
    arr.push(t); this.m.set(key, arr);
    return { ok: true, remaining: limit - arr.length, retryAfter: 0 };
  }
  gc() { const t = now(); for (const [k, a] of this.m) { if (!a.length || t - a[a.length - 1] > 3600000) this.m.delete(k); } }
}

/** Firebase-style push key: sortable by time, collision resistant. */
let lastPush = 0, lastRand = [];
function pushKey() {
  let t = Date.now();
  const dup = t === lastPush; lastPush = t;
  let ts = ''; for (let i = 0; i < 8; i++) { ts = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz'.charAt(t % 64) + ts; t = Math.floor(t / 64); }
  const chars = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  if (!dup) { lastRand = []; for (let i = 0; i < 12; i++) lastRand[i] = crypto.randomInt(64); }
  else { let i; for (i = 11; i >= 0 && lastRand[i] === 63; i--) lastRand[i] = 0; if (i >= 0) lastRand[i]++; }
  let id = ts; for (let i = 0; i < 12; i++) id += chars.charAt(lastRand[i]);
  return id;
}

/** Walk a JSON path like "data.keys[0]" / "data.order_id". */
function getPath(obj, p) {
  if (!p) return undefined;
  return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

module.exports = {
  HttpError, bad, unauthorized, forbidden, notFound, conflict,
  now, round2, num, rand, b64u, sha256, randId, safeEqual, esc, str, slug, isEmail, isUsername, safeKey, durKey,
  hashPassword, verifyPassword, signToken, verifyToken, setSecretsKey, encrypt, decrypt, mask, RateLimiter, pushKey, getPath,
};
