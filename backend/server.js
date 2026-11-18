#!/usr/bin/env node
'use strict';
const { build } = require('./src/config');
const { build: buildApp } = require('./src/app');

const cfg = build();
const { app, S } = buildApp(cfg);

app.server.listen(cfg.port, cfg.host, async () => {
  await S.start();
  setInterval(() => S.trimLogs && S.trimLogs().catch(() => {}), 3600 * 1000).unref();
  console.log(`ARYAN backend listening on http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}  (db: ${S.driver}${cfg.prod ? ', production' : ', development'})`);
  console.log(`  User panel : /      Admin panel : /admin`);
  if (!cfg.prod) console.warn('  [dev] NODE_ENV is not "production" - do not expose this instance publicly.');
});

const stop = () => { S.stop(); app.server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message));
