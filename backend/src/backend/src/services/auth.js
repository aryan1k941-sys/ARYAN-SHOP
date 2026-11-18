'use strict';
/**
 * User accounts: registration, login, sessions, password change/reset.
 * Passwords are hashed with scrypt. Accounts created by the previous version (plain-text `password` field) are upgraded on first
 * successful login (or by `npm run migrate`) and the plain-text field is deleted.
 */
const crypto = require('node:crypto');
const { HttpError, bad, unauthorized, forbidden, notFound, hashPassword, verifyPassword, signToken, verifyToken, safeEqual, sha256, now, str, isEmail, isUsername, slug, rand, esc } = require('../lib');

function createAuth({ db, cfg, rl, log }) {
  const emailKey = (e) => slug(String(e).toLowerCase());

  async function findUid(identifier) {
    const id = String(identifier || '').trim().toLowerCase();
    if (!id) return null;
    let uid = await db.get(`usernames/${slug(id)}`);
    if (!uid && id.includes('@')) uid = await db.get(`emails/${emailKey(id)}`);
    if (uid) return uid;
    // legacy accounts are not indexed yet
    for (const [field, val] of [['username', id], ['email', identifier.trim()], ['email', id]]) {
      const m = await db.queryEq('users', field, val); const k = Object.keys(m)[0]; if (k) return k;
    }
    return null;
  }

  const sessionFor = (uid, u) => signToken({ t: 'user', uid, v: u.tokenVersion || 1 }, cfg.jwtSecret, cfg.userTokenTtl);

  async function register({ name, email, username, password, ref, ip }) {
    name = str(name, 80); email = str(email, 120).toLowerCase(); username = str(username, 30).toLowerCase();
    if (!name) throw bad('Enter your name');
    if (!isEmail(email)) throw bad('Enter a valid email address');
    if (!isUsername(username)) throw bad('Username: 3-30 characters, letters/numbers/._- only');
    if (String(password || '').length < 6 || String(password).length > 200) throw bad('Password must be at least 6 characters');
    const lim = rl.hit(`reg:${ip}`, 8, 3600 * 1000); if (!lim.ok) throw Object.assign(new HttpError(429, 'Too many sign-ups from this network, try later', 'rate_limited'), { retryAfter: lim.retryAfter });
    if (await findUid(username)) throw new HttpError(409, 'Username already taken', 'username_taken');
    if (await findUid(email)) throw new HttpError(409, 'An account with this email already exists', 'email_taken');
    const uid = `UID-${Math.floor(100000 + Math.random() * 900000)}-${username}`;
    const c1 = await db.transaction(`usernames/${slug(username)}`, (c) => (c ? undefined : uid));
    if (!c1.committed) throw new HttpError(409, 'Username already taken', 'username_taken');
    const c2 = await db.transaction(`emails/${emailKey(email)}`, (c) => (c ? undefined : uid));
    if (!c2.committed) { await db.remove(`usernames/${slug(username)}`); throw new HttpError(409, 'An account with this email already exists', 'email_taken'); }
    let referredBy = ''; const r = String(ref || '').replace(/[^A-Za-z0-9_\-]/g, '');
    if (r && (await db.get(`users/${r}/username`))) referredBy = r;
    const user = { name, email, username, passwordHash: await hashPassword(password), referredBy, joinedAt: now(), balance: 0, keyCount: 0, role: 'User', status: 'Active', tokenVersion: 1 };
    await db.set(`users/${uid}`, user);
    return { token: sessionFor(uid, user), uid };
  }

  async function login({ identifier, password, ip }) {
    const idn = String(identifier || '').trim().toLowerCase();
    if (!idn || !password) throw bad('Enter all required credentials');
    const a = rl.hit(`login:ip:${ip}`, 20, 10 * 60 * 1000), b = rl.hit(`login:id:${idn}`, 8, 15 * 60 * 1000);
    if (!a.ok || !b.ok) throw Object.assign(new HttpError(429, 'Too many attempts. Try again later.', 'rate_limited'), { retryAfter: Math.max(a.retryAfter, b.retryAfter) });
    const uid = await findUid(idn); const u = uid ? await db.get(`users/${uid}`) : null;
    const fail = () => new HttpError(401, 'Invalid username or password', 'invalid_credentials');
    if (!u) { await verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='); throw fail(); }
    let ok = false;
    if (u.passwordHash) ok = await verifyPassword(password, u.passwordHash);
    else if (typeof u.password === 'string') {
      ok = safeEqual(u.password, String(password));
      if (ok) await db.update(`users/${uid}`, { passwordHash: await hashPassword(password), password: null, tokenVersion: u.tokenVersion || 1 }); // upgrade legacy plain text
    }
    if (!ok) throw fail();
    if (u.banned === true || u.status === 'Banned') throw forbidden('Your account is suspended/banned');
    // index legacy accounts lazily
    if (u.username) await db.transaction(`usernames/${slug(String(u.username).toLowerCase())}`, (c) => c || uid);
    if (u.email) await db.transaction(`emails/${emailKey(u.email)}`, (c) => c || uid);
    await db.update(`users/${uid}`, { lastLoginAt: now(), lastLoginIp: ip });
    return { token: sessionFor(uid, u), uid };
  }

  async function authenticate(token) {
    const p = verifyToken(token, cfg.jwtSecret);
    if (!p || p.t !== 'user') throw unauthorized('Session expired, please login again');
    const u = await db.get(`users/${p.uid}`);
    if (!u) throw unauthorized('Account not found');
    if ((u.tokenVersion || 1) !== p.v) throw unauthorized('Session expired, please login again');
    if (u.banned === true || u.status === 'Banned') throw forbidden('Your account is suspended/banned');
    return { uid: p.uid, user: u };
  }

  async function changePassword(uid, current, next) {
    const u = await db.get(`users/${uid}`);
    const ok = u.passwordHash ? await verifyPassword(current, u.passwordHash) : (typeof u.password === 'string' && safeEqual(u.password, String(current)));
    if (!ok) throw bad('Current password is incorrect', 'wrong_password');
    if (String(next || '').length < 6) throw bad('New password must be at least 6 characters');
    const v = (u.tokenVersion || 1) + 1;
    await db.update(`users/${uid}`, { passwordHash: await hashPassword(next), password: null, tokenVersion: v });
    return { token: sessionFor(uid, { tokenVersion: v }) };
  }
  async function confirmPassword(uid, password) {
    const u = await db.get(`users/${uid}`);
    const ok = u.passwordHash ? await verifyPassword(password, u.passwordHash) : (typeof u.password === 'string' && safeEqual(u.password, String(password)));
    if (!ok) throw forbidden('Password is incorrect');
  }
  async function logoutAll(uid) { await db.transaction(`users/${uid}/tokenVersion`, (c) => (Number(c) || 1) + 1); }

  /* ---------- password reset ---------- */
  async function sendMail(to, subject, html) {
    if (cfg.mail.provider !== 'resend' || !cfg.mail.resendKey) return false;
    try {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${cfg.mail.resendKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: cfg.mail.from, to: [to], subject, html }), signal: AbortSignal.timeout(15000) });
      return r.ok;
    } catch { return false; }
  }
  async function issueReset(uid, minutes = 30) {
    const token = rand(32).toString('hex');
    await db.set(`password_resets/${sha256(token)}`, { uid, exp: now() + minutes * 60 * 1000 });
    return token;
  }
  async function requestReset({ email, origin, ip }) {
    const lim = rl.hit(`reset:${ip}`, 5, 3600 * 1000); if (!lim.ok) throw Object.assign(new HttpError(429, 'Too many requests', 'rate_limited'), { retryAfter: lim.retryAfter });
    const mailReady = cfg.mail.provider === 'resend' && !!cfg.mail.resendKey;
    if (!mailReady) return { mailConfigured: false };
    const uid = await findUid(String(email || ''));
    if (uid) {
      const u = await db.get(`users/${uid}`);
      if (u && u.email && isEmail(u.email)) {
        const token = await issueReset(uid); const link = `${(cfg.publicUrl || origin || '').replace(/\/$/, '')}/?reset=${token}`;
        await sendMail(u.email, 'Reset your ARYAN password', `<p>Hi ${esc(u.name || u.username)},</p><p>Use this link within 30 minutes to set a new password:</p><p><a href="${esc(link)}">${esc(link)}</a></p><p>If you did not ask for this, ignore this email.</p>`);
      }
    }
    return { mailConfigured: true }; // same answer whether or not the account exists
  }
  async function resetPassword({ token, password, ip }) {
    const lim = rl.hit(`resetuse:${ip}`, 10, 3600 * 1000); if (!lim.ok) throw Object.assign(new HttpError(429, 'Too many requests', 'rate_limited'), { retryAfter: lim.retryAfter });
    if (String(password || '').length < 6) throw bad('Password must be at least 6 characters');
    const k = `password_resets/${sha256(String(token || ''))}`; const r = await db.get(k);
    if (!r || r.exp < now()) throw bad('This reset link is invalid or expired', 'bad_token');
    await db.remove(k);
    await db.update(`users/${r.uid}`, { passwordHash: await hashPassword(password), password: null });
    await logoutAll(r.uid);
    return { ok: true };
  }

  return { register, login, authenticate, changePassword, confirmPassword, logoutAll, requestReset, resetPassword, issueReset, findUid, sessionFor, hashPassword };
}

module.exports = { createAuth };
