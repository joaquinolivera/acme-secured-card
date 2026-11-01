import type { Tx } from '../db.js';
import { config } from '../config.js';
import { AppError, invalidState, notFound } from '../errors.js';
import type { Actor } from '../auth.js';
import { audit } from '../audit.js';
import { clock, toDate } from '../clock.js';
import { post } from '../ledger.js';
import { applyDelta, availableCreditCents, lockAccount, view, type Account } from './accounts.js';

const authView = (r: Record<string, any>) => ({
  id: r.id,
  accountId: r.account_id,
  amountCents: r.amount_cents,
  capturedCents: r.captured_cents,
  merchant: r.merchant,
  status: r.status,
  declineReason: r.decline_reason,
  expiresAt: r.expires_at,
});

/**
 * Card-network authorization. Under the account lock we check available credit and place a hold
 * in one atomic step, so two concurrent purchases can never both pass the same headroom.
 * A decline is a normal, recorded outcome (HTTP 402), not an exception.
 */
export async function authorize(tx: Tx, actor: Actor, accountId: string, amountCents: number, merchant: string, requestId?: string) {
  const a = await lockAccount(tx, accountId);
  let reason: string | null = null;
  if (a.status === 'FROZEN') reason = 'ACCOUNT_FROZEN';
  else if (a.status !== 'ACTIVE') reason = 'ACCOUNT_NOT_ACTIVE';
  else if (amountCents > availableCreditCents(a)) reason = 'INSUFFICIENT_CREDIT';

  const expires = new Date(clock.now().getTime() + config.authTtlDays * 86_400_000);
  const r = await tx.query(
    `INSERT INTO authorizations(account_id, amount_cents, merchant, status, decline_reason, expires_at, resolved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [accountId, amountCents, merchant, reason ? 'DECLINED' : 'AUTHORIZED', reason, expires, reason ? new Date() : null],
  );
  if (reason) {
    await audit(tx, {
      accountId,
      actor,
      action: 'AUTHORIZATION_DECLINED',
      requestId,
      details: { authorizationId: r.rows[0].id, amountCents, reason },
    });
    return { status: 402, body: authView(r.rows[0]) };
  }
  await applyDelta(tx, accountId, { held: amountCents });
  await audit(tx, {
    accountId,
    actor,
    action: 'AUTHORIZATION_APPROVED',
    requestId,
    details: { authorizationId: r.rows[0].id, amountCents, merchant },
  });
  return { status: 201, body: authView(r.rows[0]) };
}

async function lockAuth(tx: Tx, authId: string): Promise<{ auth: Record<string, any>; account: Account }> {
  const pre = await tx.query('SELECT account_id FROM authorizations WHERE id = $1', [authId]);
  if (!pre.rows[0]) throw notFound('authorization');
  const account = await lockAccount(tx, pre.rows[0].account_id);
  const auth = (await tx.query('SELECT * FROM authorizations WHERE id = $1 FOR UPDATE', [authId])).rows[0];
  return { auth, account };
}

/** Clearing: the hold becomes a debt (principal). Captured amount may be <= the authorized amount. */
export async function capture(tx: Tx, actor: Actor, authId: string, amountCents: number | undefined, requestId?: string) {
  const { auth, account } = await lockAuth(tx, authId);
  if (auth.status !== 'AUTHORIZED') throw invalidState(`authorization is ${auth.status}`);
  const amount = amountCents ?? auth.amount_cents;
  if (amount > auth.amount_cents) throw new AppError(422, 'CAPTURE_EXCEEDS_AUTH', 'capture amount exceeds the authorization');
  if (account.status === 'CLOSED') throw invalidState('account is closed');

  await tx.query(`UPDATE authorizations SET status='CAPTURED', captured_cents=$2, resolved_at=now() WHERE id=$1`, [authId, amount]);
  await applyDelta(tx, account.id, { held: -auth.amount_cents, principal: amount });
  await post(tx, {
    accountId: account.id,
    type: 'CAPTURE',
    refType: 'authorization',
    refId: authId,
    entries: [
      { account: 'receivable_principal', dir: 'D', cents: amount },
      { account: 'merchant_payable', dir: 'C', cents: amount },
    ],
    metadata: { merchant: auth.merchant },
  });
  await audit(tx, {
    accountId: account.id,
    actor,
    action: 'AUTHORIZATION_CAPTURED',
    requestId,
    details: { authorizationId: authId, amountCents: amount },
  });
  return { status: 200, body: authView({ ...auth, status: 'CAPTURED', captured_cents: amount }) };
}

export async function voidAuth(tx: Tx, actor: Actor, authId: string, requestId?: string) {
  const { auth, account } = await lockAuth(tx, authId);
  if (auth.status === 'VOIDED') return { status: 200, body: authView(auth) };
  if (auth.status !== 'AUTHORIZED') throw invalidState(`authorization is ${auth.status}`);
  await releaseHold(tx, account.id, { id: auth.id, amount_cents: auth.amount_cents }, 'VOIDED');
  await audit(tx, { accountId: account.id, actor, action: 'AUTHORIZATION_VOIDED', requestId, details: { authorizationId: authId } });
  return { status: 200, body: authView({ ...auth, status: 'VOIDED' }) };
}

export async function releaseHold(tx: Tx, accountId: string, auth: { id: string; amount_cents: number }, to: 'VOIDED' | 'EXPIRED') {
  await tx.query(`UPDATE authorizations SET status=$2, resolved_at=now() WHERE id=$1`, [auth.id, to]);
  await applyDelta(tx, accountId, { held: -auth.amount_cents });
}

/** Called by the daily job under the account lock: lapsed holds free their credit. */
export async function expireAuthorizations(tx: Tx, accountId: string, asOf: string): Promise<number> {
  const cutoff = asOf === toDate(clock.now()) ? clock.now() : new Date(`${asOf}T23:59:59.999Z`);
  const { rows } = await tx.query(
    `SELECT id, amount_cents FROM authorizations WHERE account_id=$1 AND status='AUTHORIZED' AND expires_at < $2`,
    [accountId, cutoff],
  );
  for (const r of rows) await releaseHold(tx, accountId, r, 'EXPIRED');
  return rows.length;
}

export const getAuthorization = async (tx: Tx, id: string) => {
  const r = await tx.query('SELECT * FROM authorizations WHERE id=$1', [id]);
  if (!r.rows[0]) throw notFound('authorization');
  return authView(r.rows[0]);
};
export { view };
