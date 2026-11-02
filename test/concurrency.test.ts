import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/db.js';
import { call, fundedAccount, getAcct, setup, teardown, auth, reconcileOk, realClock, repay } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  realClock();
  app = await setup();
});
afterAll(() => teardown(app));

describe('concurrency', () => {
  it('40 simultaneous $50 purchases against a $1,000 limit: exactly 20 approved, never over the limit', async () => {
    const { id, cust } = await fundedAccount(app, 100_000);
    const results = await Promise.all(Array.from({ length: 40 }, () => auth(app, id, 5_000)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(20);
    expect(results.filter((r) => r.status === 402)).toHaveLength(20);
    expect(await getAcct(app, id, cust)).toMatchObject({ heldCents: 100_000, availableCreditCents: 0 });
    await reconcileOk(app);
  });

  it('simultaneous purchases + repayments + captures keep every invariant', async () => {
    const { id, cust } = await fundedAccount(app, 100_000);
    const seed = await auth(app, id, 50_000);
    await call(app, 'POST', `/v1/authorizations/${seed.body.id}/capture`, { role: 'processor', body: {} });
    const ops = await Promise.all([
      ...Array.from({ length: 15 }, () => auth(app, id, 7_000)),
      ...Array.from({ length: 10 }, () => repay(app, id, 2_000)),
    ]);
    const acct = await getAcct(app, id, cust);
    const approved = ops.filter((r) => r.status === 201).length;
    const repaid = ops.filter((r) => r.status === 200).length * 2_000;
    expect(acct.principalCents).toBe(50_000 - repaid);
    expect(acct.heldCents).toBe(approved * 7_000);
    expect(acct.principalCents + acct.heldCents).toBeLessThanOrEqual(acct.creditLimitCents);
    await reconcileOk(app);
  });

  it('10 simultaneous retries of one Idempotency-Key produce exactly one effect and identical responses', async () => {
    const { id, cust } = await fundedAccount(app, 100_000);
    const key = `idem-${randomUUID()}`;
    const rs = await Promise.all(Array.from({ length: 10 }, () => auth(app, id, 10_000, key)));
    expect(new Set(rs.map((r) => r.status))).toEqual(new Set([201]));
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(rs.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(9);
    expect((await getAcct(app, id, cust)).heldCents).toBe(10_000);

    // Same key, different payload is a client bug and must not be accepted.
    const bad = await auth(app, id, 20_000, key);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    await reconcileOk(app);
  });

  it('a re-delivered payment (same external reference) is applied exactly once, even in parallel', async () => {
    const { id, cust } = await fundedAccount(app, 50_000);
    const a = await auth(app, id, 20_000);
    await call(app, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', body: {} });
    const ref = `bank-${randomUUID()}`;
    const r = await Promise.all([1, 2, 3, 4, 5].map(() => repay(app, id, 5_000, { ref })));
    expect(r.every((x) => x.status === 200)).toBe(true);
    expect(r.filter((x) => x.body.replayed === false)).toHaveLength(1);
    expect((await getAcct(app, id, cust)).principalCents).toBe(15_000);

    // The same reference can neither be reused with another amount nor for another account...
    expect((await repay(app, id, 4_000, { ref })).status).toBe(409);
    const other = await fundedAccount(app, 30_000);
    expect((await repay(app, other.id, 5_000, { ref })).status).toBe(409);
    // ...while a genuinely different payment of the same amount is a separate, legitimate repayment.
    expect((await repay(app, id, 5_000)).status).toBe(200);
    expect((await getAcct(app, id, cust)).principalCents).toBe(10_000);
    await reconcileOk(app);
  });

  it('one payment reference racing across two accounts is applied to exactly one of them', async () => {
    const indebted = async () => {
      const f = await fundedAccount(app, 50_000);
      const a = await auth(app, f.id, 10_000);
      await call(app, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', body: {} });
      return f;
    };
    const [x, y] = [await indebted(), await indebted()];
    const ref = `bank-${randomUUID()}`;
    const rs = await Promise.all([repay(app, x.id, 5_000, { ref }), repay(app, y.id, 5_000, { ref })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const owed = (await getAcct(app, x.id, x.cust)).principalCents + (await getAcct(app, y.id, y.cust)).principalCents;
    expect(owed).toBe(20_000 - 5_000); // exactly one payment of 5,000 was applied
    await reconcileOk(app);
  });

  it('parallel capture and void of one authorization: one wins, the other is rejected, no double effect', async () => {
    const { id, cust } = await fundedAccount(app, 50_000);
    const a = await auth(app, id, 10_000);
    const [c, v] = await Promise.all([
      call(app, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', body: {} }),
      call(app, 'POST', `/v1/authorizations/${a.body.id}/void`, { role: 'processor', body: {} }),
    ]);
    expect([c.status, v.status].sort()).toEqual([200, 409]);
    const acct = await getAcct(app, id, cust);
    expect(acct.heldCents).toBe(0);
    expect([0, 10_000]).toContain(acct.principalCents);
    await reconcileOk(app);
  });

  it('duplicate deposit confirmation webhooks in parallel credit the collateral once', async () => {
    const cust = `c_${randomUUID()}`;
    const acc = await call(app, 'POST', '/v1/accounts', { role: 'customer', sub: cust, body: {} });
    const dep = await call(app, 'POST', `/v1/accounts/${acc.body.id}/deposits`, {
      role: 'customer',
      sub: cust,
      body: { amountCents: 30_000 },
    });
    const rs = await Promise.all(
      Array.from({ length: 8 }, () =>
        call(app, 'POST', `/v1/webhooks/deposits/${dep.body.id}/confirm`, {
          role: 'processor',
          body: { externalRef: 'pay_same', amountCents: 30_000 },
        }),
      ),
    );
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect((await getAcct(app, acc.body.id, cust)).collateralCents).toBe(30_000);
    await reconcileOk(app);
  });

  it('randomized operation mix keeps ledger == balances (property check)', async () => {
    const { id, cust } = await fundedAccount(app, 200_000);
    let seed = 12345; // deterministic LCG so failures are reproducible
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const open: string[] = [];
    for (let round = 0; round < 6; round++) {
      const batch = Array.from({ length: 12 }, async () => {
        const k = rnd(5);
        const amt = (rnd(40) + 1) * 500;
        if (k <= 1) {
          const r = await auth(app, id, amt);
          if (r.status === 201) open.push(r.body.id);
        } else if (k === 2 && open.length)
          await call(app, 'POST', `/v1/authorizations/${open.pop()}/capture`, { role: 'processor', body: {} });
        else if (k === 3 && open.length) await call(app, 'POST', `/v1/authorizations/${open.pop()}/void`, { role: 'processor', body: {} });
        else await repay(app, id, amt);
      });
      await Promise.all(batch);
      const a = await getAcct(app, id, cust);
      expect(a.principalCents + a.heldCents).toBeLessThanOrEqual(a.creditLimitCents);
      expect(a.availableCreditCents).toBeGreaterThanOrEqual(0);
    }
    await reconcileOk(app);
  });
});

describe('database-level integrity (defence in depth)', () => {
  it('ledger and audit rows cannot be updated, deleted or truncated', async () => {
    const { id } = await fundedAccount(app, 30_000);
    await expect(pool.query('UPDATE ledger_entries SET amount_cents = 1 WHERE account_id = $1', [id])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM ledger_transactions WHERE account_id = $1', [id])).rejects.toThrow(/append-only/);
    await expect(pool.query('UPDATE audit_log SET action = $2 WHERE account_id = $1', [id, 'x'])).rejects.toThrow(/append-only/);
    await expect(pool.query('TRUNCATE ledger_entries CASCADE')).rejects.toThrow(/append-only/);
  });

  it('an unbalanced ledger transaction is refused at commit', async () => {
    const { id } = await fundedAccount(app, 30_000);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const t = await c.query(
        `INSERT INTO ledger_transactions(account_id,type,effective_at,effective_date) VALUES ($1,'DEPOSIT',now(),current_date) RETURNING id`,
        [id],
      );
      await c.query(`INSERT INTO ledger_entries(txn_id,account_id,ledger_account,direction,amount_cents) VALUES ($1,$2,'cash','D',100)`, [
        t.rows[0].id,
        id,
      ]);
      await expect(c.query('COMMIT')).rejects.toThrow(/unbalanced/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('CHECK constraints refuse overspending even if application code were wrong', async () => {
    const { id } = await fundedAccount(app, 30_000);
    await expect(pool.query('UPDATE accounts SET principal_cents = 30001 WHERE id = $1', [id])).rejects.toThrow(/spend_within_limit/);
    await expect(pool.query('UPDATE accounts SET credit_limit_cents = 30001 WHERE id = $1', [id])).rejects.toThrow(
      /limit_within_collateral/,
    );
    await expect(pool.query(`UPDATE accounts SET status='CLOSED' WHERE id = $1`, [id])).rejects.toThrow(/closed_is_empty/);
  });

  it('a card cannot be ACTIVE without confirmed collateral', async () => {
    const acc = await call(app, 'POST', '/v1/accounts', { role: 'customer', sub: `c_${randomUUID()}`, body: {} });
    await expect(pool.query(`UPDATE accounts SET status='ACTIVE' WHERE id = $1`, [acc.body.id])).rejects.toThrow(/active_needs_collateral/);
  });

  it('tampering with the audit trail is detected by the hash chain', async () => {
    const { id } = await fundedAccount(app, 30_000);
    const before = await call(app, 'GET', `/v1/accounts/${id}/audit`, { role: 'ops' });
    expect(before.body.chainIntactUpTo).toBe('all');
    const c = await pool.connect();
    try {
      // a privileged attacker disables the trigger and rewrites history
      await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_immutable');
      await c.query(`UPDATE audit_log SET details = '{"amountCents":1}' WHERE account_id=$1 AND action='DEPOSIT_CONFIRMED'`, [id]);
      await c.query('ALTER TABLE audit_log ENABLE TRIGGER audit_immutable');
    } finally {
      c.release();
    }
    const after = await call(app, 'GET', `/v1/accounts/${id}/audit`, { role: 'ops' });
    expect(after.body.chainIntactUpTo).not.toBe('all');
    const rec = await call(app, 'GET', '/v1/admin/reconcile', { role: 'ops' });
    expect(rec.body.discrepancies.some((d: any) => d.check === 'audit_chain_broken_at_seq')).toBe(true);
  });
});
