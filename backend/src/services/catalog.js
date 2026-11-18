'use strict';
/**
 * Product catalogue on top of the EXISTING paths:
 *   store_products/{key}    meta  (name, tags, imageUrl, downloadUrl, supplierPid(legacy), game, features, videoUrl, badge)  + NEW: pid, category, status, description, thumbnailUrl, bannerUrl
 *   store_management/{key}/{planKey} = { productName, daysPlan, priceRate, resellerPrice }
 *   key_stock/{key}/{planKey}/{id}   = "<key string>"
 *   product_maintenance/{key}        = true
 * NEW: pid_index/{pid} -> productKey, pid_mappings/*, pid_map_index/*
 */
const { HttpError, bad, conflict, notFound, slug, round2, num, str, now, durKey, randId } = require('../lib');

const PID_RE = /^[A-Za-z0-9_-]{1,20}$/;

function createCatalog({ db }) {
  const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));

  function shapeProduct(key, meta, plansObj, maint) {
    meta = meta || {}; plansObj = plansObj || {};
    const first = Object.values(plansObj)[0] || {};
    const tags = Array.isArray(meta.tags) ? meta.tags : Object.keys(meta.tags || {});
    const features = (Array.isArray(meta.features) ? meta.features : String(meta.features || '').split('\n')).map((x) => String(x).trim()).filter(Boolean);
    const plans = Object.keys(plansObj).map((pk) => ({
      pk, duration: plansObj[pk].daysPlan || pk, price: num(plansObj[pk].priceRate), rprice: plansObj[pk].resellerPrice != null ? num(plansObj[pk].resellerPrice) : null,
    }));
    const status = String(meta.status || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
    return {
      key, pid: meta.pid ? String(meta.pid) : '', name: meta.name || first.productName || key,
      category: meta.category || tags[0] || meta.game || '', tags, game: String(meta.game || '').trim().toUpperCase(),
      status, maintenance: !!maint, displayStatus: status === 'INACTIVE' ? 'INACTIVE' : (maint ? 'MAINTENANCE' : 'ACTIVE'),
      description: meta.description || features.join(' • '), features,
      imageUrl: meta.imageUrl || '', thumbnailUrl: meta.thumbnailUrl || meta.imageUrl || '', bannerUrl: meta.bannerUrl || '', videoUrl: meta.videoUrl || '', downloadUrl: meta.downloadUrl || '',
      badge: String(meta.badge || '').toUpperCase(), legacySupplierPid: meta.supplierPid || '', plans,
    };
  }

  async function loadAll(only) {
    const one = (path, k) => (only ? db.get(`${path}/${only}`).then((v) => (v == null ? null : { [only]: v })) : db.get(path));
    const [mgmt, meta, stock, maint, maps, sups] = await Promise.all([
      one('store_management'), one('store_products'), one('key_stock'), one('product_maintenance'), db.get('pid_mappings'), db.get('suppliers'),
    ]);
    const supOn = {}; Object.entries(sups || {}).forEach(([id, s]) => { supOn[id] = s && s.enabled !== false && !s.disabled ? s : null; });
    const mapsByPlan = {};
    Object.entries(maps || {}).forEach(([id, m]) => { if (!m) return; (mapsByPlan[`${m.productKey}/${m.planKey}`] ||= []).push({ id, ...m }); });
    const products = Object.keys(mgmt || {}).map((k) => shapeProduct(k, (meta || {})[k], mgmt[k], (maint || {})[k]));
    for (const p of products) {
      for (const pl of p.plans) {
        pl.stock = Object.keys(((stock || {})[p.key] || {})[pl.pk] || {}).length;
        pl.mappings = (mapsByPlan[`${p.key}/${pl.pk}`] || []).filter((m) => m.enabled !== false && supOn[m.supplierId]).sort((a, b) => num(supOn[a.supplierId].priority, 100) - num(supOn[b.supplierId].priority, 100) || num(a.priority, 100) - num(b.priority, 100));
        pl.allMappings = mapsByPlan[`${p.key}/${pl.pk}`] || [];
      }
    }
    return products.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Fulfilment plan for a plan: stock first, supplier API as fallback. */
  function routeFor(plan, qty) {
    if (plan.stock >= qty) return { type: 'stock' };
    if (plan.mappings.length) return { type: 'supplier', mappings: plan.mappings };
    return null;
  }

  function publicView(products, role) {
    const isRes = role === 'Reseller';
    return products.map((p) => ({
      key: p.key, pid: p.pid, name: p.name, category: p.category, tags: p.tags, game: p.game, status: p.displayStatus, description: p.description, features: p.features,
      imageUrl: p.imageUrl, thumbnailUrl: p.thumbnailUrl, bannerUrl: p.bannerUrl, videoUrl: p.videoUrl, hasDownload: !!p.downloadUrl, badge: p.badge,
      plans: p.plans.map((pl) => {
        const r = routeFor(pl, 1);
        return {
          pk: pl.pk, duration: pl.duration, userPrice: pl.price, resellerPrice: isRes ? pl.rprice : null, price: isRes && pl.rprice != null ? pl.rprice : pl.price,
          delivery: pl.stock > 0 ? 'STOCK' : (pl.mappings.length ? 'AUTO API' : 'NONE'), stock: pl.stock > 0 ? pl.stock : (pl.mappings.length ? null : 0), available: !!r,
        };
      }),
    }));
  }

  /* ---------- PIDs ---------- */
  async function claimPid(pid, key) {
    if (!PID_RE.test(pid)) throw bad('PID ID can only contain letters, numbers, - and _ (max 20)');
    const r = await db.transaction(`pid_index/${slug(pid)}`, (cur) => (cur && cur !== key ? undefined : key));
    if (!r.committed) throw conflict(`PID ID ${pid} is already used by another product`, 'pid_taken');
  }
  async function setPid(key, pid) {
    const meta = (await db.get(`store_products/${key}`)) || {};
    const old = meta.pid ? String(meta.pid) : '';
    if (old === pid) return;
    await claimPid(pid, key);
    await db.update('', { [`store_products/${key}/pid`]: pid, ...(old ? { [`pid_index/${slug(old)}`]: null } : {}) });
  }
  async function nextPid() {
    const idx = (await db.get('pid_index')) || {};
    let max = 100; Object.keys(idx).forEach((k) => { const n = parseInt(k, 10); if (Number.isFinite(n) && n > max) max = n; });
    return String(max + 1);
  }
  async function ensurePids() {
    const [mgmt, meta] = await Promise.all([db.get('store_management'), db.get('store_products')]);
    const keys = Object.keys(mgmt || {}); let assigned = 0;
    const idx = (await db.get('pid_index')) || {};
    // adopt any pid that already exists on products (re-index)
    for (const k of keys) { const p = (meta || {})[k]; if (p && p.pid && idx[slug(p.pid)] !== k && !idx[slug(p.pid)]) { await db.set(`pid_index/${slug(p.pid)}`, k); } }
    for (const k of keys.sort()) {
      const p = (meta || {})[k] || {};
      if (p.pid) continue;
      const pid = await nextPid(); await claimPid(pid, k); await db.set(`store_products/${k}/pid`, pid); assigned++;
    }
    return assigned;
  }
  async function findByPid(pid) {
    pid = String(pid || '').trim(); if (!pid) return null;
    const k = await db.get(`pid_index/${slug(pid)}`);
    return k || null;
  }

  /* ---------- admin writes ---------- */
  function cleanPlans(plans) {
    if (!Array.isArray(plans) || !plans.length) throw bad('Add at least one duration/price');
    const seen = new Set();
    return plans.map((p) => {
      const duration = str(p.duration ?? p.days, 60); const price = round2(p.price); const rprice = p.rprice === '' || p.rprice == null ? price : round2(p.rprice);
      if (!duration) throw bad('Every plan needs a DURATION');
      if (!(price >= 0) || !(rprice >= 0)) throw bad('Prices must be 0 or more');
      const dk = durKey(duration); if (seen.has(dk)) throw bad(`Duplicate duration: ${duration}`); seen.add(dk);
      return { pk: p.pk && /^[A-Za-z0-9_\-]+$/.test(p.pk) ? p.pk : '', duration, price, rprice };
    });
  }

  async function saveProduct(oldKey, d) {
    const name = str(d.name, 120); if (!name) throw bad('NAME is required');
    const plans = cleanPlans(d.plans);
    const key = oldKey || slug(name);
    if (!oldKey && (await db.get(`store_management/${key}`))) throw conflict('A product with this NAME already exists');
    let pid = str(d.pid, 20);
    const cur = (await db.get(`store_products/${key}`)) || {};
    if (!pid) pid = cur.pid || (await nextPid());
    await claimPid(pid, key);
    const plansObj = {}; const used = new Set();
    plans.forEach((p, i) => { let pk = p.pk; if (!pk || used.has(pk)) pk = `p${Date.now().toString(36)}${i}_${slug(p.duration)}`; used.add(pk); plansObj[pk] = { productName: name, daysPlan: p.duration, priceRate: p.price, resellerPrice: p.rprice }; });
    const tags = Array.isArray(d.tags) ? d.tags.map((t) => str(t, 40)).filter(Boolean) : (cur.tags || []);
    const meta = {
      ...cur, name, pid, tags, category: str(d.category ?? cur.category ?? tags[0] ?? '', 60), status: String(d.status || cur.status || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
      description: str(d.description ?? cur.description ?? '', 2000), game: str(d.game ?? cur.game ?? '', 60), badge: ['', 'NEW', 'HOT', 'BEST SELLER'].includes(String(d.badge ?? cur.badge ?? '').toUpperCase()) ? String(d.badge ?? cur.badge ?? '').toUpperCase() : '',
      features: str(d.features ?? cur.features ?? '', 4000), imageUrl: str(d.imageUrl ?? cur.imageUrl ?? '', 600), thumbnailUrl: str(d.thumbnailUrl ?? cur.thumbnailUrl ?? '', 600), bannerUrl: str(d.bannerUrl ?? cur.bannerUrl ?? '', 600),
      videoUrl: str(d.videoUrl ?? cur.videoUrl ?? '', 600), downloadUrl: str(d.downloadUrl ?? cur.downloadUrl ?? '', 600), updatedAt: now(),
    };
    for (const u of ['imageUrl', 'thumbnailUrl', 'bannerUrl', 'videoUrl', 'downloadUrl']) if (meta[u] && !/^(https?:\/\/|\/media\/)/i.test(meta[u])) throw bad(`${u} must be an http(s) URL or an uploaded media path`);
    await db.update('', { [`store_management/${key}`]: plansObj, [`store_products/${key}`]: meta });
    // release the previous PID if it changed
    if (cur.pid && String(cur.pid) !== pid) await db.remove(`pid_index/${slug(cur.pid)}`);
    // re-point pid_mappings when plan keys were regenerated (not expected: pk preserved) - nothing to do
    return { key, pid };
  }

  async function deleteProduct(key) {
    const meta = (await db.get(`store_products/${key}`)) || {};
    const maps = (await db.get('pid_mappings')) || {};
    const ups = { [`store_management/${key}`]: null, [`store_products/${key}`]: null, [`key_stock/${key}`]: null, [`product_maintenance/${key}`]: null };
    if (meta.pid) ups[`pid_index/${slug(meta.pid)}`] = null;
    for (const [id, m] of Object.entries(maps)) if (m && m.productKey === key) { ups[`pid_mappings/${id}`] = null; ups[`pid_map_index/${mapKeyU(m)}`] = null; ups[`pid_map_index/${mapKeyA(m)}`] = null; }
    await db.update('', ups);
  }

  /* ---------- PID mappings (supplier PID -> ARYAN product/plan) ---------- */
  const mapKeyU = (m) => `u_${slug(m.supplierId)}_${slug(m.supplierPid)}_${slug(m.supplierDuration || '')}`;
  const mapKeyA = (m) => `a_${slug(m.productKey)}_${slug(m.planKey)}_${slug(m.supplierId)}`;

  async function saveMapping(id, d) {
    const sup = await db.get(`suppliers/${d.supplierId}`); if (!sup) throw notFound('Supplier not found');
    const mgmt = await db.get(`store_management/${d.productKey}`); if (!mgmt || !mgmt[d.planKey]) throw notFound('ARYAN product/plan not found');
    const supplierPid = str(d.supplierPid, 60); if (!supplierPid) throw bad('Supplier PID is required');
    const m = {
      supplierId: d.supplierId, supplierPid, supplierDuration: str(d.supplierDuration || mgmt[d.planKey].daysPlan, 60), productKey: d.productKey, planKey: d.planKey,
      aryanPid: ((await db.get(`store_products/${d.productKey}`)) || {}).pid || '', cost: round2(d.cost), priority: Math.max(1, parseInt(d.priority, 10) || 100), enabled: d.enabled !== false,
      note: str(d.note, 200), updatedAt: now(),
    };
    if (!(m.cost >= 0)) throw bad('Supplier cost price must be 0 or more');
    const newId = id || randId('MAP', 4); const old = id ? await db.get(`pid_mappings/${id}`) : null;
    const claim = async (k) => { const r = await db.transaction(`pid_map_index/${k}`, (c) => (c && c !== newId ? undefined : newId)); if (!r.committed) throw conflict('Duplicate mapping: this Supplier PID/duration or this ARYAN plan + supplier is already mapped', 'duplicate_mapping'); };
    await claim(mapKeyU(m)); await claim(mapKeyA(m));
    if (old) { for (const k of [mapKeyU(old), mapKeyA(old)]) if (k !== mapKeyU(m) && k !== mapKeyA(m)) await db.remove(`pid_map_index/${k}`); }
    await db.set(`pid_mappings/${newId}`, { ...(old || {}), ...m, createdAt: (old && old.createdAt) || now() });
    if (d.sellPrice !== undefined && d.sellPrice !== '' && d.sellPrice !== null) {
      const sp = round2(d.sellPrice); if (!(sp >= 0)) throw bad('Selling price must be 0 or more');
      const ups = { [`store_management/${d.productKey}/${d.planKey}/priceRate`]: sp };
      if (d.resellerPrice !== undefined && d.resellerPrice !== '' && d.resellerPrice !== null) ups[`store_management/${d.productKey}/${d.planKey}/resellerPrice`] = round2(d.resellerPrice);
      await db.update('', ups);
    }
    return newId;
  }
  async function deleteMapping(id) {
    const m = await db.get(`pid_mappings/${id}`); if (!m) throw notFound('Mapping not found');
    await db.update('', { [`pid_mappings/${id}`]: null, [`pid_map_index/${mapKeyU(m)}`]: null, [`pid_map_index/${mapKeyA(m)}`]: null });
  }

  return { loadAll, routeFor, publicView, shapeProduct, setPid, ensurePids, nextPid, findByPid, saveProduct, deleteProduct, saveMapping, deleteMapping, claimPid, mapKeyU, mapKeyA, asArr };
}

module.exports = { createCatalog, PID_RE };
