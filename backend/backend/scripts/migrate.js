'use strict';
/**
 * One-time (idempotent) migration of the EXISTING ARYAN Firebase data to the new secure backend.
 *   node scripts/migrate.js --dry-run          show what would change
 *   node scripts/migrate.js                    apply (additive - nothing existing is renamed or deleted)
 *   node scripts/migrate.js --purge-legacy     ALSO delete legacy plain-text secrets after they were copied (supplier_settings.apiKey/masterKey,
 *                                              auto_payment_settings.apiKey) - run only after you verified the new panel works.
 * What it does:
 *   1. hashes every plain-text users/{uid}/password with scrypt and deletes the plain-text field
 *   2. builds usernames/ and emails/ lookup indexes (fast + unique logins)
 *   3. gives every product without one its own PID ID (pid_index/, store_products/{key}/pid); status defaults to ACTIVE
 *   4. supplier_settings -> suppliers/SUP_LEGACY (encrypted) and one pid_mappings/* per plan for products that had store_products/{key}/supplierPid
 *   5. auto_payment_settings -> payment_gateways/GW_ZAPUPI (encrypted key, same limits)
 *   6. copies legacy users/{uid}/transactions into the global transactions/ ledger (flagged legacy:true) for admin reports
 */
const { build } = require('../src/config');
const { build: buildApp } = require('../src/app');
const L = require('../src/lib');

const DRY = process.argv.includes('--dry-run'); const PURGE = process.argv.includes('--purge-legacy');
(async () => {
  const cfg = build(); cfg.allowPrivateUrls = true; // migration only stores URLs that were already hard-coded in the old site; the running server always validates URLs
  const { S } = buildApp(cfg, { logger: { log() {}, warn: console.warn, error: console.error } }); const { db } = S;
  const say = (m) => console.log((DRY ? '[dry-run] ' : '') + m); const w = async (fn) => { if (!DRY) await fn(); };
  const users = (await db.get('users')) || {};

  let n = 0; for (const [uid, u] of Object.entries(users)) if (typeof u.password === 'string' && !u.passwordHash) { n++; await w(async () => db.update(`users/${uid}`, { passwordHash: await L.hashPassword(u.password), password: null, tokenVersion: u.tokenVersion || 1 })); }
  say(`1. passwords hashed: ${n}`);

  n = 0; for (const [uid, u] of Object.entries(users)) {
    if (u.username) { const k = L.slug(String(u.username).toLowerCase()); const cur = await db.get(`usernames/${k}`); if (!cur) { n++; await w(() => db.set(`usernames/${k}`, uid)); } else if (cur !== uid) console.warn(`   ! username clash: ${u.username} (${uid} vs ${cur})`); }
    if (u.email) { const k = L.slug(String(u.email).toLowerCase()); const cur = await db.get(`emails/${k}`); if (!cur) { n++; await w(() => db.set(`emails/${k}`, uid)); } }
  }
  say(`2. index entries created: ${n}`);

  const mgmt = (await db.get('store_management')) || {}; const meta = (await db.get('store_products')) || {};
  if (DRY) say(`3. products without PID: ${Object.keys(mgmt).filter((k) => !(meta[k] && meta[k].pid)).length}`); else say(`3. PIDs assigned: ${await S.catalog.ensurePids()}`);

  const legacySup = await db.get('supplier_settings');
  if (legacySup && legacySup.apiKey && legacySup.masterKey) {
    const exists = await db.get('suppliers/SUP_LEGACY');
    if (!exists) await w(() => S.suppliers.save('SUP_LEGACY', { createWithId: true, name: 'Legacy Supplier (bantibhaiya.to)', preset: 'reseller_v1', apiKey: legacySup.apiKey, masterKey: legacySup.masterKey, enabled: legacySup.enabled !== false, priority: 1 }));
    say(`4. supplier migrated${exists ? ' (already existed)' : ''}`);
    let m = 0;
    for (const [key, plans] of Object.entries(mgmt)) {
      const sp = meta[key] && meta[key].supplierPid; if (!sp) continue;
      for (const [pk, pl] of Object.entries(plans)) { m++; await w(async () => { try { await S.catalog.saveMapping(null, { supplierId: 'SUP_LEGACY', supplierPid: String(sp), supplierDuration: pl.daysPlan, productKey: key, planKey: pk, cost: 0, priority: 1 }); } catch (e) { if (e.code !== 'duplicate_mapping') throw e; } }); }
    }
    say(`   mappings for legacy supplierPid products: ${m} (cost price is 0 - set the real supplier cost in Admin > PID Management)`);
    if (PURGE) await w(() => db.update('supplier_settings', { apiKey: null, masterKey: null }));
  } else say('4. no legacy supplier_settings found');

  const ap = await db.get('auto_payment_settings');
  if (ap && ap.apiKey) {
    const exists = await db.get('payment_gateways/GW_ZAPUPI');
    if (!exists) await w(() => S.gateways.save('GW_ZAPUPI', { createWithId: true, name: 'ZapUPI', preset: 'zapupi', apiKey: ap.apiKey, min: ap.minAmount || 1, max: ap.maxAmount || 50000, enabled: !!ap.enabled, priority: 1 }));
    say(`5. payment gateway migrated${exists ? ' (already existed)' : ''}`);
    if (PURGE) await w(() => db.update('auto_payment_settings', { apiKey: null }));
  } else say('5. no legacy auto_payment_settings.apiKey found');

  n = 0; const have = (await db.get('transactions')) || {};
  for (const [uid, u] of Object.entries(users)) for (const [id, t] of Object.entries(u.transactions || {})) {
    if (have[id]) continue; n++;
    const type = t.type || 'Deposit'; const dir = L.round2(0) === 0 && ['Deposit', 'Refund', 'Commission', 'SubSeller_Refund'].includes(type) ? 'in' : 'out';
    await w(() => db.set(`transactions/${id}`, { uid, username: u.username || '', type, direction: dir, amount: L.round2(t.amount), description: t.description || '', source: 'legacy', ts: t.ts || Date.parse(t.date) || 0, date: t.date || '', legacy: true }));
  }
  say(`6. legacy transactions copied: ${n}`);
  console.log(DRY ? '\nDry run finished - nothing was changed.' : '\nMigration finished.');
  S.stop(); process.exit(0);
})().catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });
