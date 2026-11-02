import { pool, withTx, type Tx } from '../db.js';
import { config } from '../config.js';
import { addDays } from '../clock.js';
import { SYSTEM } from '../auth.js';
import { audit, emit } from '../audit.js';
import { post, receivableAsOf, sumPeriod } from '../ledger.js';
import { applyDelta, lockAccount, toAccount, type Account } from './accounts.js';
import { expireAuthorizations } from './spending.js';

const DAYS_PER_YEAR = 365;
const BPS = 10_000;

/**
 * One day of interest on principal, in exact integer math.
 *   interest = principal * apr / 365, tracked as a numerator carried in `interest_remainder`
 *   (units: cent-bps / (10000*365)) so no sub-cent amount is ever lost or invented.
 * Only principal accrues interest (no interest-on-interest, no interest on fees).
 */
export function dailyInterest(principalCents: number, aprBps: number, remainder: number): { cents: number; remainder: number } {
  const denom = BPS * DAYS_PER_YEAR;
  const num = remainder + principalCents * aprBps;
  return { cents: Math.floor(num / denom), remainder: num % denom };
}

async function accrue(tx: Tx, a: Account, date: string): Promise<Account> {
  const { cents, remainder } = dailyInterest(a.principalCents, a.aprBps, a.interestRemainder);
  if (cents > 0) {
    await post(tx, {
      accountId: a.id,
      type: 'INTEREST',
      effectiveDate: date,
      entries: [
        { account: 'receivable_interest', dir: 'D', cents },
        { account: 'interest_income', dir: 'C', cents },
      ],
    });
  }
  const next = await applyDelta(tx, a.id, { interest: cents, remainder: remainder - a.interestRemainder });
  await tx.query('UPDATE accounts SET last_accrual_date=$2 WHERE id=$1', [a.id, date]);
  return { ...next, lastAccrualDate: date };
}

export const minimumDue = (closing: number): number =>
  closing === 0 ? 0 : Math.min(closing, Math.max(config.minPaymentFloorCents, Math.ceil((closing * config.minPaymentPctBps) / BPS)));

