'use strict';
/**
 * Database + file storage drivers.
 *  - FirebaseDb : Firebase Realtime Database through the Admin SDK (production). Same paths as the
 *                 existing site (users/, store_products/, store_management/, key_stock/ ...).
 *  - FileDb     : JSON file, single process. For local demo and tests only.
 * Both expose the same async API: get, set, update(multi-path), push, remove, transaction, queryEq.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pushKey } = require('./lib');

const clean = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clean);
  const o = {};
  for (const [k, x] of Object.entries(v)) { const c = clean(x); if (c !== null) o[k] = c; }
  return Object.keys(o).length ? o : null;
};
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const split = (p) => String(p || '').split('/').filter(Boolean);

class FileDb {
  constructor(file) {
    this.file = file; this.root = {}; this.timer = null;
    try { this.root = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.root = {}; }
    process.on('exit', () => this.flush());
  }
  _node(parts) { let n = this.root; for (const k of parts) { if (n == null || typeof n !== 'object') return undefined; n = n[k]; } return n; }
  _put(parts, val) {
    if (!parts.length) { this.root = val || {}; return; }
    const chain = [this.root]; let n = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (val === null && (n[parts[i]] === undefined)) return;
      if (typeof n[parts[i]] !== 'object' || n[parts[i]] === null) n[parts[i]] = {};
      n = n[parts[i]]; chain.push(n);
    }
    const last = parts[parts.length - 1];
    if (val === null) delete n[last]; else n[last] = val;
    for (let i = chain.length - 1; i > 0; i--) { if (Object.keys(chain[i]).length === 0) delete chain[i - 1][parts[i - 1]]; else break; }
  }
  _dirty() { if (this.timer) return; this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 150); this.timer.unref?.(); }
  flush() {
    try { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.root)); fs.renameSync(tmp, this.file); } catch (e) { console.error('db flush failed', e.message); }
  }
  async get(p) { const v = this._node(split(p)); return v === undefined ? null : clone(v); }
  async set(p, v) { this._put(split(p), clean(v)); this._dirty(); }
  async update(p, ups) { const base = split(p); for (const [rel, v] of Object.entries(ups)) this._put(base.concat(split(rel)), clean(v)); this._dirty(); }
  async push(p, v) { const k = pushKey(); await this.set(`${p}/${k}`, v); return k; }
  async remove(p) { this._put(split(p), null); this._dirty(); }
  async transaction(p, fn) {
    const parts = split(p); const cur = this._node(parts); const curC = cur === undefined ? null : clone(cur);
    const next = fn(curC);
    if (next === undefined) return { committed: false, value: curC };
    this._put(parts, clean(next)); this._dirty();
    return { committed: true, value: clone(clean(next)) };
  }
  async queryEq(p, child, value) {
    const n = this._node(split(p)) || {}; const out = {};
    for (const [k, v] of Object.entries(n)) if (v && typeof v === 'object' && v[child] === value) out[k] = clone(v);
    return out;
  }
}

class FirebaseDb {
  constructor(cfg) {
    let admin;
    try { admin = require('firebase-admin'); } catch { throw new Error('firebase-admin is not installed. Run "npm install" in /backend (or use DB_DRIVER=file for the local demo).'); }
    let cred;
    const sa = cfg.serviceAccount;
    if (sa && sa.trim().startsWith('{')) cred = admin.credential.cert(JSON.parse(sa));
    else if (sa) cred = admin.credential.cert(JSON.parse(fs.readFileSync(sa, 'utf8')));
    else cred = admin.credential.applicationDefault();
    admin.initializeApp({ credential: cred, databaseURL: cfg.databaseURL, storageBucket: cfg.storageBucket });
    this.admin = admin; this.rdb = admin.database();
  }
  _r(p) { const s = split(p).join('/'); return s ? this.rdb.ref(s) : this.rdb.ref(); }
  async get(p) { const s = await this._r(p).once('value'); return s.exists() ? s.val() : null; }
  async set(p, v) { await this._r(p).set(clean(v)); }
  async update(p, ups) { const o = {}; for (const [k, v] of Object.entries(ups)) o[split(k).join('/')] = clean(v); await this._r(p).update(o); }
  async push(p, v) { const r = this._r(p).push(); await r.set(clean(v)); return r.key; }
  async remove(p) { await this._r(p).remove(); }
  async transaction(p, fn) {
    const r = await this._r(p).transaction((cur) => { const n = fn(cur === undefined ? null : cur); return n === undefined ? undefined : clean(n); }, undefined, false);
    return { committed: r.committed, value: r.snapshot.exists() ? r.snapshot.val() : null };
  }
  async queryEq(p, child, value) {
    const s = await this._r(p).orderByChild(child).equalTo(value).once('value');
    return s.exists() ? s.val() : {};
  }
}

/* ---------------- file storage (images / videos) ---------------- */
class LocalStorage {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }); }
  _p(n) { return path.join(this.dir, path.basename(n)); }
  put(name, contentType, readable) {
    return new Promise((res, rej) => {
      const w = fs.createWriteStream(this._p(name));
      readable.pipe(w); w.on('finish', () => res()); w.on('error', rej); readable.on('error', rej);
    });
  }
  async get(name) {
    const f = this._p(name); const st = await fs.promises.stat(f);
    return { stream: fs.createReadStream(f), size: st.size };
  }
  async del(name) { await fs.promises.rm(this._p(name), { force: true }); }
}
class FirebaseStorage {
  constructor(admin, bucketName) { this.bucket = admin.storage().bucket(bucketName); }
  put(name, contentType, readable) {
    return new Promise((res, rej) => {
      const w = this.bucket.file(`uploads/${name}`).createWriteStream({ contentType, resumable: false });
      readable.pipe(w); w.on('finish', () => res()); w.on('error', rej); readable.on('error', rej);
    });
  }
  async get(name) {
    const f = this.bucket.file(`uploads/${path.basename(name)}`);
    const [meta] = await f.getMetadata();
    return { stream: f.createReadStream(), size: Number(meta.size) };
  }
  async del(name) { await this.bucket.file(`uploads/${path.basename(name)}`).delete({ ignoreNotFound: true }); }
}

function createDb(config) {
  if (config.dbDriver === 'firebase') {
    const db = new FirebaseDb(config.firebase);
    return { db, storage: new FirebaseStorage(db.admin, config.firebase.storageBucket), driver: 'firebase' };
  }
  return { db: new FileDb(path.join(config.dataDir, 'db.json')), storage: new LocalStorage(path.join(config.dataDir, 'uploads')), driver: 'file' };
}

module.exports = { createDb, FileDb };
