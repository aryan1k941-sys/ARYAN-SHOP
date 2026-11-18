'use strict';
/** Admin API (part 2): suppliers, gateways & payments, API clients/logs, Telegram, media, branding, announcements, maintenance, settings, security, tickets. */
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { HttpError, bad, notFound, forbidden, conflict, round2, num, now, str, slug, safeKey, rand } = require('../lib');
const { PRESETS: SUP_PRESETS } = require('../services/suppliers');
const { PRESETS: GW_PRESETS } = require('../services/gateways');

const MEDIA_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' };
function magicOk(ct, b) {
  if (ct === 'image/png') return b.length > 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (ct === 'image/jpeg') return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (ct === 'image/gif') return b.slice(0, 4).toString() === 'GIF8';
  if (ct === 'image/webp') return b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP';
  if (ct === 'video/mp4') return b.slice(4, 8).toString() === 'ftyp';
  if (ct === 'video/webm') return b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
  return false;
}
const okUrl = (u) => !u || /^(https?:\/\/|\/media\/)/i.test(u);

module.exports = function (app, S) {
  const { db, cfg, suppliers, gateways, apiClients, telegram, storage, auth } = S;
  const A = S.A, audit = S.audit, paginate = S.paginate;

  /* ================= suppliers ================= */
  app.get('/api/admin/suppliers', A('suppliers', async () => ({ suppliers: await suppliers.list(), presets: Object.fromEntries(Object.entries(SUP_PRESETS).map(([k, v]) => [k, v])) })));
  app.post('/api/admin/suppliers', A('suppliers', async (ctx) => { const id = await suppliers.save(null, ctx.body); await audit(ctx, 'supplier_create', id, ctx.body.name); return { id }; }));
  app.put('/api/admin/suppliers/:id', A('suppliers', async (ctx) => { const id = await suppliers.save(ctx.params.id, ctx.body); await audit(ctx, 'supplier_update', id); return { id }; }));
  app.delete('/api/admin/suppliers/:id', A('suppliers', async (ctx) => { await suppliers.remove(ctx.params.id); await audit(ctx, 'supplier_delete', ctx.params.id); return {}; }));
  app.post('/api/admin/suppliers/:id/test', A('suppliers', async (ctx) => { const r = await suppliers.test(ctx.params.id); await audit(ctx, 'supplier_test', ctx.params.id, r.status); return r; }));
  app.post('/api/admin/suppliers/:id/balance', A('suppliers', async (ctx) => suppliers.checkBalance(ctx.params.id)));
  app.post('/api/admin/suppliers/:id/reveal', A('suppliers.secrets', async (ctx) => { await S.verifyAdminPassword(ctx); await audit(ctx, 'supplier_secret_reveal', ctx.params.id); return suppliers.reveal(ctx.params.id); }));
  app.get('/api/admin/supplier-logs', A('suppliers', async (ctx) => {
    const all = (await db.get('supplier_logs')) || {}; let rows = Object.entries(all).map(([id, l]) => ({ id, ...l }));
    if (ctx.query.supplierId) rows = rows.filter((l) => l.supplierId === ctx.query.supplierId); if (ctx.query.ok) rows = rows.filter((l) => String(l.ok) === ctx.query.ok);
    rows.sort((a, b) => b.ts - a.ts); return paginate(rows, ctx.query, 50);
  }));

  /* ================= gateways & payments ================= */
  app.get('/api/admin/gateways', A('gateways', async () => ({ gateways: await gateways.listAll(), presets: GW_PRESETS, publicUrl: cfg.publicUrl })));
  app.post('/api/admin/gateways', A('gateways', async (ctx) => { const id = await gateways.save(null, ctx.body); await audit(ctx, 'gateway_create', id, ctx.body.name); return { id }; }));
  app.put('/api/admin/gateways/:id', A('gateways', async (ctx) => { const id = await gateways.save(ctx.params.id, ctx.body); await audit(ctx, 'gateway_update', id); S.cache.delete('public-config'); return { id }; }));
  app.delete('/api/admin/gateways/:id', A('gateways', async (ctx) => { await gateways.remove(ctx.params.id); await audit(ctx, 'gateway_delete', ctx.params.id); return {}; }));
  app.post('/api/admin/gateways/:id/test', A('gateways', async (ctx) => { const r = await gateways.test(ctx.params.id); await audit(ctx, 'gateway_test', ctx.params.id, r.status); return r; }));
  app.post('/api/admin/gateways/:id/reveal', A('gateways.secrets', async (ctx) => { await S.verifyAdminPassword(ctx); await audit(ctx, 'gateway_secret_reveal', ctx.params.id); return gateways.reveal(ctx.params.id); }));
  app.get('/api/admin/payments', A('gateways', async (ctx) => {
    let rows = Object.entries((await db.get('auto_payments')) || {}).map(([id, p]) => ({ id, ...p, checkoutUrl: undefined })); const q = String(ctx.query.q || '').toLowerCase();
    if (ctx.query.status) rows = rows.filter((p) => p.status === ctx.query.status);
    if (q) rows = rows.filter((p) => [p.id, p.username, p.gatewayOrderId, p.reference].some((v) => String(v || '').toLowerCase().includes(q)));
    rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const sum = (st) => round2(rows.filter((p) => p.status === st).reduce((a, p) => a + num(p.amount), 0));
    return { ...paginate(rows, ctx.query, 50), summary: { success: sum('success'), pending: sum('pending') } };
  }));
  app.post('/api/admin/payments/:id/recheck', A('gateways', async (ctx) => { const r = await gateways.verify(ctx.params.id); await audit(ctx, 'payment_recheck', ctx.params.id, r.payment.status); return r; }));
  app.post('/api/admin/payments/:id/approve', A('wallet', async (ctx) => { await gateways.adminApprove(ctx.params.id, ctx.admin.email, str(ctx.body.reason, 200)); await audit(ctx, 'payment_manual_approve', ctx.params.id, ctx.body.reason); S.cache.delete('dash'); return {}; }));

  /* ================= API clients ================= */
  app.get('/api/admin/api-clients', A('api', async () => ({ clients: await apiClients.list(), permissions: apiClients.PERMS })));
  app.post('/api/admin/api-clients', A('api', async (ctx) => {
    let uid = ctx.body.uid; if (!uid && ctx.body.username) uid = await auth.findUid(ctx.body.username); if (!uid) throw bad('Choose the user whose wallet this API key will use');
    const r = await apiClients.create({ name: ctx.body.name, uid, permissions: ctx.body.permissions, ipAllowlist: ctx.body.ipAllowlist, rateLimit: ctx.body.rateLimit, createdBy: ctx.admin.email });
    await audit(ctx, 'api_client_create', r.id, ctx.body.name); return { id: r.id, key: r.key, client: r.client };
  }));
  app.put('/api/admin/api-clients/:id', A('api', async (ctx) => { await apiClients.update(ctx.params.id, ctx.body); await audit(ctx, 'api_client_update', ctx.params.id); return {}; }));
  app.post('/api/admin/api-clients/:id/regenerate', A('api', async (ctx) => { const r = await apiClients.regenerate(ctx.params.id); await audit(ctx, 'api_key_regenerate', ctx.params.id); return r; }));
  app.post('/api/admin/api-clients/:id/revoke', A('api', async (ctx) => { await apiClients.revoke(ctx.params.id); await audit(ctx, 'api_key_revoke', ctx.params.id); return {}; }));
  app.post('/api/admin/api-clients/:id/reveal', A('api.secrets', async (ctx) => { await S.verifyAdminPassword(ctx); await audit(ctx, 'api_key_reveal', ctx.params.id); return { key: await apiClients.revealKey(ctx.params.id) }; }));
  app.delete('/api/admin/api-clients/:id', A('api', async (ctx) => { await apiClients.remove(ctx.params.id); await audit(ctx, 'api_client_delete', ctx.params.id); return {}; }));
  app.get('/api/admin/api-logs', A('api', async (ctx) => {
    let rows = Object.entries((await db.get('api_logs')) || {}).map(([id, l]) => ({ id, ...l }));
    if (ctx.query.clientId) rows = rows.filter((l) => l.clientId === ctx.query.clientId);
    if (ctx.query.status === 'ok') rows = rows.filter((l) => l.status < 400); if (ctx.query.status === 'error') rows = rows.filter((l) => l.status >= 400);
    rows.sort((a, b) => b.ts - a.ts); return paginate(rows, ctx.query, 50);
  }));
  app.get('/api/admin/api-stats', A('api', async () => {
    const [usage, clients] = await Promise.all([db.get('api_usage'), db.get('api_clients')]); const days = []; for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10).replace(/-/g, ''));
    const per = Object.entries(clients || {}).map(([id, c]) => ({ id, name: c.name, total: num(c.requests), series: days.map((d) => { const x = ((usage || {})[id] || {})[d] || {}; return num(x.ok) + num(x.errors); }), errors: days.reduce((a, d) => a + num((((usage || {})[id] || {})[d] || {}).errors), 0) }));
    return { days: days.map((d) => `${d.slice(4, 6)}-${d.slice(6)}`), clients: per };
  }));
  S.trimLogs = async () => {
    for (const [path, keep] of [['api_logs', 5000], ['supplier_logs', 3000], ['admin_audit', 3000], ['payment_events', 3000]]) {
      const all = (await db.get(path)) || {}; const keys = Object.keys(all).sort(); if (keys.length > keep) { const ups = {}; keys.slice(0, keys.length - keep).forEach((k) => { ups[k] = null; }); await db.update(path, ups); }
    }
  };

  /* ================= Telegram ================= */
  app.get('/api/admin/telegram', A('telegram', async () => ({ settings: await telegram.publicSettings() })));
  app.put('/api/admin/telegram', A('telegram', async (ctx) => { const s = await telegram.saveSettings(ctx.body, ctx.admin.email); await audit(ctx, 'telegram_update'); S.cache.delete('public-config'); return { settings: s }; }));
  app.post('/api/admin/telegram/test', A('telegram', async (ctx) => { const r = await telegram.test(); await audit(ctx, 'telegram_test'); return r; }));
  app.post('/api/admin/telegram/webhook', A('telegram', async (ctx) => { const r = await telegram.setWebhook(cfg.publicUrl); await audit(ctx, 'telegram_webhook'); return r; }));

  /* ================= media manager ================= */
  app.get('/api/admin/media', A('media', async () => ({ items: Object.values((await db.get('media')) || {}).sort((a, b) => b.createdAt - a.createdAt) })));
  app.put('/api/admin/media/upload', { raw: true }, A('media', async (ctx) => {
    const ct = String(ctx.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(); const ext = MEDIA_TYPES[ct];
    if (!ext) throw bad('Only PNG, JPG, WEBP, GIF images and MP4/WEBM videos are allowed', 'bad_type');
    const isVideo = ct.startsWith('video/'); const max = (isVideo ? cfg.uploadMaxMb : 8) * 1024 * 1024;
    const declared = parseInt(ctx.req.headers['content-length'], 10); if (declared && declared > max) throw new HttpError(413, `File too large (max ${isVideo ? cfg.uploadMaxMb : 8} MB)`, 'too_large');
    const id = rand(8).toString('hex'); const file = `${id}.${ext}`; let size = 0, first = true;
    const guard = new Transform({ transform(chunk, enc, cb) { size += chunk.length; if (size > max) return cb(new HttpError(413, 'File too large', 'too_large')); if (first) { first = false; if (!magicOk(ct, chunk)) return cb(new HttpError(400, 'File content does not match its type', 'bad_type')); } cb(null, chunk); } });
    ctx.req.pipe(guard);
    try { await storage.put(file, ct, guard); } catch (e) { try { await storage.del(file); } catch {} throw e instanceof HttpError ? e : new HttpError(500, 'Upload failed', 'upload_failed'); }
    if (!size) { await storage.del(file); throw bad('Empty file'); }
    const rec = { id, file, url: `/media/${file}`, name: str(ctx.query.name, 120) || file, kind: isVideo ? 'video' : 'image', contentType: ct, size, createdAt: now(), by: ctx.admin.email };
    await db.set(`media/${id}`, rec); await audit(ctx, 'media_upload', id, rec.name); return { item: rec };
  }));
  app.post('/api/admin/media/url', A('media', async (ctx) => {
    const url = str(ctx.body.url, 600); if (!/^https?:\/\//i.test(url)) throw bad('Enter a full http(s) URL'); const kind = ctx.body.kind === 'video' ? 'video' : 'image';
    const id = rand(8).toString('hex'); const rec = { id, file: '', url, external: true, name: str(ctx.body.name, 120) || url.slice(0, 60), kind, contentType: '', size: 0, createdAt: now(), by: ctx.admin.email };
    await db.set(`media/${id}`, rec); await audit(ctx, 'media_add_url', id); return { item: rec };
  }));
  app.delete('/api/admin/media/:id', A('media', async (ctx) => {
    const m = await db.get(`media/${ctx.params.id}`); if (!m) throw notFound('Media not found');
    if (m.file) { try { await storage.del(m.file); } catch {} } await db.remove(`media/${ctx.params.id}`); await audit(ctx, 'media_delete', ctx.params.id); return {};
  }));
  app.post('/api/admin/media/assign', A('media', async (ctx) => {
    const url = str(ctx.body.url, 600); const t = ctx.body.target; if (!okUrl(url)) throw bad('Invalid URL');
    if (['logo', 'favicon'].includes(t)) await db.set(`branding/${t}Url`, url);
    else if (t === 'banner') { const b = (await db.get('branding/banners')) || []; const arr = Array.isArray(b) ? b : Object.values(b); arr.push({ url, link: '', title: '', active: true }); await db.set('branding/banners', arr); }
    else if (['productImage', 'productThumb', 'productBanner', 'productVideo'].includes(t)) {
      const k = ctx.body.productKey; if (!safeKey(k) || !(await db.get(`store_management/${k}`))) throw notFound('Product not found');
      const f = { productImage: 'imageUrl', productThumb: 'thumbnailUrl', productBanner: 'bannerUrl', productVideo: 'videoUrl' }[t]; await db.set(`store_products/${k}/${f}`, url);
    } else throw bad('Unknown target');
    S.cache.delete('public-config'); await audit(ctx, 'media_assign', t, url); return {};
  }));

  /* ================= branding / announcements / maintenance ================= */
  app.get('/api/admin/branding', A('branding', async () => ({ branding: (await db.get('branding')) || {} })));
  app.put('/api/admin/branding', A('branding', async (ctx) => {
    const b = ctx.body; const banners = (Array.isArray(b.banners) ? b.banners : []).slice(0, 10).map((x) => ({ url: str(x.url, 600), link: str(x.link, 400), title: str(x.title, 100), active: x.active !== false })).filter((x) => x.url);
    for (const u of [b.logoUrl, b.faviconUrl, ...banners.map((x) => x.url)]) if (!okUrl(u)) throw bad('Image URLs must be http(s) links or uploaded media');
    const accent = /^#[0-9a-fA-F]{6}$/.test(b.accent || '') ? b.accent : '#00e5ff';
    await db.set('branding', { siteName: str(b.siteName, 40) || 'ARYAN', tagline: str(b.tagline, 120), logoUrl: str(b.logoUrl, 600), faviconUrl: str(b.faviconUrl, 600), banners, accent, updatedAt: now() });
    S.cache.delete('public-config'); await audit(ctx, 'branding_update'); return {};
  }));
  app.get('/api/admin/announcements', A('announcements', async () => ({ items: Object.entries((await db.get('announcements')) || {}).map(([id, a]) => ({ id, ...a })).sort((a, b) => b.createdAt - a.createdAt) })));
  app.post('/api/admin/announcements', A('announcements', async (ctx) => {
    const title = str(ctx.body.title, 100), body = str(ctx.body.body, 1000); if (!title) throw bad('Title is required');
    const rec = { title, body, type: ['info', 'warning', 'success'].includes(ctx.body.type) ? ctx.body.type : 'info', active: ctx.body.active !== false, pinned: !!ctx.body.pinned, createdAt: now(), by: ctx.admin.email };
    const id = ctx.body.id && safeKey(ctx.body.id) ? ctx.body.id : await db.push('announcements', rec); if (ctx.body.id) { const cur = await db.get(`announcements/${id}`); if (!cur) throw notFound(); await db.set(`announcements/${id}`, { ...cur, ...rec, createdAt: cur.createdAt }); }
    S.cache.delete('public-config'); await audit(ctx, 'announcement_save', id); return { id };
  }));
  app.delete('/api/admin/announcements/:id', A('announcements', async (ctx) => { await db.remove(`announcements/${ctx.params.id}`); S.cache.delete('public-config'); await audit(ctx, 'announcement_delete', ctx.params.id); return {}; }));
  app.get('/api/admin/maintenance', A('maintenance', async () => {
    const [site, pm, prods] = await Promise.all([db.get('site_settings/maintenance'), db.get('product_maintenance'), S.catalog.loadAll()]);
    return { site: site || { enabled: false, message: '' }, products: prods.map((p) => ({ key: p.key, name: p.name, pid: p.pid, on: !!(pm || {})[p.key] })) };
  }));
  app.put('/api/admin/maintenance/site', A('maintenance', async (ctx) => { await db.set('site_settings/maintenance', { enabled: !!ctx.body.enabled, message: str(ctx.body.message, 300), updatedAt: now() }); S.cache.delete('public-config'); await audit(ctx, 'maintenance_site', '', String(!!ctx.body.enabled)); return {}; }));
  app.put('/api/admin/maintenance/product/:key', A('maintenance', async (ctx) => { if (!safeKey(ctx.params.key)) throw bad('Bad key'); if (ctx.body.on) await db.set(`product_maintenance/${ctx.params.key}`, true); else await db.remove(`product_maintenance/${ctx.params.key}`); await audit(ctx, 'maintenance_product', ctx.params.key, String(!!ctx.body.on)); return {}; }));

  /* ================= settings ================= */
  const LINK_KEYS = ['announcement', 'howToBuyUrl', 'howToDepositUrl', 'donateUrl', 'joinUrl', 'telegramUrl', 'safetyBalance', 'refTarget', 'binanceText', 'bkashText'];
  app.get('/api/admin/settings', A('settings', async () => {
    const [links, rs, api] = await Promise.all([db.get('site_settings/links'), db.get('site_settings/reseller_upgrade'), db.get('site_settings/api')]);
    return { links: links || {}, reseller: { enabled: false, minBalance: 10, commissionPct: 1, ...(rs || {}) }, api: { userSelfServe: true, ...(api || {}) } };
  }));
  app.put('/api/admin/settings', A('settings', async (ctx) => {
    const b = ctx.body;
    if (b.links) {
      const o = { updatedAt: now() }; LINK_KEYS.forEach((k) => { o[k] = str(b.links[k], 500); });
      for (const k of ['howToBuyUrl', 'howToDepositUrl', 'donateUrl', 'joinUrl', 'telegramUrl']) if (o[k] && !/^https?:\/\//i.test(o[k])) throw bad(`${k} must start with https://`);
      await db.set('site_settings/links', o);
    }
    if (b.reseller) await db.set('site_settings/reseller_upgrade', { enabled: !!b.reseller.enabled, minBalance: Math.max(0, round2(b.reseller.minBalance)), commissionPct: Math.min(100, Math.max(0, num(b.reseller.commissionPct))), updatedAt: now() });
    if (b.api) await db.set('site_settings/api', { userSelfServe: b.api.userSelfServe !== false, updatedAt: now() });
    S.cache.delete('public-config'); await audit(ctx, 'settings_update'); return {};
  }));
  app.get('/api/admin/admins', A('*', async () => ({ envAdmins: cfg.admin.emails, mode: cfg.admin.mode, roles: Object.entries((await db.get('admin_roles')) || {}).map(([k, r]) => ({ key: k, ...r })), available: Object.keys(S.ROLE_PERMS) })));
  app.post('/api/admin/admins', A('*', async (ctx) => {
    const email = String(ctx.body.email || '').trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Valid email required'); if (!['manager', 'finance', 'support'].includes(ctx.body.role)) throw bad('Role must be manager, finance or support');
    await db.set(`admin_roles/${slug(email)}`, { email, role: ctx.body.role, addedBy: ctx.admin.email, addedAt: now() }); await audit(ctx, 'admin_role_set', email, ctx.body.role); return {};
  }));
  app.delete('/api/admin/admins/:key', A('*', async (ctx) => { await db.remove(`admin_roles/${slug(ctx.params.key)}`); await audit(ctx, 'admin_role_remove', ctx.params.key); return {}; }));

  /* ================= security ================= */
  app.get('/api/admin/security', A('security', async () => {
    const users = (await db.get('users')) || {}; const legacy = Object.values(users).filter((u) => typeof u.password === 'string').length;
    return {
      checks: [
        { id: 'https', label: 'Public URL uses HTTPS', ok: /^https:\/\//.test(cfg.publicUrl), hint: 'Set PUBLIC_URL=https://your-domain' },
        { id: 'secrets', label: 'JWT_SECRET and SECRETS_KEY set via environment', ok: !!process.env.JWT_SECRET && !!process.env.SECRETS_KEY, hint: 'Run npm run gen-secrets' },
        { id: 'prod', label: 'NODE_ENV=production', ok: cfg.prod, hint: '' },
        { id: 'fb', label: 'Firebase database driver', ok: S.driver === 'firebase', hint: 'DB_DRIVER=firebase for production' },
        { id: 'adminlist', label: 'Admin allow-list configured', ok: cfg.admin.emails.length > 0 || cfg.admin.mode === 'local', hint: 'Set ADMIN_EMAILS' },
        { id: 'adminip', label: 'Admin IP allow-list', ok: cfg.admin.ipAllowlist.length > 0, hint: 'Optional: ADMIN_IP_ALLOWLIST=1.2.3.4' },
        { id: 'legacy', label: 'No plain-text user passwords stored', ok: legacy === 0, hint: `${legacy} account(s) still have a plain-text password. Use "Hash legacy passwords".` },
        { id: 'mail', label: 'Password-reset email configured', ok: cfg.mail.provider === 'resend' && !!cfg.mail.resendKey, hint: 'MAIL_PROVIDER=resend + RESEND_API_KEY (otherwise admin issues reset links)' },
      ],
      legacyPlaintext: legacy, mode: cfg.admin.mode, ipAllowlist: cfg.admin.ipAllowlist,
    };
  }));
  app.post('/api/admin/security/hash-legacy', A('*', async (ctx) => {
    const users = (await db.get('users')) || {}; let n = 0;
    for (const [uid, u] of Object.entries(users)) if (typeof u.password === 'string' && !u.passwordHash) { await db.update(`users/${uid}`, { passwordHash: await auth.hashPassword(u.password), password: null, tokenVersion: u.tokenVersion || 1 }); n++; }
    await audit(ctx, 'hash_legacy_passwords', '', String(n)); return { hashed: n };
  }));
  app.post('/api/admin/security/logout-all', A('*', async (ctx) => { await db.transaction('admin_security/epoch', (c) => (Number(c) || 0) + 1); await audit(ctx, 'admin_logout_all'); return {}; }));
  app.get('/api/admin/audit', A('security', async (ctx) => { const rows = Object.entries((await db.get('admin_audit')) || {}).map(([id, a]) => ({ id, ...a })).sort((a, b) => b.ts - a.ts); return paginate(rows, ctx.query, 50); }));

  /* ================= tickets ================= */
  app.get('/api/admin/tickets', A('tickets', async () => ({ items: Object.entries((await db.get('tickets')) || {}).map(([id, t]) => ({ id, ...t })).sort((a, b) => b.createdAt - a.createdAt) })));
  app.post('/api/admin/tickets/:id/reply', A('tickets', async (ctx) => {
    const reply = str(ctx.body.reply, 2000); if (!reply) throw bad('Write a reply'); const t = await db.get(`tickets/${ctx.params.id}`); if (!t) throw notFound('Ticket not found');
    await db.update(`tickets/${ctx.params.id}`, { reply, status: 'answered', repliedAt: now(), repliedBy: ctx.admin.email }); telegram.notify('user', `💬 <b>Support replied</b> to “${String(t.subject).replace(/[<>&]/g, '')}”.`, { uid: t.uid, adminToo: false }); return {};
  }));
};
