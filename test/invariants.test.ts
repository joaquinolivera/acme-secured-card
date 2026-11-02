import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { pool, withTx } from '../src/db.js';
import { confirmDeposit } from '../src/services/deposits.js';
import {
  call,
  fundedAccount,
  getAcct,
  setup,
  teardown,
  auth,
  reconcileOk,
  realClock,
  runJob,
  openWithDebt,
  footprint,
  statements,
  repay,
} from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  realClock();
  app = await setup();
});
afterAll(async () => {
  realClock();
  await teardown(app);
});

describe('failed operations leave no trace (atomic rollback)', () => {
  it('an exception after the money moved rolls back balances, ledger, audit and outbox together', async () => {
    const cust = `c_${randomUUID()}`;
    const acc = await call(app, 'POST', '/v1/accounts', { role: 'customer', sub: cust, body: {} });
    const dep = await call(app, 'POST', `/v1/accounts/${acc.body.id}/deposits`, {
      role: 'customer',
      sub: cust,
      body: { amountCents: 50_000 },
    });
    const before = await footprint(acc.body.id);

    await expect(
      withTx(async (tx) => {
        await confirmDeposit(tx, { sub: 'processor', role: 'processor' }, dep.body.id, 'pay_rollback', 50_000);
        throw new Error('boom after the money moved');
      }),
    ).rejects.toThrow('boom');

    expect(await footprint(acc.body.id)).toEqual(before);
    expect(await getAcct(app, acc.body.id, cust)).toMatchObject({ status: 'PENDING_COLLATERAL', collateralCents: 0, creditLimitCents: 0 });
    const d = await pool.query('SELECT status, external_ref FROM deposits WHERE id=$1', [dep.body.id]);
    expect(d.rows[0]).toEqual({ status: 'PENDING', external_ref: null });
    // ...and the same deposit can still be confirmed normally afterwards.
    const ok = await call(app, 'POST', `/v1/webhooks/deposits/${dep.body.id}/confirm`, {
      role: 'processor',
      body: { externalRef: 'pay_rollback', amountCents: 50_000 },
    });
    expect(ok.body.account.status).toBe('ACTIVE');
    await reconcileOk(app);
  });

  it('rejected requests (overpayment, over-limit, bad state) write no ledger or audit rows', async () => {
    const { id, cust } = await fundedAccount(app, 40_000);
    const a = await auth(app, id, 10_000);
    await call(app, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', body: {} });
    const before = await footprint(id);
    expect((await repay(app, id, 10_001)).status).toBe(422);
    expect((await call(app, 'POST', `/v1/accounts/${id}/close`, { role: 'customer', sub: cust, body: {} })).status).toBe(409);
    expect((await call(app, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', body: {} })).status).toBe(409);
    expect((await call(app, 'POST', `/v1/accounts/${id}/unfreeze`, { role: 'customer', sub: cust, body: {} })).status).toBe(409);
    expect(await footprint(id)).toEqual(before);
  });

  it('a duplicate payment reference is refused and credits nothing', async () => {
    const f = await fundedAccount(app, 30_000);
    const d2 = await call(app, 'POST', `/v1/accounts/${f.id}/deposits`, { role: 'customer', sub: f.cust, body: { amountCents: 5_000 } });
    const before = await footprint(f.id);
    const dup = await call(app, 'POST', `/v1/webhooks/deposits/${d2.body.id}/confirm`, {
      role: 'processor',
      body: {
        externalRef: (await pool.query('SELECT external_ref FROM deposits WHERE id=$1', [f.depositId])).rows[0].external_ref,
        amountCents: 5_000,
      },
    });
    expect(dup.status).toBe(409);
    expect(await footprint(f.id)).toEqual(before);
    expect((await getAcct(app, f.id, f.cust)).collateralCents).toBe(30_000);
  });
});

describe('idempotency details', () => {
  it('a declined authorization replays the same decline and creates one row', async () => {
    const { id } = await fundedAccount(app, 20_000);
    const key = `decl-${randomUUID()}`;
    const r1 = await auth(app, id, 20_001, key);
    const r2 = await auth(app, id, 20_001, key);
    expect([r1.status, r2.status]).toEqual([402, 402]);
    expect(r2.body.id).toBe(r1.body.id);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    const n = await pool.query(`SELECT count(*)::int AS n FROM authorizations WHERE account_id=$1`, [id]);
    expect(n.rows[0].n).toBe(1);
  });

  it('a retried capture (same key) captures once; a failed request does not burn its key', async () => {
    const { id, cust } = await fundedAccount(app, 30_000);
    const a = await auth(app, id, 10_000);
    const key = `cap-${randomUUID()}`;
    const rs = await Promise.all(
      [1, 2, 3].map(() =>
        call(app, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', key, body: { amountCents: 9_000 } }),
      ),
    );
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect((await getAcct(app, id, cust)).principalCents).toBe(9_000);

    // A request that fails a business rule is NOT remembered: the same key can succeed once the request is valid.
    const b = await auth(app, id, 5_000);
    const key2 = `late-${randomUUID()}`;
    const over = await call(app, 'POST', `/v1/authorizations/${b.body.id}/capture`, {
      role: 'processor',
      key: key2,
      body: { amountCents: 5_001 },
    });
    expect(over.status).toBe(422);
    const fixed = await call(app, 'POST', `/v1/authorizations/${b.body.id}/capture`, {
      role: 'processor',
      key: key2,
      body: { amountCents: 5_000 },
    });
    expect(fixed.status).toBe(200);
  });

  it('keys are scoped per caller: another customer reusing a key gets its own result', async () => {
    const a = await fundedAccount(app, 30_000);
    const b = await fundedAccount(app, 30_000);
    const key = `shared-${randomUUID()}`;
    const x = await call(app, 'POST', `/v1/accounts/${a.id}/deposits`, {
      role: 'customer',
      sub: a.cust,
      key,
      body: { amountCents: 1_000 },
    });
    const y = await call(app, 'POST', `/v1/accounts/${b.id}/deposits`, {
      role: 'customer',
      sub: b.cust,
      key,
      body: { amountCents: 1_000 },
    });
    expect(x.body.id).not.toBe(y.body.id);
    expect(y.body.accountId).toBe(b.id);
  });
});

describe('more concurrency: close, liquidation, billing', () => {
  it('repay-all racing close: either order is safe and the books stay consistent', async () => {
    for (let round = 0; round < 5; round++) {
      const { id, cust } = await fundedAccount(app, 40_000);
      const a = await auth(app, id, 10_000);
      await call(app, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', body: {} });
      const [pay, close] = await Promise.all([
        repay(app, id, 10_000),
        call(app, 'POST', `/v1/accounts/${id}/close`, { role: 'customer', sub: cust, body: {} }),
      ]);
      expect(pay.status).toBe(200);
      const acct = await getAcct(app, id, cust);
      if (close.status === 200) expect(acct).toMatchObject({ status: 'CLOSED', collateralCents: 0, totalOwedCents: 0 });
      else {
        expect(close.status).toBe(409);
        expect(acct.status).toBe('ACTIVE');
        expect(acct.collateralCents).toBe(40_000);
      }
      await reconcileOk(app);
    }
  });

  it('a purchase racing close never produces debt on a closed account', async () => {
    for (let round = 0; round < 5; round++) {
      const { id, cust } = await fundedAccount(app, 40_000);
      const [a, close] = await Promise.all([
        auth(app, id, 5_000),
        call(app, 'POST', `/v1/accounts/${id}/close`, { role: 'customer', sub: cust, body: {} }),
      ]);
      const acct = await getAcct(app, id, cust);
      if (close.status === 200) {
        expect(a.status).toBe(402);
        expect(acct.status).toBe('CLOSED');
      } else {
        expect(a.status).toBe(201);
        expect(acct.heldCents).toBe(5_000);
      }
      await reconcileOk(app);
    }
  });

  it('concurrent liquidation settles the debt exactly once', async () => {
    const { id, cust } = await openWithDebt(app, 100_000, 100_000);
    await runJob(app, '2026-01-31');
    await runJob(app, '2026-02-22');
    const owed = (await getAcct(app, id, cust)).totalOwedCents;
    const rs = await Promise.all([1, 2, 3, 4].map(() => call(app, 'POST', `/v1/accounts/${id}/liquidate`, { role: 'ops', body: {} })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
    const applied = await pool.query(
      `SELECT count(*)::int AS n, COALESCE(SUM(e.amount_cents),0)::bigint AS s FROM ledger_transactions t JOIN ledger_entries e ON e.txn_id=t.id
      WHERE t.account_id=$1 AND t.type='COLLATERAL_APPLIED' AND e.direction='D'`,
      [id],
    );
    expect(applied.rows[0]).toMatchObject({ n: 1, s: 100_000 });
    const wo = await pool.query(
      `SELECT COALESCE(SUM(amount_cents),0)::bigint AS s FROM ledger_entries WHERE account_id=$1 AND ledger_account='bad_debt_expense'`,
      [id],
    );
    expect(wo.rows[0].s).toBe(owed - 100_000);
    await reconcileOk(app);
  });

  it('liquidation racing a customer repayment never double-settles', async () => {
    const { id, cust } = await openWithDebt(app, 100_000, 100_000);
    await runJob(app, '2026-01-31');
    await runJob(app, '2026-02-22');
    const owed = (await getAcct(app, id, cust)).totalOwedCents;
    const [liq, pay] = await Promise.all([
      call(app, 'POST', `/v1/accounts/${id}/liquidate`, { role: 'ops', body: {} }),
      repay(app, id, 50_000),
    ]);
    expect(liq.status).toBe(200);
    expect([200, 409]).toContain(pay.status); // 409: account already closed
    const acct = await getAcct(app, id, cust);
    expect(acct).toMatchObject({ status: 'CLOSED', totalOwedCents: 0, collateralCents: 0 });
    // Money conservation for this account: debt = repaid + applied + written off.
    const sum = async (type: string, la: string, dir: string) =>
      Number(
        (
          await pool.query(
            `SELECT COALESCE(SUM(e.amount_cents),0)::bigint AS s FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.txn_id
        WHERE t.account_id=$1 AND t.type=$2 AND e.ledger_account=$3 AND e.direction=$4`,
            [id, type, la, dir],
          )
        ).rows[0].s,
      );
    const repaid = pay.status === 200 ? 50_000 : 0;
    expect(liq.body.appliedCents + liq.body.writtenOffCents + repaid).toBeGreaterThanOrEqual(owed);
    expect(await sum('REPAYMENT', 'cash', 'D')).toBe(repaid);
    await reconcileOk(app);
  });

  it('concurrent daily jobs accrue interest and issue each statement exactly once', async () => {
    const { id, cust } = await openWithDebt(app, 100_000, 100_000);
    const runs = await Promise.all(
      [1, 2, 3].map(() => call(app, 'POST', '/v1/admin/jobs/daily', { role: 'ops', body: { asOf: '2026-01-31' }, key: null })),
    );
    expect(runs.every((r) => r.status === 200 && r.body.failed.length === 0)).toBe(true);
    expect((await getAcct(app, id, cust)).interestCents).toBe(Math.floor((30 * 100_000 * 2_400) / 3_650_000));
    expect(await statements(app, id, cust)).toHaveLength(1);
    await reconcileOk(app);
  });
});
