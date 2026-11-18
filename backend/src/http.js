'use strict';
/** Minimal HTTP framework: routing, JSON body, CORS, security headers, static HTML with CSP nonce. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('./lib');

function createApp(config, log = console) {
  const routes = [];
  const add = (method, pattern, opts, handler) => {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler, opts });
  };
  const app = { routes, add };
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) app[m] = (p, o, h) => add(m.toUpperCase(), p, o, h);

  function clientIp(req) {
    if (config.trustProxy) {
      const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xf) return xf;
    }
    return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  }

  function baseHeaders(res, nonce) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.prod) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (nonce) {
      res.setHeader('Content-Security-Policy', [
        "default-src 'self'", `script-src 'nonce-${nonce}'`, "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:", "img-src 'self' data: blob: https:", "media-src 'self' blob: https:",
        "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
      ].join('; '));
    }
  }

  function cors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return;
    const same = config.publicUrl && origin === config.publicUrl;
    const hostSame = origin.replace(/^https?:\/\//, '') === req.headers.host;
    if (same || hostSame || config.allowedOrigins.includes(origin) || config.allowedOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, Idempotency-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > max) { reject(new HttpError(413, 'Request too large', 'too_large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const send = (res, status, obj, headers = {}) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...headers });
    res.end(body);
  };

  const htmlFiles = { '/': 'index.html', '/index.html': 'index.html', '/admin': 'Admin.html', '/Admin.html': 'Admin.html', '/admin.html': 'Admin.html' };

  async function serveHtml(req, res, file) {
    const f = path.join(config.frontendDir, file);
    let html;
    try { html = await fs.promises.readFile(f, 'utf8'); } catch { return send(res, 404, { ok: false, error: `${file} not found in FRONTEND_DIR` }); }
    const nonce = crypto.randomBytes(16).toString('base64');
    baseHeaders(res, nonce);
    const out = html.replace(/__NONCE__/g, nonce);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(out);
  }

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url, 'http://x');
    const ctx = { req, res, url, query: Object.fromEntries(url.searchParams), params: {}, ip: clientIp(req), method: req.method, path: url.pathname, body: {} };
    try {
      baseHeaders(res);
      cors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && htmlFiles[ctx.path]) return await serveHtml(req, res, htmlFiles[ctx.path]);
      if (req.method === 'GET' && ctx.path === '/favicon.ico') { res.writeHead(204); return res.end(); }

      let route = null, pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(ctx.path);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        route = r; r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
        break;
      }
      if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Route not found', pathMatched ? 'method_not_allowed' : 'not_found');

      if (!route.opts.raw && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const buf = await readBody(req, route.opts.maxBytes || 1024 * 1024);
        ctx.rawBody = buf;
        if (buf.length) {
          const ct = String(req.headers['content-type'] || '');
          if (ct.includes('application/x-www-form-urlencoded')) ctx.body = Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
          else { try { ctx.body = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON body', 'invalid_json'); } }
        }
      }
      ctx.send = (status, obj, h) => send(res, status, obj, h);
      const out = await route.handler(ctx);
      if (out !== undefined && !res.writableEnded && !res.headersSent) send(res, 200, { ok: true, ...(typeof out === 'object' && out !== null ? out : { data: out }) });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) log.error('[error]', ctx.method, ctx.path, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
      if (!res.headersSent) send(res, status, { ok: false, error: e instanceof HttpError ? e.message : 'Internal server error', code: e instanceof HttpError ? e.code : 'internal', ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}) }, e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {});
    } finally {
      if (ctx.onFinish) { try { ctx.onFinish(res.statusCode, Date.now() - t0); } catch {} }
    }
  });
  server.requestTimeout = 120000;
  app.server = server;
  app.clientIp = clientIp;
  return app;
}

module.exports = { createApp };
