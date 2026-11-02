import { pool } from './db.js';
import { verifyAuditChain } from './audit.js';

export interface Discrepancy {
  accountId?: string;
  check: string;
  expected: number;
  actual: number;
}

/**
 * Independent verification that denormalized balances equal what the immutable ledger says,
 * that held credit equals open authorizations, and that the books balance globally.
 * Run it on a schedule and alert on any non-empty result.
 */
export async function reconcile(): Promise<{ ok: boolean; discrepancies: Discrepancy[]; accountsChecked: number }> {
  const out: Discrepancy[] = [];
  const g = await pool.query(
    `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE direction='D'),0)::bigint AS d, COALESCE(SUM(amount_cents) FILTER (WHERE direction='C'),0)::bigint AS c FROM ledger_entries`,
  );
  if (g.rows[0].d !== g.rows[0].c) out.push({ check: 'global_trial_balance', expected: g.rows[0].d, actual: g.rows[0].c });

  const { rows } = await pool.query(`
    SELECT a.id, a.collateral_cents, a.principal_cents, a.interest_cents, a.fees_cents, a.held_cents,
      COALESCE(SUM(CASE e.direction WHEN 'C' THEN e.amount_cents ELSE -e.amount_cents END) FILTER (WHERE e.ledger_account='collateral_liability'),0)::bigint AS l_coll,
      COALESCE(SUM(CASE e.direction WHEN 'D' THEN e.amount_cents ELSE -e.amount_cents END) FILTER (WHERE e.ledger_account='receivable_principal'),0)::bigint AS l_prin,
      COALESCE(SUM(CASE e.direction WHEN 'D' THEN e.amount_cents ELSE -e.amount_cents END) FILTER (WHERE e.ledger_account='receivable_interest'),0)::bigint AS l_int,
      COALESCE(SUM(CASE e.direction WHEN 'D' THEN e.amount_cents ELSE -e.amount_cents END) FILTER (WHERE e.ledger_account='receivable_fees'),0)::bigint AS l_fees,
      (SELECT COALESCE(SUM(amount_cents),0)::bigint FROM authorizations x WHERE x.account_id=a.id AND x.status='AUTHORIZED') AS open_holds
    FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id GROUP BY a.id`);
  for (const r of rows) {
    const cmp = (check: string, expected: number, actual: number) => {
      if (expected !== actual) out.push({ accountId: r.id, check, expected, actual });
    };
    cmp('collateral_vs_ledger', r.l_coll, r.collateral_cents);
    cmp('principal_vs_ledger', r.l_prin, r.principal_cents);
    cmp('interest_vs_ledger', r.l_int, r.interest_cents);
    cmp('fees_vs_ledger', r.l_fees, r.fees_cents);
    cmp('held_vs_open_authorizations', r.open_holds, r.held_cents);
  }
  const client = await pool.connect();
  try {
    for (const r of rows) {
      const broken = await verifyAuditChain(client, r.id);
      if (broken !== null) out.push({ accountId: r.id, check: 'audit_chain_broken_at_seq', expected: 0, actual: broken });
    }
  } finally {
    client.release();
  }
  return { ok: out.length === 0, discrepancies: out, accountsChecked: rows.length };
}
