'use strict';
/** Telegram bot integration. The bot token lives encrypted in the database (telegram_settings) or env - never in the frontend. */
const { encrypt, decrypt, now, esc, randId, rand, HttpError } = require('../lib');

function createTelegram({ db, cfg, log }) {
  const API = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');

  async function settings() {
    const s = (await db.get('telegram_settings')) || {};
    const token = process.env.TELEGRAM_BOT_TOKEN || (s.tokenEnc ? decrypt(s.tokenEnc) : '');
    return { ...s, token };
  }
  async function publicSettings() {
    const s = (await db.get('telegram_settings')) || {};
    return {
      enabled: !!s.enabled, botUsername: s.botUsername || '', adminChatId: s.adminChatId || '', tokenSet: !!(s.tokenEnc || process.env.TELEGRAM_BOT_TOKEN),
      notify: { user: true, order: true, payment: true, admin: true, delivery: true, api: false, ...(s.notify || {}) },
      webhookUrl: s.webhookUrl || '', webhookSet: !!s.webhookSet, status: s.status || 'not_tested', lastError: s.lastError || '',
    };
  }

  async function call(token, method, payload) {
    if (!token) throw new HttpError(400, 'Bot token not configured', 'telegram_not_configured');
    let res, j;
    try {
      res = await fetch(`${API}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}), signal: AbortSignal.timeout(15000) });
      j = await res.json().catch(() => null);
    } catch { throw new HttpError(502, 'Could not reach Telegram', 'telegram_unreachable'); }
    if (!j || !j.ok) throw new HttpError(502, `Telegram: ${(j && j.description) || 'request failed'}`, 'telegram_error');
    return j.result;
  }

  async function send(chatId, html) {
    const s = await settings();
    if (!s.enabled || !s.token || !chatId) return false;
    try { await call(s.token, 'sendMessage', { chat_id: chatId, text: String(html).slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }); return true; }
    catch (e) { log.warn('[telegram] send failed:', e.message); return false; }
  }

  /** kind: user | order | payment | admin | delivery | api. Fire-and-forget safe. */
  async function notify(kind, html, { uid, adminToo = true } = {}) {
    try {
      const s = await settings();
      if (!s.enabled || !s.token) return;
      const flags = { user: true, order: true, payment: true, admin: true, delivery: true, api: false, ...(s.notify || {}) };
      if (!flags[kind] && kind !== 'admin') return;
      if (uid && flags.user) { const chat = await db.get(`users/${uid}/telegramChatId`); if (chat) await send(chat, html); }
      if (adminToo && s.adminChatId && flags[kind]) await send(s.adminChatId, html);
    } catch (e) { log.warn('[telegram] notify failed:', e.message); }
  }

  async function saveSettings(input, by) {
    const cur = (await db.get('telegram_settings')) || {};
    const next = { ...cur, enabled: !!input.enabled, botUsername: String(input.botUsername || '').replace(/^@/, '').slice(0, 64), adminChatId: String(input.adminChatId || '').slice(0, 40), notify: { ...(cur.notify || {}), ...(input.notify || {}) }, updatedAt: now(), updatedBy: by };
    if (input.token) next.tokenEnc = encrypt(String(input.token).trim());
    if (!next.webhookSecret) next.webhookSecret = rand(16).toString('hex');
    await db.set('telegram_settings', next);
    return publicSettings();
  }

  async function test() {
    const s = await settings();
    try {
      const me = await call(s.token, 'getMe');
      await db.update('telegram_settings', { botUsername: me.username || s.botUsername || '', status: 'connected', lastError: '', testedAt: now() });
      let sent = false;
      if (s.adminChatId) { try { await call(s.token, 'sendMessage', { chat_id: s.adminChatId, text: '✅ ARYAN bot connected successfully.' }); sent = true; } catch (e) { return { bot: me.username, adminMessage: false, warning: e.message }; } }
      return { bot: me.username, adminMessage: sent };
    } catch (e) {
      await db.update('telegram_settings', { status: 'error', lastError: e.message, testedAt: now() });
      throw e;
    }
  }

  async function setWebhook(baseUrl) {
    const s = await settings(); const raw = (await db.get('telegram_settings')) || {};
    if (!raw.webhookSecret) throw new HttpError(400, 'Save settings first', 'bad_request');
    if (!/^https:\/\//.test(baseUrl)) throw new HttpError(400, 'Telegram needs a public HTTPS URL (set PUBLIC_URL)', 'https_required');
    const url = `${baseUrl}/webhooks/telegram/${raw.webhookSecret}`;
    await call(s.token, 'setWebhook', { url, secret_token: raw.webhookSecret, allowed_updates: ['message'] });
    await db.update('telegram_settings', { webhookSet: true, webhookUrl: baseUrl + '/webhooks/telegram/•••' });
    return { webhookUrl: baseUrl + '/webhooks/telegram/•••' };
  }

  async function createLinkCode(uid) {
    const code = 'L' + rand(4).toString('hex').toUpperCase();
    await db.set(`telegram_links/${code}`, { uid, exp: now() + 15 * 60 * 1000 });
    const s = await publicSettings();
    return { code, botUsername: s.botUsername, expiresInMin: 15, deepLink: s.botUsername ? `https://t.me/${s.botUsername}?start=${code}` : '' };
  }

  async function handleUpdate(update) {
    const m = update && update.message; if (!m || !m.text || !m.chat) return;
    const chatId = String(m.chat.id); const text = m.text.trim();
    const s = await settings();
    if (text.startsWith('/start')) {
      const code = text.split(/\s+/)[1];
      if (!code) return send(chatId, 'Welcome to <b>ARYAN</b>. Open your panel → Profile → Telegram and use the link button to connect your account.');
      const l = await db.get(`telegram_links/${code}`);
      if (!l || l.exp < now()) return send(chatId, 'This link code expired. Generate a new one from your panel.');
      await db.update('', { [`users/${l.uid}/telegramChatId`]: chatId, [`telegram_links/${code}`]: null });
      const uname = await db.get(`users/${l.uid}/username`);
      return send(chatId, `✅ Connected to <b>@${esc(uname)}</b>. You will now receive order and payment alerts here.`);
    }
    if (text === '/balance' && s.notify && s.notify.api !== false) {
      const users = await db.queryEq('users', 'telegramChatId', chatId); const uid = Object.keys(users)[0];
      if (!uid) return send(chatId, 'Account not linked.');
      return send(chatId, `💰 Balance: <b>₹${Number(users[uid].balance || 0).toFixed(2)}</b>`);
    }
  }

  return { settings, publicSettings, saveSettings, test, setWebhook, send, notify, createLinkCode, handleUpdate };
}

module.exports = { createTelegram };
