'use strict';
/** Wallet + ledger. Every balance change goes through a transaction and writes a ledger record. */
const { round2, now, pushKey, HttpError } = require('../lib');

const CREDIT_TYPES = new Set(['Deposit', 'Refund', 'Commission', 'SubSeller_Refund']);

function createWallet({ db }) {
  /** Writes the ledger entry to users/{uid}/transactions/{id} (existing path) and transactions/{id} (global index). */
  async function ledger(uid, e) {
    const id = pushKey();
    const rec = {
      uid, username: e.username || '', type: e.type, direction: CREDIT_TYPES.has(e.type) ? 'in' : 'out', amount: round2(e.amount),
      description: e.description || '', source: e.source || 'system', ts: now(), date: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      balanceAfter: e.balanceAfter === undefined ? null : round2(e.balanceAfter),
      orderId: e.orderId || null, paymentId: e.paymentId || null, ref: e.ref || null, by: e.by || null,
    };
    await db.update('', { [`users/${uid}/transactions/${id}`]: rec, [`transactions/${id}`]: rec });
    return id;
  }

  async function credit(uid, amount, entry) {
    amount = round2(amount);
    if (!(amount > 0)) throw new HttpError(400, 'Invalid amount', 'bad_amount');
    const r = await db.transaction(`users/${uid}/balance`, (c) => round2((Number(c) || 0) + amount));
    if (!r.committed) throw new HttpError(500, 'Balance update failed', 'wallet_failed');
    const user = await db.get(`users/${uid}/username`);
    const txId = await ledger(uid, { ...entry, amount, balanceAfter: r.value, username: user });
    return { balance: r.value, txId };
  }

  /** Atomic debit - aborts (committed=false) when funds are insufficient. */
  async function debit(uid, amount, entry) {
    amount = round2(amount);
    if (!(amount > 0)) throw new HttpError(400, 'Invalid amount', 'bad_amount');
    const r = await db.transaction(`users/${uid}/balance`, (c) => { const cur = Number(c) || 0; return cur + 1e-9 < amount ? undefined : round2(cur - amount); });
    if (!r.committed) return { ok: false, balance: Number(r.value) || 0 };
    const user = await db.get(`users/${uid}/username`);
    const txId = await ledger(uid, { ...entry, amount, balanceAfter: r.value, username: user });
    return { ok: true, balance: r.value, txId };
  }

  return { ledger, credit, debit };
}

module.exports = { createWallet, CREDIT_TYPES };
