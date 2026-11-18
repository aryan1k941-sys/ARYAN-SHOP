'use strict';
/** Public endpoints: site config, auth, media files, webhooks. */
const { HttpError, bad, notFound, unauthorized, now, str } = require('../lib');

module.exports = function (app, S) {
  const { db, auth, gateways, telegram, storage, cfg } = S;

  app.get('/api/health', async () => ({ status: 'up', time: now(), driver: S.driver }));

  app.get('/api/public/config', async () => S.cached('public-config', 5000, async () => {
    const [brand, links, maint, rs, anns, tg, apiSet] = await Promise.all([db.get('branding'), db.get('site_settings/links'), db.get('site_settings/maintenance'), db.get('site_settings/reseller_upgrade'), db.get('announcements'), telegram.publicSettings(), db.get('site_settings/api')]);
    const pub = ['howToBuyUrl', 'howToDepositUrl', 'donateUrl', 'joinUrl', 'telegramUrl', 'safetyBalance', 'refTarget', 'binanceText', 'bkashText', 'announcement'];
    const l = links || {}; const lo = {}; pub.forEach((k) => { if (l[k] !== undefined) lo[k] = l[k]; });
    const annList = Object.entries(anns || {}).map(([id, a]) => ({ id, ...a })).filter((a) => a.active !== false).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.createdAt - a.createdAt).slice(0, 20);
    return {
      brand: { siteName: 'ARYAN', tagline: 'Premium digital products & reseller platform', logoUrl: '', faviconUrl: '', banners: [], accent: '#00e5ff', ...(brand || {}) },
      maintenance: { enabled: !!(maint && maint.enabled), message: (maint && maint.message) || '' }, links: lo, announcements: annList,
      payments: await gateways.publicInfo(), adminAuth: cfg.admin.mode, telegram: { enabled: tg.enabled, botUsername: tg.botUsername },
      reseller: { enabled: !!(rs && rs.enabled), minBalance: Number(rs && rs.minBalance != null ? rs.minBalance : 10), commissionPct: rs && rs.commissionPct != null ? Number(rs.commissionPct) : 1 },
      api: { userSelfServe: apiSet ? apiSet.userSelfServe !== false : true }, backend: { driver: S.driver, mailConfigured: cfg.mail.provider === 'resend' && !!cfg.mail.resendKey },
    };
  }));

  /* ---------- auth ---------- */
  app.post('/api/auth/register', async (ctx) => auth.register({ ...ctx.body, ip: ctx.ip }));
  app.post('/api/auth/login', async (ctx) => auth.login({ identifier: ctx.body.username || ctx.body.identifier, password: ctx.body.password, ip: ctx.ip }));
  app.post('/api/auth/forgot', async (ctx) => auth.requestReset({ email: ctx.body.email || ctx.body.username, origin: ctx.req.headers.origin || '', ip: ctx.ip }));
  app.post('/api/auth/reset', async (ctx) => auth.resetPassword({ token: ctx.body.token, password: ctx.body.password, ip: ctx.ip }));

  /* ---------- uploaded media (public read) ---------- */
  app.get('/media/:name', async (ctx) => {
    const name = ctx.params.name;
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(name)) throw notFound();
    const meta = await db.get(`media/${name.split('.')[0]}`);
    if (!meta || meta.file !== name) throw notFound('File not found');
    let f; try { f = await storage.get(name); } catch { throw notFound('File not found'); }
    ctx.res.writeHead(200, { 'Content-Type': meta.contentType, 'Content-Length': f.size, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    f.stream.pipe(ctx.res);
  });

  /* ---------- webhooks ---------- */
  const hook = async (ctx) => {
    const lim = S.rl.hit(`wh:${ctx.ip}`, 120, 60000); if (!lim.ok) throw Object.assign(new HttpError(429, 'Too many requests', 'rate_limited'), { retryAfter: lim.retryAfter });
    const r = await gateways.webhook(ctx.params.gid, { rawBody: ctx.rawBody, headers: ctx.req.headers, body: ctx.body, query: ctx.query });
    return r;
  };
  app.post('/webhooks/payment/:gid', hook);
  app.get('/webhooks/payment/:gid', hook);
  app.post('/webhooks/telegram/:secret', async (ctx) => {
    const raw = (await db.get('telegram_settings')) || {};
    if (!raw.webhookSecret || ctx.params.secret !== raw.webhookSecret) throw new HttpError(401, 'Bad secret', 'unauthorized');
    const hdr = ctx.req.headers['x-telegram-bot-api-secret-token']; if (hdr && hdr !== raw.webhookSecret) throw new HttpError(401, 'Bad secret', 'unauthorized');
    await telegram.handleUpdate(ctx.body); return {};
  });
};
