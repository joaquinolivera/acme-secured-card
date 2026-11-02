import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool } from '../src/db.js';
import { auth, call, footprint, fundedAccount, getAcct, reconcileOk, realClock, runJob, setNow, setup, teardown } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await setup();
});
afterAll(async () => {
  realClock();
  await teardown(app);
});

const capture = (authId: string, key?: string, body: object = {}) =>
  call(app, 'POST', `/v1/authorizations/${authId}/capture`, { role: 'processor', body, key });
const getAuth = async (authId: string) => (await call(app, 'GET', `/v1/authorizations/${authId}`, { role: 'ops' })).body;
const principalRows = async (accountId: string) =>
  Number(
    (
      await pool.query(`SELECT count(*) AS n FROM ledger_entries WHERE account_id=$1 AND ledger_account='receivable_principal'`, [
        accountId,
      ])
    ).rows[0].n,
  );

/** Authorizes 20_000 at 2026-01-01T12:00:00Z; expires_at is read back from the API, with no daily job run. */
async function lateScenario() {
  setNow('2026-01-01T12:00:00Z');
  const { id, cust } = await fundedAccount(app, 50_000);
  const a = await auth(app, id, 20_000);
  expect(a.status).toBe(201);
  const expiresAt = new Date(a.body.expiresAt).getTime();
  return { id, cust, authId: a.body.id as string, expiresAt };
}

describe('R-11 capture of an expired authorization (no daily job)', () => {
  it('rejects a late capture with 409, expires the auth, releases the hold, creates no debt, and replays identically', async () => {
    const { id, cust, authId, expiresAt } = await lateScenario();
    const before = await footprint(id);
    setNow(new Date(expiresAt + 1000).toISOString());

    const key = 'late-capture-key-1';
    const r = await capture(authId, key);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('AUTHORIZATION_EXPIRED');

    expect((await getAuth(authId)).status).toBe('EXPIRED');
    const acct = await getAcct(app, id, cust);
    expect(acct.heldCents).toBe(0);
    expect(acct.principalCents).toBe(0);
    expect(await principalRows(id)).toBe(0);
    const after = await footprint(id);
    expect(after.ledgerTxns).toBe(before.ledgerTxns);
    expect(after.ledgerEntries).toBe(before.ledgerEntries);
    expect(after.audit).toBeGreaterThan(before.audit); // the rejection is audited
    const last = (await pool.query('SELECT action, details FROM audit_log WHERE account_id=$1 ORDER BY seq DESC LIMIT 1', [id])).rows[0];
    expect(last.action).toBe('AUTHORIZATION_EXPIRED');
    expect(last.details.authorizationId).toBe(authId);

    const replay = await capture(authId, key);
    expect(replay.status).toBe(409);
    expect(replay.body).toEqual(r.body);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((await footprint(id)).audit).toBe(after.audit);
    await reconcileOk(app);
  });

  it('still captures on the last instant before expiry', async () => {
    const { id, cust, authId, expiresAt } = await lateScenario();
    setNow(new Date(expiresAt - 1).toISOString());
    const r = await capture(authId);
    expect(r.status).toBe(200);
    expect((await getAuth(authId)).status).toBe('CAPTURED');
    const acct = await getAcct(app, id, cust);
    expect(acct.heldCents).toBe(0);
    expect(acct.principalCents).toBe(20_000);
    await reconcileOk(app);
  });

  it('still captures at exactly the expiry instant', async () => {
    const { id, cust, authId, expiresAt } = await lateScenario();
    setNow(new Date(expiresAt).toISOString());
    const r = await capture(authId);
    expect(r.status).toBe(200);
    expect((await getAuth(authId)).status).toBe('CAPTURED');
    const acct = await getAcct(app, id, cust);
    expect(acct.heldCents).toBe(0);
    expect(acct.principalCents).toBe(20_000);
    await reconcileOk(app);
  });

  it('a daily job after a rejected late capture leaves holds consistent', async () => {
    const { id, cust, authId, expiresAt } = await lateScenario();
    setNow(new Date(expiresAt + 1000).toISOString());
    expect((await capture(authId)).status).toBe(409);
    await runJob(app, '2026-01-10');
    const acct = await getAcct(app, id, cust);
    expect(acct.heldCents).toBe(0);
    expect(acct.principalCents).toBe(0);
    expect((await getAuth(authId)).status).toBe('EXPIRED');
    await reconcileOk(app);
  });

  it('only the lapsed hold is released, and a later partial capture of another hold works', async () => {
    const { id, cust, authId: aId, expiresAt } = await lateScenario();
    setNow('2026-01-02T12:00:00Z');
    const b = await auth(app, id, 10_000);
    expect(b.status).toBe(201);
    const bExpires = new Date(b.body.expiresAt).getTime();
    expect(bExpires).toBeGreaterThan(expiresAt);
    setNow(new Date(expiresAt + 1000).toISOString());
    const late = await capture(aId);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('AUTHORIZATION_EXPIRED');
    const mid = await getAcct(app, id, cust);
    expect(mid.heldCents).toBe(10_000);
    expect(mid.principalCents).toBe(0);
    const ok = await capture(b.body.id, undefined, { amountCents: 6_000 });
    expect(ok.status).toBe(200);
    const end = await getAcct(app, id, cust);
    expect(end.principalCents).toBe(6_000);
    expect(end.heldCents).toBe(0);
    await reconcileOk(app);
  });

  it('an over-amount late capture is reported as expired (409), not as 422', async () => {
    const { id, cust, authId, expiresAt } = await lateScenario();
    const before = await footprint(id);
    setNow(new Date(expiresAt + 1000).toISOString());
    const r = await capture(authId, undefined, { amountCents: 25_000 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('AUTHORIZATION_EXPIRED');
    expect((await getAuth(authId)).status).toBe('EXPIRED');
    const acct = await getAcct(app, id, cust);
    expect(acct.heldCents).toBe(0);
    expect(acct.principalCents).toBe(0);
    expect(await principalRows(id)).toBe(0);
    expect((await footprint(id)).ledgerEntries).toBe(before.ledgerEntries);
    await reconcileOk(app);
  });

  it('a second capture with a different key after the rejection is refused without changing state', async () => {
    const { id, cust, authId, expiresAt } = await lateScenario();
    setNow(new Date(expiresAt + 1000).toISOString());
    expect((await capture(authId, 'late-key-first')).status).toBe(409);
    const before = await footprint(id);
    const r = await capture(authId, 'late-key-second');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INVALID_STATE');
    expect(await footprint(id)).toEqual(before);
    const acct = await getAcct(app, id, cust);
    expect(acct.heldCents).toBe(0);
    expect(acct.principalCents).toBe(0);
    await reconcileOk(app);
  });
});
