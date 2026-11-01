import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool } from '../src/db.js';
import { auth, call, footprint, fundedAccount, getAcct, reconcileOk, realClock, setNow, setup, teardown } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await setup();
});
afterAll(async () => {
  realClock();
  await teardown(app);
});

const capture = (authId: string, key?: string) =>
  call(app, 'POST', `/v1/authorizations/${authId}/capture`, { role: 'processor', body: {}, key });
const getAuth = async (authId: string) => (await call(app, 'GET', `/v1/authorizations/${authId}`, { role: 'ops' })).body;
const principalRows = async (accountId: string) =>
  Number((await pool.query(`SELECT count(*) AS n FROM ledger_entries WHERE account_id=$1 AND ledger_account='receivable_principal'`, [accountId])).rows[0].n);

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
});
