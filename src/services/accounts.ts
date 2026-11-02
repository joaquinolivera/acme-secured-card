import type { Tx } from '../db.js';
import { config } from '../config.js';
import { AppError, invalidState, notFound } from '../errors.js';
import type { Actor } from '../auth.js';
import { audit, emit } from '../audit.js';
import { toDate, clock } from '../clock.js';
import { addDays } from '../clock.js';

export type Status = 'PENDING_COLLATERAL' | 'ACTIVE' | 'FROZEN' | 'CLOSED';

export interface Account {
  id: string;
  customerId: string;
  status: Status;
  frozenBy: string | null;
  aprBps: number;
  collateralCents: number;
  creditLimitCents: number;
  principalCents: number;
  interestCents: number;
  feesCents: number;
  heldCents: number;
  interestRemainder: number;
  lastAccrualDate: string | null;
  nextStatementDate: string | null;
}

export function toAccount(r: Record<string, any>): Account {
  return {
    id: r.id,
    customerId: r.customer_id,
    status: r.status,
    frozenBy: r.frozen_by,
    aprBps: r.apr_bps,
    collateralCents: r.collateral_cents,
    creditLimitCents: r.credit_limit_cents,
    principalCents: r.principal_cents,
    interestCents: r.interest_cents,
    feesCents: r.fees_cents,
    heldCents: r.held_cents,
    interestRemainder: r.interest_remainder,
    lastAccrualDate: r.last_accrual_date,
    nextStatementDate: r.next_statement_date,
  };
}

export const totalOwedCents = (a: Account): number => a.principalCents + a.interestCents + a.feesCents;
export const availableCreditCents = (a: Account): number => Math.max(0, a.creditLimitCents - totalOwedCents(a) - a.heldCents);

export function view(a: Account) {
  return {
    id: a.id,
    customerId: a.customerId,
    status: a.status,
    currency: 'USD',
    aprBps: a.aprBps,
    collateralCents: a.collateralCents,
    creditLimitCents: a.creditLimitCents,
    principalCents: a.principalCents,
    interestCents: a.interestCents,
    feesCents: a.feesCents,
    totalOwedCents: totalOwedCents(a),
    heldCents: a.heldCents,
    availableCreditCents: availableCreditCents(a),
    nextStatementDate: a.nextStatementDate,
  };
}

/** Customers only see their own accounts; anything else is a 404 (no existence oracle). */
export function assertAccess(actor: Actor, a: Account): void {
  if (actor.role === 'customer' && a.customerId !== actor.sub) throw notFound('account');
}

/**
 * Takes the per-account row lock. This is THE concurrency primitive: every operation that
 * changes money for an account serializes here, so check-then-update is race-free.
 */
export async function lockAccount(tx: Tx, id: string, actor?: Actor): Promise<Account> {
  const r = await tx.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rows[0]) throw notFound('account');
  const a = toAccount(r.rows[0]);
  if (actor) assertAccess(actor, a);
  return a;
}

export interface Delta {
  collateral?: number;
  limit?: number;
  principal?: number;
  interest?: number;
  fees?: number;
  held?: number;
  remainder?: number;
}

/** Relative update; the CHECK constraints are the last line of defence against a logic bug. */
export async function applyDelta(tx: Tx, id: string, d: Delta): Promise<Account> {
  const r = await tx.query(
    `UPDATE accounts SET collateral_cents = collateral_cents + $2, credit_limit_cents = credit_limit_cents + $3,
       principal_cents = principal_cents + $4, interest_cents = interest_cents + $5, fees_cents = fees_cents + $6,
       held_cents = held_cents + $7, interest_remainder = interest_remainder + $8, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, d.collateral ?? 0, d.limit ?? 0, d.principal ?? 0, d.interest ?? 0, d.fees ?? 0, d.held ?? 0, d.remainder ?? 0],
  );
  return toAccount(r.rows[0]);
}

export async function createAccount(tx: Tx, actor: Actor, customerId: string, requestId?: string) {
  let row;
  try {
    row = (await tx.query('INSERT INTO accounts(customer_id, apr_bps) VALUES ($1,$2) RETURNING *', [customerId, config.aprBps])).rows[0];
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new AppError(409, 'ACCOUNT_EXISTS', 'customer already has an open account');
    throw e;
  }
  const a = toAccount(row);
  await audit(tx, { accountId: a.id, actor, action: 'ACCOUNT_CREATED', requestId, details: { customerId } });
  return { status: 201, body: view(a) };
}

export async function getAccount(tx: Tx, actor: Actor, id: string) {
  const r = await tx.query('SELECT * FROM accounts WHERE id = $1', [id]);
  if (!r.rows[0]) throw notFound('account');
  const a = toAccount(r.rows[0]);
  assertAccess(actor, a);
  return a;
}

export async function setFrozen(tx: Tx, actor: Actor, id: string, freeze: boolean, requestId?: string) {
  const a = await lockAccount(tx, id, actor);
  const by = actor.role === 'customer' ? 'customer' : 'ops';
  if (freeze) {
    if (a.status === 'FROZEN') return { status: 200, body: view(a) }; // already frozen: idempotent no-op
    if (a.status !== 'ACTIVE') throw invalidState(`cannot freeze an account in status ${a.status}`);
    await tx.query(`UPDATE accounts SET status='FROZEN', frozen_by=$2, updated_at=now() WHERE id=$1`, [id, by]);
  } else {
    if (a.status !== 'FROZEN') throw invalidState('account is not frozen');
    // A freeze placed by ops (e.g. fraud) can only be lifted by ops.
    if (a.frozenBy === 'ops' && actor.role !== 'ops')
      throw new AppError(403, 'FORBIDDEN', 'freeze placed by ops can only be lifted by ops');
    await tx.query(`UPDATE accounts SET status='ACTIVE', frozen_by=NULL, updated_at=now() WHERE id=$1`, [id]);
  }
  await audit(tx, { accountId: id, actor, action: freeze ? 'ACCOUNT_FROZEN' : 'ACCOUNT_UNFROZEN', requestId });
  await emit(tx, freeze ? 'account.frozen' : 'account.unfrozen', { accountId: id, by });
  return { status: 200, body: view(await getAccount(tx, actor, id)) };
}

/** Limit = floor(collateral * ratio). Activation happens when confirmed collateral reaches the minimum. */
export function limitFor(collateralCents: number): number {
  return Math.floor((collateralCents * config.limitRatioBps) / 10_000);
}

export function activationDates() {
  const today = toDate(clock.now());
  return { today, next: addDays(today, config.cycleDays) };
}
