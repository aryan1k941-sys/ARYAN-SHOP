'use strict';
/**
 * Demo data (clearly fake: DEMO- keys, demo users). Used by `npm run demo` and by the automated tests.
 * Product names/PIDs/prices follow the format from your reference screenshots. NEVER run against your production database.
 */
const { hashPassword, encrypt, slug, now, pushKey } = require('../src/lib');

const P = (key, name, pid, cat, tags, plans, extra = {}) => ({ key, name, pid, cat, tags, plans, ...extra });
// plan: [duration, userPrice, resellerPrice, stockCount|'api'|0]
const PRODUCTS = [
  P('BALA_MODS_151', 'BALA MODS 151', '151', 'ANDROID', ['ANDROID'], [['1 HOUR', 15, 10, 'api'], ['1 DAY', 30, 22, 'api']], { description: 'Example product: PID ID 151, price ₹15, duration 1 HOUR. Instant delivery.', badge: 'NEW' }),
  P('BALA_MODS', 'BALA MODS', '152', 'ANDROID', ['ANDROID'], [['1 DAY', 30, 20, 12], ['7 DAYS', 120, 90, 6]], { description: 'Example product: PID ID 152, price ₹30, duration 1 DAY.' }),
  P('KOS_8_BALL_POOL_VIRTUAL', 'KOS 8 BALL POOL VIRTUAL', '76', 'POOL', ['ANDROID'], [['1 DAYS', 150, 120, 'api'], ['7 DAYS', 450, 300, 'api'], ['15 DAYS', 800, 650, 'api'], ['30 DAYS', 1500, 1200, 'api']], { badge: 'HOT' }),
  P('SNAKE_SOCCER_STARS_NONROOT_ANDROID', 'SNAKE SOCCER STARS NONROOT ANDROID', '78', 'SOCCER', ['ANDROID'], [['3 DAYS', 160, 130, 4], ['10 DAYS', 350, 320, 3], ['30 DAYS', 650, 550, 2]]),
  P('BR_MOD_FF_PC_VERSION', 'BR MOD FF PC VERSION', '49', 'FREE FIRE', ['PC'], [['1 DAY', 79, 30, 1], ['10 DAYS', 479, 100, 2], ['30 DAYS', 799, 150, 3]]),
  P('BR_MOD_FF_ROOT_ANDROID', 'BR MOD FF ROOT ANDROID', '67', 'FREE FIRE', ['ANDROID'], [['1 DAYS', 79, 28, 5], ['7 DAYS', 319, 60, 5]], { maintenance: true }),
  P('SILENT_CHEAT_FF_NONROOT_APKMOD', 'SILENT CHEAT FF NONROOT APKMOD', '127', 'FREE FIRE', ['ANDROID'], [['1 DAYS', 90, 26, 22], ['3 DAYS', 180, 65, 59], ['7 DAYS', 350, 130, 19], ['14 DAYS', 600, 260, 29], ['28 DAYS', 900, 520, 21]], { badge: 'BEST SELLER' }),
  P('FLUORITE_IOS_FF', 'FLUORITE IOS FF', '58', 'FREE FIRE', ['IOS'], [['1 DAYS', 400, 150, 3], ['7 DAYS', 1200, 400, 2]], { maintenance: true }),
  P('IOS_CLOUD_CODM', 'IOS CLOUD CODM', '87', 'CODM', ['IOS'], [['1 DAYS', 400, 150, 'api'], ['7 DAYS', 1000, 400, 'api'], ['30 DAYS', 2000, 850, 'api']]),
  P('PHANTOM_FF_ALL', 'PHANTOM FF ALL', '133', 'FREE FIRE', ['ANDROID', 'IOS'], [['1 HOURS', 18, 7, 'api'], ['6 HOURS', 40, 20, 'api'], ['24 HOURS', 90, 45, 'api'], ['7 DAYS', 250, 165, 'api']]),
  P('PATO_TEAM_FF_ALL_ANDROID', 'PATO TEAM FF ALL ANDROID', '54', 'FREE FIRE', ['ANDROID'], [['3 DAYS', 120, 75, 22], ['7 DAYS', 250, 150, 40], ['15 DAYS', 300, 180, 38], ['30 DAYS', 600, 270, 22]]),
  P('DRIPCLIENT_FF_ROOT_ANDROID', 'DRIPCLIENT FF ROOT ANDROID', '63', 'FREE FIRE', ['ANDROID'], [['1 DAYS', 21, 11, 143], ['7 DAYS', 150, 65, 30], ['30 DAYS', 290, 145, 14]]),
];