/** Closes a billing cycle: totals come from the ledger, not from mutable counters. */
async function issueStatement(tx: Tx, a: Account, periodEnd: string): Promise<Account> {
  const prev = await tx.query('SELECT period_end FROM statements WHERE account_id=$1 ORDER BY period_end DESC LIMIT 1', [a.id]);
  const start = prev.rows[0] ? addDays(prev.rows[0].period_end, 1) : addDays(periodEnd, -config.cycleDays);
  const opening = await receivableAsOf(tx, a.id, addDays(start, -1));
  const closing = await receivableAsOf(tx, a.id, periodEnd);
  const purchases = await sumPeriod(tx, a.id, start, periodEnd, 'receivable_principal', 'D', 'CAPTURE');
  const repayments = await sumPeriod(tx, a.id, start, periodEnd, 'cash', 'D', 'REPAYMENT');
  const interest = await sumPeriod(tx, a.id, start, periodEnd, 'receivable_interest', 'D');
  const fees = await sumPeriod(tx, a.id, start, periodEnd, 'receivable_fees', 'D');
  const min = minimumDue(closing);
  const r = await tx.query(
    `INSERT INTO statements(account_id, period_start, period_end, opening_cents, purchases_cents, repayments_cents,
       interest_cents, fees_cents, closing_cents, minimum_due_cents, due_date, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      a.id,
      start,
      periodEnd,
      opening,
      purchases,
      repayments,
      interest,
      fees,
      closing,
      min,
      addDays(periodEnd, config.graceDays),
      min === 0 ? 'SETTLED' : 'OPEN',
    ],
  );
  const nextDate = addDays(periodEnd, config.cycleDays);
  await tx.query('UPDATE accounts SET next_statement_date=$2 WHERE id=$1', [a.id, nextDate]);
  await audit(tx, {
    accountId: a.id,
    actor: SYSTEM,
    action: 'STATEMENT_ISSUED',
    details: { statementId: r.rows[0].id, periodEnd, closing, minimumDue: min },
  });
  await emit(tx, 'statement.issued', { accountId: a.id, statementId: r.rows[0].id, closingCents: closing, minimumDueCents: min });
  return { ...a, nextStatementDate: nextDate };
}

/**
 * Late-fee rule: if payments received in (period_end, due_date] are below the minimum due,
 * charge ONE late fee for that statement and mark it OVERDUE. A later payment that reaches the
 * minimum cures the status (the fee stays). Runs once per day per account, so a statement
 * can only be fee'd once (status leaves OPEN in the same transaction).
 */
async function assessLateFees(tx: Tx, a: Account, date: string): Promise<Account> {
  let acct = a;
  const { rows } = await tx.query(`SELECT * FROM statements WHERE account_id=$1 AND status IN ('OPEN','OVERDUE') ORDER BY period_end`, [
    a.id,
  ]);
  for (const s of rows) {
    const paidByDue = await sumPeriod(tx, a.id, addDays(s.period_end, 1), s.due_date, 'cash', 'D', 'REPAYMENT');
    if (s.status === 'OPEN' && s.due_date < date) {
      if (paidByDue >= s.minimum_due_cents) {
        await tx.query(`UPDATE statements SET status='SETTLED' WHERE id=$1`, [s.id]);
        continue;
      }
      const fee = config.lateFeeCents;
      await post(tx, {
        accountId: a.id,
        type: 'LATE_FEE',
        effectiveDate: date,
        refType: 'statement',
        refId: s.id,
        entries: [
          { account: 'receivable_fees', dir: 'D', cents: fee },
          { account: 'fee_income', dir: 'C', cents: fee },
        ],
      });
      acct = await applyDelta(tx, a.id, { fees: fee });
      await tx.query(`UPDATE statements SET status='OVERDUE', late_fee_cents=$2 WHERE id=$1`, [s.id, fee]);
      await audit(tx, {
        accountId: a.id,
        actor: SYSTEM,
        action: 'LATE_FEE_ASSESSED',
        details: { statementId: s.id, feeCents: fee, paidCents: paidByDue, minimumDueCents: s.minimum_due_cents },
      });
      await emit(tx, 'late_fee.assessed', { accountId: a.id, statementId: s.id, feeCents: fee });
    } else if (s.status === 'OVERDUE') {
      const paid = await sumPeriod(tx, a.id, addDays(s.period_end, 1), date, 'cash', 'D', 'REPAYMENT');
      if (paid >= s.minimum_due_cents) await tx.query(`UPDATE statements SET status='SETTLED' WHERE id=$1`, [s.id]);
    }
  }
  return { ...acct, lastAccrualDate: a.lastAccrualDate };
}

/** Advances one account to `asOf`, day by day and in a fixed order: accrue, statement, late fees. */
export async function processAccount(tx: Tx, accountId: string, asOf: string): Promise<void> {
  let a = await lockAccount(tx, accountId);
  if ((a.status !== 'ACTIVE' && a.status !== 'FROZEN') || !a.lastAccrualDate) return;
  await expireAuthorizations(tx, accountId, asOf);
  for (let d = addDays(a.lastAccrualDate, 1); d <= asOf; d = addDays(d, 1)) {
    a = await accrue(tx, a, d);
    if (a.nextStatementDate === d) a = await issueStatement(tx, a, d);
    a = await assessLateFees(tx, a, d);
  }
}

/**
 * Daily batch. Each account is its own transaction: one failure never blocks the others, and
 * re-running is safe (progress is tracked by last_accrual_date and statement uniqueness).
 * Caveat: interest uses the principal at run time, so the job must run daily to be exact.
 */
export async function runDaily(asOf: string): Promise<{ processed: number; failed: string[] }> {
  const { rows } = await pool.query(
    `SELECT id FROM accounts WHERE status IN ('ACTIVE','FROZEN') AND last_accrual_date IS NOT NULL ORDER BY id`,
  );
  const failed: string[] = [];
  for (const r of rows) {
    try {
      await withTx((tx) => processAccount(tx, r.id, asOf));
    } catch (e) {
      failed.push(r.id);
      console.error(JSON.stringify({ level: 'error', msg: 'daily job failed for account', accountId: r.id, err: String(e) }));
    }
  }
  return { processed: rows.length - failed.length, failed };
}

export async function listStatements(tx: Tx, accountId: string) {
  const { rows } = await tx.query('SELECT * FROM statements WHERE account_id=$1 ORDER BY period_end DESC', [accountId]);
  return rows.map((s) => ({
    id: s.id,
    periodStart: s.period_start,
    periodEnd: s.period_end,
    openingCents: s.opening_cents,
    purchasesCents: s.purchases_cents,
    repaymentsCents: s.repayments_cents,
    interestCents: s.interest_cents,
    feesCents: s.fees_cents,
    closingCents: s.closing_cents,
    minimumDueCents: s.minimum_due_cents,
    dueDate: s.due_date,
    status: s.status,
    lateFeeCents: s.late_fee_cents,
  }));
}
export { toAccount };
