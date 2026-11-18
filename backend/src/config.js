'use strict';
/** Loads .env (tiny parser, no dependency) and exposes validated configuration. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
const root = path.resolve(__dirname, '..');
loadEnvFile(path.join(root, '.env'));

function build(env = process.env) {
  const e = (k, d = '') => (env[k] === undefined || env[k] === '' ? d : env[k]);
  const prod = e('NODE_ENV') === 'production';
  const dbDriver = e('DB_DRIVER', 'file');
  const dataDir = path.resolve(root, e('DATA_DIR', './data'));
  fs.mkdirSync(dataDir, { recursive: true });

  let jwtSecret = e('JWT_SECRET'), secretsKey = e('SECRETS_KEY');
  if (!jwtSecret || !secretsKey) {
    if (prod) throw new Error('JWT_SECRET and SECRETS_KEY are required in production. Run: npm run gen-secrets');
    // Development convenience only: persist auto-generated secrets next to the local data.
    const f = path.join(dataDir, '.dev-secrets.json');
    let s = {};
    try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    if (!s.jwt) { s = { jwt: crypto.randomBytes(48).toString('base64url'), key: crypto.randomBytes(32).toString('base64') }; fs.writeFileSync(f, JSON.stringify(s), { mode: 0o600 }); }
    jwtSecret = jwtSecret || s.jwt; secretsKey = secretsKey || s.key;
  }
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

  return {
    prod,
    port: parseInt(e('PORT', '3000'), 10),
    host: e('HOST', '0.0.0.0'),
    publicUrl: e('PUBLIC_URL', '').replace(/\/$/, ''),
    allowedOrigins: e('ALLOWED_ORIGINS', '').split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: e('TRUST_PROXY', '0') === '1',
    frontendDir: path.resolve(root, e('FRONTEND_DIR', '..')),
    dataDir,
    dbDriver,
    firebase: {
      databaseURL: e('FIREBASE_DATABASE_URL', 'https://aryan-mods-4c084-default-rtdb.firebaseio.com'),
      serviceAccount: e('FIREBASE_SERVICE_ACCOUNT_JSON'), // path to JSON file OR the raw JSON
      storageBucket: e('FIREBASE_STORAGE_BUCKET', 'aryan-mods-4c084.firebasestorage.app'),
      webApiKey: e('FIREBASE_WEB_API_KEY'), // public web key; used only to verify admin email/password with Firebase Auth
    },
    jwtSecret, secretsKey,
    userTokenTtl: 60 * 60 * 24 * 7,
    adminTokenTtl: 60 * 60 * 12,
    admin: {
      mode: e('ADMIN_AUTH', dbDriver === 'firebase' ? 'firebase' : 'local'), // firebase | local
      emails: e('ADMIN_EMAILS', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      localEmail: e('ADMIN_LOCAL_EMAIL', '').toLowerCase(),
      localPasswordHash: e('ADMIN_LOCAL_PASSWORD_HASH'),
      ipAllowlist: e('ADMIN_IP_ALLOWLIST', '').split(',').map((s) => s.trim()).filter(Boolean),
    },
    mail: { provider: e('MAIL_PROVIDER', ''), resendKey: e('RESEND_API_KEY'), from: e('MAIL_FROM', 'ARYAN <no-reply@example.com>') },
    allowPrivateUrls: e('ALLOW_PRIVATE_URLS', '0') === '1', // tests / local suppliers only
    uploadMaxMb: parseInt(e('UPLOAD_MAX_MB', '100'), 10),
    poll: { payments: e('PAYMENT_POLL', '1') === '1' },
  };
}

module.exports = { build, root };
