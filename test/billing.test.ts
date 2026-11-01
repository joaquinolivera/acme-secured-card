import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool } from '../src/db.js';
import { dailyInterest, minimumDue } from '../src/services/billing.js';
import {
  call,
  getAcct,
  setup,
  teardown,
  auth,
  reconcileOk,
  realClock,
  setNow,
  runJob as runJobH,
  statements as statementsH,
  openWithDebt as openWithDebtH,
  repay,
} from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await setup();
});
afterAll(async () => {
  realClock();
  await teardown(app);
});

const runJob = (date: string) => runJobH(app, date);
const statements = (id: string, cust: string) => statementsH(app, id, cust);
const openWithDebt = (collateral: number, spend: number) => openWithDebtH(app, collateral, spend);

describe('interest math', () => {
  it('is exact integer math: a year of daily accrual equals principal x APR with no drift', () => {
    let rem = 0,
      total = 0;
    for (let d = 0; d < 365; d++) {
      const r = dailyInterest(100_000, 2_400, rem);
      total += r.cents;
      rem = r.remainder;
    }
    expect(total).toBe(24_000); // $1,000 at 24% for 365 days = $240.00 exactly
    expect(rem).toBe(0);
    rem = 0;
    total = 0;
    for (let d = 0; d < 365; d++) {
      const r = dailyInterest(100, 2_400, rem);
      total += r.cents;
      rem = r.remainder;
    }
    expect(total).toBe(24); // sub-cent daily amounts are carried, never lost
  });
  it('minimum payment: 10% with a floor, capped at the balance', () => {
    expect([minimumDue(0), minimumDue(1_000), minimumDue(10_000), minimumDue(101_972)]).toEqual([0, 1_000, 2_500, 10_198]);
  });
});

