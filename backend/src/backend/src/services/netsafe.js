'use strict';
/** Outbound HTTP with SSRF protection (admin-configured gateway/supplier URLs must not reach internal networks). */
const dns = require('node:dns').promises;
const net = require('node:net');
const { HttpError } = require('../lib');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.') || l.startsWith('::ffff:169.254.');
  }
  return true;
}

function createNet(cfg) {
  async function assertSafeUrl(raw) {
    let u;
    try { u = new URL(raw); } catch { throw new HttpError(400, 'Invalid URL', 'bad_url'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'Only http(s) URLs are allowed', 'bad_url');
    if (u.username || u.password) throw new HttpError(400, 'URL must not contain credentials', 'bad_url');
    if (cfg.allowPrivateUrls) return u;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new HttpError(400, 'Private/internal hosts are blocked', 'ssrf_blocked');
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new HttpError(502, `Cannot resolve host ${host}`, 'dns_failed'); });
    if (addrs.some((a) => isPrivateIp(a.address))) throw new HttpError(400, 'Private/internal addresses are blocked', 'ssrf_blocked');
    return u;
  }

  /** Returns { status, ok, text, json, ms }. Never throws for HTTP status codes, only for network/URL problems. */
  async function safeFetch(url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
    let cur = url; const t0 = Date.now();
    for (let i = 0; i < 4; i++) {
      await assertSafeUrl(cur);
      let res;
      try { res = await fetch(cur, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }); }
      catch (e) { throw new HttpError(502, e.name === 'TimeoutError' ? 'Remote server timed out' : 'Could not connect to remote server', 'upstream_unreachable'); }
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) { cur = new URL(res.headers.get('location'), cur).toString(); if ([301, 302, 303].includes(res.status)) { method = 'GET'; body = undefined; } continue; }
      const buf = Buffer.from(await res.arrayBuffer()).subarray(0, 1024 * 1024);
      const text = buf.toString('utf8');
      let json = null; try { json = JSON.parse(text); } catch {}
      return { status: res.status, ok: res.ok, text, json, ms: Date.now() - t0 };
    }
    throw new HttpError(502, 'Too many redirects', 'upstream_redirects');
  }
  return { safeFetch, assertSafeUrl };
}

module.exports = { createNet, isPrivateIp };
