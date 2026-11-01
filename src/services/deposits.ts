import type { Tx } from '../db.js';
import { AppError, invalidState, notFound } from '../errors.js';
import type { Actor } from '../auth.js';
import { audit, emit } from '../audit.js';
import { post } from '../ledger.js';
import { activationDates, applyDelta, limitFor, lockAccount, toAccount, view } from './accounts.js';
import { config } from '../config.js';

const depositView = (r: Record<string, any>) => ({
  id: r.id,
  accountId: r.account_id,
  amountCents: r.amount_cents,
  status: r.status,
  externalRef: r.external_ref,
});

/** Customer announces a deposit. Nothing is credited until the payment processor confirms funds. */
export async function requestDeposit(tx: Tx, actor: Actor, accountId: string, amountCents: number, requestId?: string) {
  const a = await lockAccount(tx, accountId, actor);
  if (a.status === 'CLOSED') throw invalidState('account is closed');
  const r = await tx.query('INSERT INTO deposits(account_id, amount_cents) VALUES ($1,$2) RETURNING *', [accountId, amountCents]);
  await audit(tx, { accountId, actor, action: 'DEPOSIT_REQUESTED', requestId, details: { depositId: r.rows[0].id, amountCents } });
  return { status: 201, body: { ...depositView(r.rows[0]), paymentReference: r.rows[0].id } };
}

/**
 * Processor webhook: funds received. Idempotent by state: re-delivery of the same
 * confirmation returns the already-confirmed deposit without posting twice.
 * On success: ledger Dr cash / Cr collateral_liability, collateral and limit grow,
 * and the card activates once confirmed collateral >= minimum.
 */
export async function confirmDeposit(
  tx: Tx,
  actor: Actor,
  depositId: string,
  externalRef: string,
  amountCents: number,
  requestId?: string,
) {
  const pre = await tx.query('SELECT account_id FROM deposits WHERE id = $1', [depositId]);
  if (!pre.rows[0]) throw notFound('deposit');
  const accountId = pre.rows[0].account_id as string;
  const acct = await lockAccount(tx, accountId); // lock first, then read the deposit under the lock
  const d = (await tx.query('SELECT * FROM deposits WHERE id = $1 FOR UPDATE', [depositId])).rows[0];

  if (d.status === 'CONFIRMED') {
    if (d.external_ref === externalRef && d.amount_cents === amountCents) return { status: 200, body: depositView(d) };
    throw invalidState('deposit already confirmed with different details');
  }
  if (d.status === 'FAILED') throw invalidState('deposit already failed');
  if (d.amount_cents !== amountCents) throw new AppError(422, 'AMOUNT_MISMATCH', 'confirmed amount differs from the requested deposit');
  if (acct.status === 'CLOSED') throw invalidState('account is closed; funds must be refunded by ops');

  try {
    await tx.query(`UPDATE deposits SET status='CONFIRMED', external_ref=$2, resolved_at=now() WHERE id=$1`, [depositId, externalRef]);
  } catch (e) {
    if ((e as { code?: string }).code === '23505')
      throw new AppError(409, 'DUPLICATE_PAYMENT_REF', 'payment reference already used for another deposit');
    throw e;
  }
  await post(tx, {
    accountId,
    type: 'DEPOSIT',
    refType: 'deposit',
    refId: depositId,
    entries: [
      { account: 'cash', dir: 'D', cents: amountCents },
      { account: 'collateral_liability', dir: 'C', cents: amountCents },
    ],
  });

  const collateral = acct.collateralCents + amountCents;
  const activating = acct.status === 'PENDING_COLLATERAL' && collateral >= config.minCollateralCents;
  const hasLimit = activating || acct.status === 'ACTIVE' || acct.status === 'FROZEN';
  const newLimit = hasLimit ? limitFor(collateral) : 0;
  await applyDelta(tx, accountId, { collateral: amountCents, limit: newLimit - acct.creditLimitCents });
  if (activating) {
    const { today, next } = activationDates();
    await tx.query(`UPDATE accounts SET status='ACTIVE', activated_at=now(), last_accrual_date=$2, next_statement_date=$3 WHERE id=$1`, [
      accountId,
      today,
      next,
    ]);
    await emit(tx, 'card.activated', { accountId, creditLimitCents: newLimit });
  }
  await audit(tx, {
    accountId,
    actor,
    action: 'DEPOSIT_CONFIRMED',
    requestId,
    details: { depositId, externalRef, amountCents, newLimit, activated: activating },
  });
  await emit(tx, 'deposit.confirmed', { accountId, depositId, amountCents });
  const after = (await tx.query('SELECT * FROM accounts WHERE id=$1', [accountId])).rows[0];
  return {
    status: 200,
    body: { deposit: depositView({ ...d, status: 'CONFIRMED', external_ref: externalRef }), account: view(toAccount(after)) },
  };
}

export async function failDeposit(tx: Tx, actor: Actor, depositId: string, requestId?: string) {
  const pre = await tx.query('SELECT account_id FROM deposits WHERE id = $1', [depositId]);
  if (!pre.rows[0]) throw notFound('deposit');
  await lockAccount(tx, pre.rows[0].account_id);
  const d = (await tx.query('SELECT * FROM deposits WHERE id = $1 FOR UPDATE', [depositId])).rows[0];
  if (d.status === 'FAILED') return { status: 200, body: depositView(d) };
  if (d.status === 'CONFIRMED') throw invalidState('deposit already confirmed');
  await tx.query(`UPDATE deposits SET status='FAILED', resolved_at=now() WHERE id=$1`, [depositId]);
  await audit(tx, { accountId: d.account_id, actor, action: 'DEPOSIT_FAILED', requestId, details: { depositId } });
  return { status: 200, body: depositView({ ...d, status: 'FAILED' }) };
}
