'use strict';
/** Wires config -> db -> services -> routes. */
const { createDb } = require('./db');
const { createApp } = require('./http');
const L = require('./lib');
const { createNet } = require('./services/netsafe');
const { createWallet } = require('./services/wallet');
const { createTelegram } = require('./services/telegram');
const { createCatalog } = require('./services/catalog');
const { createSuppliers } = require('./services/suppliers');
const { createOrders } = require('./services/orders');
const { createGateways } = require('./services/gateways');
const { createAuth } = require('./services/auth');
const { createApiClients } = require('./services/apiclients');

function build(cfg, { logger = console } = {}) {
  L.setSecretsKey(cfg.secretsKey);
  const { db, storage, driver } = createDb(cfg);
  const rl = new L.RateLimiter();
  const log = { info: (...a) => logger.log(...a), warn: (...a) => logger.warn(...a), error: (...a) => logger.error(...a) };
  const net = createNet(cfg);
  const wallet = createWallet({ db });
  const telegram = createTelegram({ db, cfg, log });
  const catalog = createCatalog({ db });
  const suppliers = createSuppliers({ db, net });
  const orders = createOrders({ db, wallet, catalog, suppliers, telegram, log });
  const gateways = createGateways({ db, net, wallet, telegram, cfg, log });
  const auth = createAuth({ db, cfg, rl, log });
  const apiClients = createApiClients({ db, rl });
  const S = { cfg, db, storage, driver, rl, log, net, wallet, telegram, catalog, suppliers, orders, gateways, auth, apiClients, cache: new Map() };
  S.cached = async (key, ttlMs, fn) => { const c = S.cache.get(key); if (c && Date.now() - c.t < ttlMs) return c.v; const v = await fn(); S.cache.set(key, { t: Date.now(), v }); return v; };

  const app = createApp(cfg, log);
  require('./routes/public')(app, S);
  require('./routes/user')(app, S);
  require('./routes/apiv1')(app, S);
  require('./routes/admin')(app, S);
  require('./routes/admin2')(app, S);

  /** Pre-create the two gateways the site uses (disabled, no key). The admin only has to paste the API key and switch them on. */
  async function ensureDefaultGateways() {
    const all = (await db.get('payment_gateways')) || {}; const vals = Object.values(all);
    const P = gateways.PRESETS; const t = Date.now();
    const mk = (name, preset, extra) => ({ name, preset, enabled: false, priority: 100, min: 1, max: 50000, createMethod: 'GET', verifyMethod: 'GET', params: P[preset].params, resp: P[preset].resp, expiresInSec: P[preset].expiresInSec || 300, secrets: {}, stats: { created: 0, failed: 0, paid: 0 }, status: 'unknown', statusNote: 'Not configured: add the API key and enable', createdAt: t, updatedAt: t, ...extra });
    if (!vals.some((g) => g.preset === 'zapupi' || /zapupi/i.test(g.baseUrl || ''))) await db.set('payment_gateways/GW_ZAPUPI', mk('ZapUPI', 'zapupi', { baseUrl: P.zapupi.baseUrl, createEndpoint: P.zapupi.createEndpoint, verifyEndpoint: P.zapupi.verifyEndpoint, priority: 1 }));
    if (!vals.some((g) => /famgateway/i.test(g.baseUrl || '') || /fam/i.test(g.name || ''))) await db.set('payment_gateways/GW_FAM', mk('FAM Gateway', 'generic', { baseUrl: 'https://famgateway.in', priority: 2, statusNote: 'Needs FAM Gateway official docs (endpoints and response fields) before it can be enabled' }));
  }

  const timers = [];
  S.start = async () => {
    await catalog.ensurePids().catch((e) => log.warn('[pid] ensure failed', e.message));
    await ensureDefaultGateways().catch((e) => log.warn('[gateways] defaults failed', e.message));
    if (cfg.poll.payments) timers.push(setInterval(() => gateways.pollPending().catch((e) => log.warn('[poll]', e.message)), 20000));
    timers.push(setInterval(() => orders.sweepStuck().catch(() => {}), 60000));
    timers.forEach((t) => t.unref && t.unref());
  };
  S.stop = () => { timers.forEach(clearInterval); if (db.flush) db.flush(); };
  return { app, S };
}

module.exports = { build };