async function seed(S, { supplierUrl = 'http://127.0.0.1:0/api/reseller_v1.php', gatewayUrl = 'http://127.0.0.1:0', admin = false } = {}) {
  const { db, catalog } = S;
  for (const [username, name, role, bal, pw] of [['demo', 'Demo User', 'User', 500, 'demo1234'], ['reseller', 'Demo Reseller', 'Reseller', 1500, 'reseller123']]) {
    const uid = `UID-${username === 'demo' ? '111111' : '222222'}-${username}`;
    await db.set(`users/${uid}`, { name, email: `${username}@demo.local`, username, passwordHash: await hashPassword(pw), role, balance: bal, keyCount: 0, status: 'Active', joinedAt: now(), tokenVersion: 1 });
    await db.set(`usernames/${username}`, uid); await db.set(`emails/${slug(`${username}@demo.local`)}`, uid);
  }
  const supId = 'SUP_DEMO';
  await S.suppliers.save(supId, { createWithId: true, name: 'Supplier One', preset: 'reseller_v1', apiUrl: supplierUrl, apiKey: 'demo-supplier-api-key-123', masterKey: 'demo-master-key-456', priority: 1, enabled: true, username: 'supplier_one' });
  for (const p of PRODUCTS) {
    const plans = {}; const stock = {}; let i = 0;
    for (const [dur, up, rp, st] of p.plans) {
      const pk = `p${++i}_${slug(dur)}`; plans[pk] = { productName: p.name, daysPlan: dur, priceRate: up, resellerPrice: rp };
      if (typeof st === 'number') { const o = {}; for (let n = 0; n < st; n++) o[pushKey()] = `DEMO-${p.pid}-${slug(dur)}-${String(n + 1).padStart(4, '0')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; stock[pk] = o; }
    }
    await db.set(`store_management/${p.key}`, plans);
    await db.set(`store_products/${p.key}`, { name: p.name, pid: p.pid, category: p.cat, tags: p.tags, status: 'ACTIVE', description: p.description || `${p.name} - premium access key delivered instantly after purchase.`, badge: p.badge || '', features: 'Instant delivery\nAuto key generation\n24x7 support', game: p.cat });
    await db.set(`pid_index/${slug(p.pid)}`, p.key);
    if (Object.keys(stock).length) await db.set(`key_stock/${p.key}`, stock);
    if (p.maintenance) await db.set(`product_maintenance/${p.key}`, true);
  }
  // supplier mappings: supplier PID is DIFFERENT from the ARYAN PID
  const sp = { BALA_MODS_151: 9876 };
  let n = 100;
  for (const p of PRODUCTS) {
    const plans = (await db.get(`store_management/${p.key}`)) || {};
    for (const [pk, pl] of Object.entries(plans)) {
      const src = p.plans.find((x) => x[0] === pl.daysPlan);
      if (src[3] !== 'api') continue;
      const supplierPid = sp[p.key] || String(5000 + (n++));
      await catalog.saveMapping(null, { supplierId: supId, supplierPid: String(supplierPid), supplierDuration: pl.daysPlan, productKey: p.key, planKey: pk, cost: Math.round(src[2] * 0.7 * 100) / 100 || 1, priority: 1 });
    }
  }
  // BALA MODS 151, 1 HOUR: supplier cost 10 -> sells at 15 (spec example)
  const maps = (await db.get('pid_mappings')) || {};
  for (const [id, m] of Object.entries(maps)) if (m.productKey === 'BALA_MODS_151' && m.supplierDuration === '1 HOUR') await db.update(`pid_mappings/${id}`, { cost: 10 });
  await S.gateways.save('GW_ZAPUPI', { createWithId: true, name: 'ZapUPI', preset: 'zapupi', baseUrl: gatewayUrl, apiKey: 'demo-gateway-key', min: 10, max: 50000, priority: 1, enabled: true, webhookOrderIdPath: 'order_id' });
  await S.gateways.save('GW_FAM', { createWithId: true, name: 'FAM Gateway', preset: 'generic', baseUrl: 'https://famgateway.in', enabled: false, priority: 2 });
  await db.set('branding', { siteName: 'ARYAN', tagline: 'Premium digital products & reseller platform', logoUrl: '', faviconUrl: '', banners: [], accent: '#00e5ff' });
  await db.set('site_settings/links', { announcement: 'Welcome to ARYAN - instant keys, live wallet & reseller API.', howToDepositUrl: 'https://example.com/deposit', refTarget: 30, telegramUrl: 'https://t.me/example', safetyBalance: 'Keep a safety balance of ₹100 for instant orders.' });
  await db.set('site_settings/reseller_upgrade', { enabled: true, minBalance: 10, commissionPct: 1 });
  await db.push('announcements', { title: 'Demo mode', body: 'This is demo data. Keys are fake (DEMO-...).', type: 'info', active: true, pinned: true, createdAt: now() });
  await db.set('telegram_settings', { enabled: false, notify: { user: true, order: true, payment: true, admin: true, delivery: true } });
  await S.catalog.ensurePids();
  return { supId };
}

module.exports = { seed, PRODUCTS };
if (require.main === module) { console.log('Run: npm run demo  (starts mock supplier/gateway, seeds, and serves the panels).'); }
