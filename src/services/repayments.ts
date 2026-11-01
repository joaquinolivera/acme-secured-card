import type { Tx } from '../db.js';
import { AppError, invalidState } from '../errors.js';
import type { Actor } from '../auth.js';
import { audit, emit } from '../audit.js';
import { allocate, type Debt } from '../money.js';
import { post } from '../ledger.js';
import { applyDelta, lockAccount, view } from './accounts.js';

const allocationOf = (r: Record<string, any>): Debt => ({ fees: r.fees_cents, interest: r.interest_cents, principal: r.principal_cents });

/**
 * Records a payment whose funds have SETTLED, as reported by the payment processor (or by ops for manual
 * adjustments). The customer cannot assert a repayment: restoring credit requires evidence of received funds,
 * identified by a unique `externalRef`. How the customer initiates the payment (card, ACH, branch) is outside
 * this service; this is the boundary where settled money enters the books.
 *
 * Idempotent by external reference: re-delivery of the same payment returns the original result and changes
 * nothing; the same reference with different details is a conflict. A single payment can therefore never be
 * applied twice, whatever Idempotency-Key (if any) accompanies the retry.
 *
 * Allocation: fees -> interest -> principal. Overpayment is rejected rather than creating an unmodelled
 * customer credit balance (it would have to be refunded by the rail).
 */
export async function repay(tx: Tx, actor: Actor, accountId: string, amountCents: number, externalRef: string, requestId?: string) {
  const a = await lockAccount(tx, accountId, actor);

  const prior = (await tx.query('SELECT * FROM repayments WHERE external_ref = $1', [externalRef])).rows[0];
  if (prior) {
    if (prior.account_id === accountId && prior.amount_cents === amountCents) {
      return { status: 200, body: { repaymentId: prior.id, replayed: true, allocation: allocationOf(prior), account: view(a) } };
    }
    throw new AppError(409, 'DUPLICATE_PAYMENT_REF', 'payment reference already applied with different details');
  }

  if (a.status === 'CLOSED' || a.status === 'PENDING_COLLATERAL') throw invalidState(`nothing to repay on a ${a.status} account`);
  const alloc = allocate({ fees: a.feesCents, interest: a.interestCents, principal: a.principalCents }, amountCents);

  let repaymentId: string;
  try {
    const r = await tx.query(
      `INSERT INTO repayments(account_id, amount_cents, external_ref, fees_cents, interest_cents, principal_cents)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [accountId, amountCents, externalRef, alloc.fees, alloc.interest, alloc.principal],
    );
    repaymentId = r.rows[0].id as string;
  } catch (e) {
    // Same reference arriving concurrently for a DIFFERENT account (same-account races are serialized by the lock).
    if ((e as { code?: string }).code === '23505') throw new AppError(409, 'DUPLICATE_PAYMENT_REF', 'payment reference already applied');
    throw e;
  }

  await post(tx, {
    accountId,
    type: 'REPAYMENT',
    refType: 'repayment',
    refId: repaymentId,
    entries: [
      { account: 'cash', dir: 'D', cents: amountCents },
      { account: 'receivable_fees', dir: 'C', cents: alloc.fees },
      { account: 'receivable_interest', dir: 'C', cents: alloc.interest },
      { account: 'receivable_principal', dir: 'C', cents: alloc.principal },
    ],
    metadata: { allocation: alloc, externalRef },
  });
  const updated = await applyDelta(tx, accountId, { fees: -alloc.fees, interest: -alloc.interest, principal: -alloc.principal });
  await audit(tx, {
    accountId,
    actor,
    action: 'REPAYMENT',
    requestId,
    details: { repaymentId, externalRef, amountCents, allocation: alloc },
  });
  await emit(tx, 'repayment.received', { accountId, repaymentId, amountCents });
  return { status: 200, body: { repaymentId, replayed: false, allocation: alloc, account: view(updated) } };
}