describe('statements, late fees, collections', () => {
  it('issues a statement from the ledger; late fee is charged once; a payment cures the overdue state', async () => {
    const { id, cust } = await openWithDebt(100_000, 100_000);
    await runJob('2026-01-31');
    const [s1] = await statements(id, cust);
    const interest = Math.floor((30 * 100_000 * 2_400) / 3_650_000); // 30 days, Jan 2..Jan 31
    expect(s1).toMatchObject({
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      openingCents: 0,
      purchasesCents: 100_000,
      repaymentsCents: 0,
      interestCents: interest,
      closingCents: 100_000 + interest,
      minimumDueCents: Math.ceil((100_000 + interest) / 10),
      dueDate: '2026-02-21',
      status: 'OPEN',
    });

    await runJob('2026-02-21'); // due date itself: still on time
    expect((await getAcct(app, id, cust)).feesCents).toBe(0);
    await runJob('2026-02-22'); // first day past due, nothing paid -> one late fee
    await runJob('2026-02-22'); // job re-run: no double charge
    expect((await getAcct(app, id, cust)).feesCents).toBe(1_500);
    expect((await statements(id, cust))[0]).toMatchObject({ status: 'OVERDUE', lateFeeCents: 1_500 });
    await runJob('2026-02-25');
    expect((await getAcct(app, id, cust)).feesCents).toBe(1_500);

    setNow('2026-02-26T12:00:00Z'); // pay the minimum: fees first, then interest, then principal
    const pay = await repay(app, id, s1.minimumDueCents);
    expect(pay.body.allocation.fees).toBe(1_500);
    await runJob('2026-02-26');
    expect((await statements(id, cust))[0].status).toBe('SETTLED');
    await reconcileOk(app);
  });

  it('paying the minimum by the due date avoids the fee, and the next statement reflects activity', async () => {
    const { id, cust } = await openWithDebt(100_000, 50_000);
    await runJob('2026-01-31');
    const [s1] = await statements(id, cust);
    setNow('2026-02-10T12:00:00Z');
    await repay(app, id, s1.minimumDueCents);
    const a = await auth(app, id, 10_000);
    await call(app, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', body: {} });
    await runJob('2026-02-22');
    expect((await getAcct(app, id, cust)).feesCents).toBe(0);
    await runJob('2026-03-02');
    const sts = await statements(id, cust);
    expect(sts).toHaveLength(2);
    expect(sts[1]!.status).toBe('SETTLED');
    expect(sts[0]).toMatchObject({ openingCents: s1.closingCents, purchasesCents: 10_000, repaymentsCents: s1.minimumDueCents });
    expect(sts[0]!.closingCents).toBe(
      sts[0]!.openingCents + sts[0]!.purchasesCents + sts[0]!.interestCents + sts[0]!.feesCents - sts[0]!.repaymentsCents,
    );
    await reconcileOk(app);
  });

  it('a frozen account still accrues interest; a zero-balance account gets a settled, fee-free statement', async () => {
    const frozen = await openWithDebt(100_000, 20_000);
    await call(app, 'POST', `/v1/accounts/${frozen.id}/freeze`, { role: 'ops', body: {} });
    const idle = await openWithDebt(30_000, 0);
    await runJob('2026-01-31');
    expect((await getAcct(app, frozen.id, frozen.cust)).interestCents).toBeGreaterThan(0);
    expect((await statements(idle.id, idle.cust))[0]).toMatchObject({ closingCents: 0, minimumDueCents: 0, status: 'SETTLED' });
    await runJob('2026-03-15');
    expect((await getAcct(app, idle.id, idle.cust)).feesCents).toBe(0);
    await reconcileOk(app);
  });

  it('lapsed authorizations release their hold', async () => {
    const { id, cust } = await openWithDebt(50_000, 0);
    const a = await auth(app, id, 20_000);
    await runJob('2026-01-05');
    expect((await getAcct(app, id, cust)).heldCents).toBe(20_000);
    await runJob('2026-01-09'); // 7-day TTL elapsed
    expect((await getAcct(app, id, cust)).heldCents).toBe(0);
    expect((await call(app, 'GET', `/v1/authorizations/${a.body.id}`, { role: 'ops' })).body.status).toBe('EXPIRED');
    const late = await call(app, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', body: {} });
    expect(late.status).toBe(409);
    await reconcileOk(app);
  });

  it('liquidation applies collateral to debt, writes off the shortfall, and is refused for good-standing accounts', async () => {
    const { id, cust } = await openWithDebt(100_000, 100_000); // fully drawn: interest + fee push debt past collateral
    expect((await call(app, 'POST', `/v1/accounts/${id}/liquidate`, { role: 'ops', body: {} })).status).toBe(409);
    await runJob('2026-01-31');
    await runJob('2026-02-22');
    const before = await getAcct(app, id, cust);
    expect(before.totalOwedCents).toBeGreaterThan(before.collateralCents);
    expect(before.availableCreditCents).toBe(0); // available credit is floored at zero, never negative

    const r = await call(app, 'POST', `/v1/accounts/${id}/liquidate`, { role: 'ops', body: {} });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ appliedCents: 100_000, writtenOffCents: before.totalOwedCents - 100_000, releasedCents: 0 });
    expect(r.body.account).toMatchObject({ status: 'CLOSED', collateralCents: 0, totalOwedCents: 0 });
    const w = await pool.query(
      `SELECT COALESCE(SUM(amount_cents),0)::bigint AS s FROM ledger_entries WHERE account_id=$1 AND ledger_account='bad_debt_expense'`,
      [id],
    );
    expect(w.rows[0].s).toBe(before.totalOwedCents - 100_000);
    await reconcileOk(app);
  });

  it('liquidation returns surplus collateral to the customer', async () => {
    const { id, cust } = await openWithDebt(100_000, 30_000);
    await runJob('2026-01-31');
    await runJob('2026-02-22');
    const before = await getAcct(app, id, cust);
    const r = await call(app, 'POST', `/v1/accounts/${id}/liquidate`, { role: 'ops', body: {} });
    expect(r.body).toMatchObject({
      appliedCents: before.totalOwedCents,
      writtenOffCents: 0,
      releasedCents: 100_000 - before.totalOwedCents,
    });
    await reconcileOk(app);
  });
});
