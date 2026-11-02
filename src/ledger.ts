import type { Tx } from './db.js';
import { clock, toDate } from './clock.js';

export type LedgerAccount =
  | 'cash'
  | 'collateral_liability'
  | 'receivable_principal'
  | 'receivable_interest'
  | 'receivable_fees'
  | 'merchant_payable'
  | 'interest_income'
  | 'fee_income'
  | 'bad_debt_expense';
export type TxnType =
  'DEPOSIT' | 'CAPTURE' | 'REPAYMENT' | 'INTEREST' | 'LATE_FEE' | 'COLLATERAL_APPLIED' | 'WRITE_OFF' | 'COLLATERAL_RELEASE';

export interface Entry {
  account: LedgerAccount;
  dir: 'D' | 'C';
  cents: number;
}

/**
 * Posts one balanced double-entry transaction. Zero-amount lines are dropped.
 * The DB re-checks balance with a deferred constraint trigger at commit.
 */
export async function post(
  tx: Tx,
  p: { accountId: string; type: TxnType; entries: Entry[]; refType?: string; refId?: string; effectiveDate?: string; metadata?: object },
): Promise<string> {
  const entries = p.entries.filter((e) => e.cents !== 0);
  const sum = (d: 'D' | 'C') => entries.filter((e) => e.dir === d).reduce((s, e) => s + e.cents, 0);
  if (entries.length < 2 || entries.some((e) => !Number.isSafeInteger(e.cents) || e.cents < 0) || sum('D') !== sum('C')) {
    throw new Error(`refusing to post unbalanced/invalid ledger transaction (${p.type})`);
  }
  const now = clock.now();
  const date = p.effectiveDate ?? toDate(now);
  const effectiveAt = p.effectiveDate ? new Date(`${p.effectiveDate}T00:00:00Z`) : now;
  const t = await tx.query(
    `INSERT INTO ledger_transactions(account_id, type, ref_type, ref_id, effective_at, effective_date, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [p.accountId, p.type, p.refType ?? null, p.refId ?? null, effectiveAt, date, JSON.stringify(p.metadata ?? {})],
  );
  const id = t.rows[0].id as string;
  await tx.query(
    `INSERT INTO ledger_entries(txn_id, account_id, ledger_account, direction, amount_cents)
     SELECT $1, $2, a, d, c FROM unnest($3::text[], $4::text[], $5::bigint[]) AS u(a, d, c)`,
    [id, p.accountId, entries.map((e) => e.account), entries.map((e) => e.dir), entries.map((e) => e.cents)],
  );
  return id;
}

/** Sum of one ledger account/direction for an account over [from, to] (inclusive, UTC dates). */
export async function sumPeriod(
  tx: Tx,
  accountId: string,
  from: string,
  to: string,
  ledgerAccount: LedgerAccount,
  dir: 'D' | 'C',
  type?: TxnType,
): Promise<number> {
  const r = await tx.query(
    `SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS s FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.txn_id
      WHERE e.account_id = $1 AND e.ledger_account = $2 AND e.direction = $3
        AND t.effective_date BETWEEN $4 AND $5 AND ($6::text IS NULL OR t.type = $6)`,
    [accountId, ledgerAccount, dir, from, to, type ?? null],
  );
  return r.rows[0].s as number;
}

/** Receivable (principal+interest+fees) balance according to the ledger, as of a date. */
export async function receivableAsOf(tx: Tx, accountId: string, date: string): Promise<number> {
  const r = await tx.query(
    `SELECT COALESCE(SUM(CASE e.direction WHEN 'D' THEN e.amount_cents ELSE -e.amount_cents END), 0)::bigint AS b
       FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.txn_id
      WHERE e.account_id = $1 AND e.ledger_account LIKE 'receivable\\_%' AND t.effective_date <= $2`,
    [accountId, date],
  );
  return r.rows[0].b as number;
}
