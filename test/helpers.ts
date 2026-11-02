import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { signToken, type Role } from '../src/auth.js';
import { clock } from '../src/clock.js';

export async function resetDb() {
  const name = new URL(process.env['DATABASE_URL']!).pathname.slice(1);
  if (!/test/i.test(name)) throw new Error('refusing to wipe database "' + name + '": test database names must contain "test"');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
}
export const setNow = (iso: string) => {
  clock.now = () => new Date(iso);
};
export const realClock = () => {
  clock.now = () => new Date();
};

export async function setup() {
  await resetDb();
  const app = buildApp();
  await app.ready();
  return app;
}
export async function teardown(app: FastifyInstance) {
  await app.close();
  await pool.end();
}

export interface Call {
  role?: Role;
  sub?: string;
  body?: unknown;
  key?: string | null;
}
export async function call(app: FastifyInstance, method: 'GET' | 'POST', url: string, o: Call = {}) {
  const headers: Record<string, string> = {};
  if (o.role) headers['authorization'] = `Bearer ${await signToken(o.role, o.sub ?? 'svc')}`;
  if (method === 'POST' && o.key !== null) headers['idempotency-key'] = o.key ?? randomUUID();
  const res = await app.inject({ method, url, headers, payload: o.body as object | undefined });
  return { status: res.statusCode, body: res.json<any>(), headers: res.headers };
}

/** Opens an account for `cust` and funds it with `cents` through the full deposit -> webhook flow. */
export async function fundedAccount(app: FastifyInstance, cents: number, cust = `c_${randomUUID()}`) {
  const acc = await call(app, 'POST', '/v1/accounts', { role: 'customer', sub: cust, body: {} });
  const id = acc.body.id as string;
  const dep = await call(app, 'POST', `/v1/accounts/${id}/deposits`, { role: 'customer', sub: cust, body: { amountCents: cents } });
  const conf = await call(app, 'POST', `/v1/webhooks/deposits/${dep.body.id}/confirm`, {
    role: 'processor',
    body: { externalRef: `pay_${randomUUID()}`, amountCents: cents },
  });
  return { id, cust, depositId: dep.body.id as string, conf };
}
export const getAcct = async (app: FastifyInstance, id: string, cust: string) =>
  (await call(app, 'GET', `/v1/accounts/${id}`, { role: 'customer', sub: cust })).body;
export const auth = (app: FastifyInstance, id: string, amountCents: number, key?: string) =>
  call(app, 'POST', `/v1/accounts/${id}/authorizations`, { role: 'processor', body: { amountCents, merchant: 'ACME Store' }, key });
export const reconcileOk = async (app: FastifyInstance) => {
  const r = await call(app, 'GET', '/v1/admin/reconcile', { role: 'ops' });
  expect(r.body.discrepancies).toEqual([]);
  expect(r.body.ok).toBe(true);
};

/** Runs the daily job as of `date` (simulated clock; test env enables ALLOW_SIMULATED_TIME). */
export const runJob = async (app: FastifyInstance, date: string) => {
  setNow(`${date}T12:00:00Z`);
  const r = await call(app, 'POST', '/v1/admin/jobs/daily', { role: 'ops', body: { asOf: date }, key: null });
  expect(r.status).toBe(200);
  expect(r.body.failed).toEqual([]);
};
export const statements = async (app: FastifyInstance, id: string, cust: string) =>
  (await call(app, 'GET', `/v1/accounts/${id}/statements`, { role: 'customer', sub: cust })).body.statements as any[];

/** Account funded on 2026-01-01 with `collateral`, with `spend` captured the same day. */
export async function openWithDebt(app: FastifyInstance, collateral: number, spend: number) {
  setNow('2026-01-01T12:00:00Z');
  const f = await fundedAccount(app, collateral);
  if (spend) {
    const a = await auth(app, f.id, spend);
    await call(app, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', body: {} });
  }
  return f;
}

/** Counts rows so tests can prove a failed operation left no trace. */
export async function footprint(accountId: string) {
  const q = async (sql: string) => Number((await pool.query(sql, [accountId])).rows[0].n);
  return {
    ledgerTxns: await q('SELECT count(*) AS n FROM ledger_transactions WHERE account_id=$1'),
    ledgerEntries: await q('SELECT count(*) AS n FROM ledger_entries WHERE account_id=$1'),
    audit: await q('SELECT count(*) AS n FROM audit_log WHERE account_id=$1'),
    outbox: await q("SELECT count(*) AS n FROM outbox WHERE payload->>'accountId' = $1::text"),
  };
}

/** Reports a settled payment from the processor. Each call uses a fresh external reference unless `ref` is given. */
export const repay = (app: FastifyInstance, id: string, amountCents: number, o: { ref?: string; role?: Role } = {}) =>
  call(app, 'POST', `/v1/accounts/${id}/repayments`, {
    role: o.role ?? 'processor',
    key: null,
    body: { amountCents, externalRef: o.ref ?? `pay_${randomUUID()}` },
  });
