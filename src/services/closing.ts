import type { Tx } from '../db.js';
import { AppError, invalidState } from '../errors.js';
import type { Actor } from '../auth.js';
import { audit, emit } from '../audit.js';
import { allocate } from '../money.js';
import { post } from '../ledger.js';
import { lockAccount, totalOwedCents, view, toAccount } from './accounts.js';
import { releaseHold } from './spending.js';

/** Zeroes the account in one statement; CHECK closed_is_empty verifies nothing is left behind. */
async function markClosed(tx: Tx, accountId: string) {
  const r = await tx.query(
    `UPDATE accounts SET status='CLOSED', frozen_by=NULL, collateral_cents=0, credit_limit_cents=0,
       principal_cents=0, interest_cents=0, fees_cents=0, held_cents=0, interest_remainder=0,
       closed_at=now(), updated_at=now() WHERE id=$1 RETURNING *`,
    [accountId],
  );
  return toAccount(r.rows[0]);
}

/**
 * Good-standing close: debt must be zero and no holds/deposits in flight.
 * The whole collateral is released back to the customer (ledger: Dr collateral_liability / Cr cash)
 * and a payout request is written to the outbox atomically with the state change.
 */
export async function closeAccount(tx: Tx, actor: Actor, accountId: string, requestId?: string) {
  const a = await lockAccount(tx, accountId, actor);
  if (a.status === 'CLOSED') return { status: 200, body: view(a) };
  if (totalOwedCents(a) > 0) throw invalidState(`outstanding balance of ${totalOwedCents(a)} cents must be repaid first`);
  if (a.heldCents > 0) throw invalidState('pending authorizations must settle or be voided first');
  const pending = await tx.query(`SELECT 1 FROM deposits WHERE account_id=$1 AND status='PENDING' LIMIT 1`, [accountId]);
  if (pending.rowCount) throw invalidState('a deposit is still pending');

  const release = a.collateralCents;
  if (release > 0) {
    await post(tx, {
      accountId,
      type: 'COLLATERAL_RELEASE',
      entries: [
        { account: 'collateral_liability', dir: 'D', cents: release },
        { account: 'cash', dir: 'C', cents: release },
      ],
    });
    await emit(tx, 'payout.requested', { accountId, customerId: a.customerId, amountCents: release });
  }
  const closed = await markClosed(tx, accountId);
  await audit(tx, { accountId, actor, action: 'ACCOUNT_CLOSED', requestId, details: { releasedCents: release } });
  return { status: 200, body: { account: view(closed), releasedCents: release } };
}

/**
 * Delinquent close (ops only): apply collateral to the unpaid debt (fees -> interest -> principal),
 * write off any shortfall (debt beyond collateral, i.e. accrued interest/fees), release the remainder.
 */
export async function liquidateAccount(tx: Tx, actor: Actor, accountId: string, requestId?: string) {
  const a = await lockAccount(tx, accountId, actor);
  if (a.status !== 'ACTIVE' && a.status !== 'FROZEN') throw invalidState(`cannot liquidate an account in status ${a.status}`);
  const overdue = await tx.query(`SELECT 1 FROM statements WHERE account_id=$1 AND status='OVERDUE' LIMIT 1`, [accountId]);
  if (!overdue.rowCount) throw new AppError(409, 'NOT_DELINQUENT', 'account has no overdue statement');

  // Void open holds first so no purchase can clear after the collateral is gone.
  const holds = await tx.query(`SELECT id, amount_cents FROM authorizations WHERE account_id=$1 AND status='AUTHORIZED' FOR UPDATE`, [
    accountId,
  ]);
  for (const h of holds.rows) await releaseHold(tx, accountId, h, 'VOIDED');

  const debt = { fees: a.feesCents, interest: a.interestCents, principal: a.principalCents };
  const owed = totalOwedCents(a);
  const applied = Math.min(owed, a.collateralCents);
  const fromCollateral = allocate(debt, applied);
  const shortfall = {
    fees: debt.fees - fromCollateral.fees,
    interest: debt.interest - fromCollateral.interest,
    principal: debt.principal - fromCollateral.principal,
  };
  const writeOff = shortfall.fees + shortfall.interest + shortfall.principal;
  const release = a.collateralCents - applied;

  if (applied > 0) {
    await post(tx, {
      accountId,
      type: 'COLLATERAL_APPLIED',
      entries: [
        { account: 'collateral_liability', dir: 'D', cents: applied },
        { account: 'receivable_fees', dir: 'C', cents: fromCollateral.fees },
        { account: 'receivable_interest', dir: 'C', cents: fromCollateral.interest },
        { account: 'receivable_principal', dir: 'C', cents: fromCollateral.principal },
      ],
    });
  }
  if (writeOff > 0) {
    await post(tx, {
      accountId,
      type: 'WRITE_OFF',
      entries: [
        { account: 'bad_debt_expense', dir: 'D', cents: writeOff },
        { account: 'receivable_fees', dir: 'C', cents: shortfall.fees },
        { account: 'receivable_interest', dir: 'C', cents: shortfall.interest },
        { account: 'receivable_principal', dir: 'C', cents: shortfall.principal },
      ],
    });
  }
  if (release > 0) {
    await post(tx, {
      accountId,
      type: 'COLLATERAL_RELEASE',
      entries: [
        { account: 'collateral_liability', dir: 'D', cents: release },
        { account: 'cash', dir: 'C', cents: release },
      ],
    });
    await emit(tx, 'payout.requested', { accountId, customerId: a.customerId, amountCents: release });
  }
  const closed = await markClosed(tx, accountId);
  await audit(tx, {
    accountId,
    actor,
    action: 'ACCOUNT_LIQUIDATED',
    requestId,
    details: { appliedCents: applied, writtenOffCents: writeOff, releasedCents: release },
  });
  await emit(tx, 'account.liquidated', { accountId, appliedCents: applied, writtenOffCents: writeOff, releasedCents: release });
  return { status: 200, body: { account: view(closed), appliedCents: applied, writtenOffCents: writeOff, releasedCents: release } };
}
