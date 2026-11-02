import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool } from '../src/db.js';
import { call, fundedAccount, getAcct, setup, teardown, auth, reconcileOk, realClock, repay, footprint } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  realClock();
  app = await setup();
});
afterAll(() => teardown(app));

describe('collateral and activation', () => {
  it('a card is inactive until confirmed collateral reaches the minimum, then limit = deposit', async () => {
    const cust = 'cust_activation';
    const acc = await call(app, 'POST', '/v1/accounts', { role: 'customer', sub: cust, body: {} });
    expect(acc.status).toBe(201);
    expect(acc.body.status).toBe('PENDING_COLLATERAL');

    const dep = await call(app, 'POST', `/v1/accounts/${acc.body.id}/deposits`, {
      role: 'customer',
      sub: cust,
      body: { amountCents: 50_000 },
    });
    expect(dep.body.status).toBe('PENDING');
    // Unconfirmed money grants nothing.
    expect((await getAcct(app, acc.body.id, cust)).creditLimitCents).toBe(0);
    expect((await auth(app, acc.body.id, 100)).body.declineReason).toBe('ACCOUNT_NOT_ACTIVE');

    const conf = await call(app, 'POST', `/v1/webhooks/deposits/${dep.body.id}/confirm`, {
      role: 'processor',
      body: { externalRef: 'pay_1', amountCents: 50_000 },
    });
    expect(conf.status).toBe(200);
    expect(conf.body.account).toMatchObject({
      status: 'ACTIVE',
      collateralCents: 50_000,
      creditLimitCents: 50_000,
      availableCreditCents: 50_000,
    });
  });

  it('a deposit below the minimum does not activate; a second one does', async () => {
    const cust = 'cust_partial';
    const acc = await call(app, 'POST', '/v1/accounts', { role: 'customer', sub: cust, body: {} });
    const d1 = await call(app, 'POST', `/v1/accounts/${acc.body.id}/deposits`, {
      role: 'customer',
      sub: cust,
      body: { amountCents: 10_000 },
    });
    const c1 = await call(app, 'POST', `/v1/webhooks/deposits/${d1.body.id}/confirm`, {
      role: 'processor',
      body: { externalRef: 'pay_p1', amountCents: 10_000 },
    });
    expect(c1.body.account).toMatchObject({ status: 'PENDING_COLLATERAL', collateralCents: 10_000, creditLimitCents: 0 });
    const d2 = await call(app, 'POST', `/v1/accounts/${acc.body.id}/deposits`, {
      role: 'customer',
      sub: cust,
      body: { amountCents: 15_000 },
    });
    const c2 = await call(app, 'POST', `/v1/webhooks/deposits/${d2.body.id}/confirm`, {
      role: 'processor',
      body: { externalRef: 'pay_p2', amountCents: 15_000 },
    });
    expect(c2.body.account).toMatchObject({ status: 'ACTIVE', creditLimitCents: 25_000 });
  });

  it('a confirmed top-up on an active card raises the limit by exactly the deposit, also while frozen', async () => {
    const { id, cust } = await fundedAccount(app, 30_000);
    const a = await auth(app, id, 30_000);
    await call(app, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', body: {} });
    expect(await getAcct(app, id, cust)).toMatchObject({ creditLimitCents: 30_000, availableCreditCents: 0 });

    const dep = await call(app, 'POST', `/v1/accounts/${id}/deposits`, { role: 'customer', sub: cust, body: { amountCents: 20_000 } });
    // Announced but unconfirmed money changes nothing.
    expect(await getAcct(app, id, cust)).toMatchObject({ creditLimitCents: 30_000, availableCreditCents: 0 });
    await call(app, 'POST', `/v1/accounts/${id}/freeze`, { role: 'ops', body: {} });
    const conf = await call(app, 'POST', `/v1/webhooks/deposits/${dep.body.id}/confirm`, {
      role: 'processor',
      key: null,
      body: { externalRef: 'topup_1', amountCents: 20_000 },
    });
    expect(conf.status).toBe(200);
    expect(conf.body.account).toMatchObject({
      status: 'FROZEN',
      collateralCents: 50_000,
      creditLimitCents: 50_000,
      availableCreditCents: 20_000,
    });
    await reconcileOk(app);
  });

  it('webhook redelivery does not credit twice; a payment ref cannot fund two deposits', async () => {
    const { id, cust, depositId } = await fundedAccount(app, 30_000);
    const again = await call(app, 'POST', `/v1/webhooks/deposits/${depositId}/confirm`, {
      role: 'processor',
      body: { externalRef: 'other_ref', amountCents: 30_000 },
    });
    expect(again.status).toBe(409); // different ref than the one confirmed
    expect((await getAcct(app, id, cust)).collateralCents).toBe(30_000);

    const d2 = await call(app, 'POST', `/v1/accounts/${id}/deposits`, { role: 'customer', sub: cust, body: { amountCents: 5_000 } });
    const first = await call(app, 'POST', `/v1/webhooks/deposits/${d2.body.id}/confirm`, {
      role: 'processor',
      body: { externalRef: 'pay_dup', amountCents: 5_000 },
    });
    expect(first.status).toBe(200);
    const redeliver = await call(app, 'POST', `/v1/webhooks/deposits/${d2.body.id}/confirm`, {
      role: 'processor',
      body: { externalRef: 'pay_dup', amountCents: 5_000 },
    });
    expect(redeliver.status).toBe(200);
    const d3 = await call(app, 'POST', `/v1/accounts/${id}/deposits`, { role: 'customer', sub: cust, body: { amountCents: 5_000 } });
    const reuse = await call(app, 'POST', `/v1/webhooks/deposits/${d3.body.id}/confirm`, {
      role: 'processor',
      body: { externalRef: 'pay_dup', amountCents: 5_000 },
    });
    expect(reuse.status).toBe(409);
    expect((await getAcct(app, id, cust)).collateralCents).toBe(35_000);
    await reconcileOk(app);
  });

  it('rejects an amount that differs from the requested deposit', async () => {
    const cust = 'cust_mismatch';
    const acc = await call(app, 'POST', '/v1/accounts', { role: 'customer', sub: cust, body: {} });
    const dep = await call(app, 'POST', `/v1/accounts/${acc.body.id}/deposits`, {
      role: 'customer',
      sub: cust,
      body: { amountCents: 50_000 },
    });
    const conf = await call(app, 'POST', `/v1/webhooks/deposits/${dep.body.id}/confirm`, {
      role: 'processor',
      body: { externalRef: 'pay_m', amountCents: 40_000 },
    });
    expect(conf.status).toBe(422);
    expect((await getAcct(app, acc.body.id, cust)).collateralCents).toBe(0);
  });
});

describe('spending and repayment', () => {
  it('authorize holds credit, never exceeds the limit, capture creates debt, repayment restores credit', async () => {
    const { id, cust } = await fundedAccount(app, 100_000);
    const a1 = await auth(app, id, 60_000);
    expect(a1.status).toBe(201);
    expect((await getAcct(app, id, cust)).availableCreditCents).toBe(40_000);

    const over = await auth(app, id, 40_001); // one cent too many
    expect(over.status).toBe(402);
    expect(over.body.declineReason).toBe('INSUFFICIENT_CREDIT');
    expect((await auth(app, id, 40_000)).status).toBe(201); // exactly the remaining headroom is fine
    expect((await getAcct(app, id, cust)).availableCreditCents).toBe(0);

    const cap = await call(app, 'POST', `/v1/authorizations/${a1.body.id}/capture`, { role: 'processor', body: { amountCents: 55_000 } });
    expect(cap.body).toMatchObject({ status: 'CAPTURED', capturedCents: 55_000 });
    // 5,000 of the hold was released by the partial capture.
    expect(await getAcct(app, id, cust)).toMatchObject({ principalCents: 55_000, heldCents: 40_000, availableCreditCents: 5_000 });

    const pay = await repay(app, id, 20_000);
    expect(pay.body.allocation).toEqual({ fees: 0, interest: 0, principal: 20_000 });
    expect(await getAcct(app, id, cust)).toMatchObject({ principalCents: 35_000, availableCreditCents: 25_000 });

    const tooMuch = await repay(app, id, 35_001);
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('OVERPAYMENT');
    await reconcileOk(app);
  });

  it('a customer cannot restore their own credit: repayments are settled funds reported by the processor', async () => {
    const { id, cust } = await fundedAccount(app, 40_000);
    const a = await auth(app, id, 10_000);
    await call(app, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', body: {} });
    const before = await footprint(id);
    const mine = await repay(app, id, 10_000, { role: 'customer' });
    expect(mine.status).toBe(403);
    expect(await getAcct(app, id, cust)).toMatchObject({ principalCents: 10_000, availableCreditCents: 30_000 });
    expect(await footprint(id)).toEqual(before);
    const real = await repay(app, id, 10_000, { ref: 'bank-settled-001' });
    expect(real.body).toMatchObject({ replayed: false, allocation: { fees: 0, interest: 0, principal: 10_000 } });
    expect(await getAcct(app, id, cust)).toMatchObject({ principalCents: 0, availableCreditCents: 40_000 });
    const row = await pool.query('SELECT external_ref, principal_cents FROM repayments WHERE account_id=$1', [id]);
    expect(row.rows).toEqual([{ external_ref: 'bank-settled-001', principal_cents: 10_000 }]);
    await reconcileOk(app);
  });

  it('capture cannot exceed the authorization and cannot happen twice; void frees the hold', async () => {
    const { id, cust } = await fundedAccount(app, 50_000);
    const a = await auth(app, id, 10_000);
    expect(
      (await call(app, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', body: { amountCents: 10_001 } })).status,
    ).toBe(422);
    expect((await call(app, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', body: {} })).status).toBe(200);
    expect((await call(app, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', body: {} })).status).toBe(409);
    const b = await auth(app, id, 5_000);
    expect((await call(app, 'POST', `/v1/authorizations/${b.body.id}/void`, { role: 'processor', body: {} })).body.status).toBe('VOIDED');
    expect(await getAcct(app, id, cust)).toMatchObject({ heldCents: 0, principalCents: 10_000 });
    await reconcileOk(app);
  });

  it('freeze blocks new purchases but allows repayment; ops freeze cannot be lifted by the customer', async () => {
    const { id, cust } = await fundedAccount(app, 50_000);
    const a = await auth(app, id, 10_000);
    await call(app, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', body: {} });
    await call(app, 'POST', `/v1/accounts/${id}/freeze`, { role: 'ops', body: {} });
    expect((await auth(app, id, 100)).body.declineReason).toBe('ACCOUNT_FROZEN');
    expect((await repay(app, id, 1_000)).status).toBe(200);
    expect((await call(app, 'POST', `/v1/accounts/${id}/unfreeze`, { role: 'customer', sub: cust, body: {} })).status).toBe(403);
    expect((await call(app, 'POST', `/v1/accounts/${id}/unfreeze`, { role: 'ops', body: {} })).status).toBe(200);
    expect((await auth(app, id, 100)).status).toBe(201);
  });
});

describe('collateral release', () => {
  it('close requires zero debt; then the full collateral is released', async () => {
    const { id, cust } = await fundedAccount(app, 40_000);
    const a = await auth(app, id, 10_000);
    await call(app, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', body: {} });
    expect((await call(app, 'POST', `/v1/accounts/${id}/close`, { role: 'customer', sub: cust, body: {} })).status).toBe(409);
    await repay(app, id, 10_000);
    const closed = await call(app, 'POST', `/v1/accounts/${id}/close`, { role: 'customer', sub: cust, body: {} });
    expect(closed.body).toMatchObject({ releasedCents: 40_000, account: { status: 'CLOSED', collateralCents: 0, creditLimitCents: 0 } });
    expect((await auth(app, id, 100)).body.declineReason).toBe('ACCOUNT_NOT_ACTIVE');
    // After closing, the customer can open a new account.
    expect((await call(app, 'POST', '/v1/accounts', { role: 'customer', sub: cust, body: {} })).status).toBe(201);
    await reconcileOk(app);
  });

  it('cannot close with an open hold', async () => {
    const { id, cust } = await fundedAccount(app, 40_000);
    await auth(app, id, 1_000);
    expect((await call(app, 'POST', `/v1/accounts/${id}/close`, { role: 'customer', sub: cust, body: {} })).status).toBe(409);
  });
});

describe('security and validation', () => {
  it('requires a valid token with the right role; customers cannot see other accounts', async () => {
    const { id } = await fundedAccount(app, 30_000, 'owner_1');
    expect((await call(app, 'GET', `/v1/accounts/${id}`)).status).toBe(401);
    expect((await call(app, 'GET', `/v1/accounts/${id}`, { role: 'customer', sub: 'someone_else' })).status).toBe(404);
    expect(
      (
        await call(app, 'POST', `/v1/accounts/${id}/authorizations`, {
          role: 'customer',
          sub: 'owner_1',
          body: { amountCents: 100, merchant: 'x' },
        })
      ).status,
    ).toBe(403);
    expect((await repay(app, id, 100, { role: 'customer' })).status).toBe(403); // customers cannot report payments at all
    expect((await call(app, 'POST', `/v1/accounts/${id}/liquidate`, { role: 'customer', sub: 'owner_1', body: {} })).status).toBe(403);
  });

  it('rejects floats, negatives, zero, strings, unknown fields and a missing Idempotency-Key', async () => {
    const { id, cust } = await fundedAccount(app, 30_000);
    for (const amountCents of [10.5, -5, 0, '100', null, 1e12]) {
      const r = await call(app, 'POST', `/v1/accounts/${id}/repayments`, {
        role: 'processor',
        key: null,
        body: { amountCents, externalRef: 'pay_valid_ref' },
      });
      expect(r.status).toBe(400);
    }
    const unknownField = await call(app, 'POST', `/v1/accounts/${id}/repayments`, {
      role: 'processor',
      key: null,
      body: { amountCents: 5, externalRef: 'pay_valid_ref', extra: 1 },
    });
    expect(unknownField.status).toBe(400);
    expect(
      (await call(app, 'POST', `/v1/accounts/${id}/repayments`, { role: 'processor', key: null, body: { amountCents: 5 } })).status,
    ).toBe(400); // missing externalRef
    const noKey = await call(app, 'POST', `/v1/accounts/${id}/deposits`, {
      role: 'customer',
      sub: cust,
      body: { amountCents: 5 },
      key: null,
    });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await call(app, 'GET', '/v1/accounts/not-a-uuid', { role: 'ops' })).status).toBe(400);
  });
});
