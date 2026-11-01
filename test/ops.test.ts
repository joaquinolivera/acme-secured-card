import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { pool } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { signToken } from '../src/auth.js';
import { call, fundedAccount, getAcct, setup, teardown, auth, realClock, repay } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  realClock();
  app = await setup();
});
afterAll(() => teardown(app));

describe('money input safety', () => {
  it('rejects unsafe integers, fractions, other currencies and absurd magnitudes', async () => {
    const { id, cust } = await fundedAccount(app, 30_000);
    for (const amountCents of [Number.MAX_SAFE_INTEGER, 2 ** 53, 1e15, 100_000_01, 0.1 + 0.2]) {
      const r = await call(app, 'POST', `/v1/accounts/${id}/repayments`, {
        role: 'processor',
        key: null,
        body: { amountCents, externalRef: 'pay_valid_ref' },
      });
      expect(r.status, String(amountCents)).toBe(400);
    }
    const eur = await call(app, 'POST', `/v1/accounts/${id}/repayments`, {
      role: 'processor',
      key: null,
      body: { amountCents: 100, externalRef: 'pay_valid_ref', currency: 'EUR' },
    });
    expect(eur.status).toBe(400);
    const usd = await call(app, 'POST', `/v1/accounts/${id}/deposits`, {
      role: 'customer',
      sub: cust,
      body: { amountCents: 100, currency: 'USD' },
    });
    expect(usd.status).toBe(201);
    const cardEur = await call(app, 'POST', `/v1/accounts/${id}/authorizations`, {
      role: 'processor',
      body: { amountCents: 100, merchant: 'x', currency: 'EUR' },
    });
    expect(cardEur.status).toBe(400);
  });

  it('the bigint parser refuses values beyond the safe integer range instead of rounding them', async () => {
    await expect(pool.query('SELECT 9007199254740993::bigint AS x')).rejects.toThrow(/safe integer/);
  });
});

describe('authorization boundaries', () => {
  it('cross-account access is blocked for every customer endpoint (404, no existence leak)', async () => {
    const victim = await fundedAccount(app, 30_000);
    const attacker = `evil_${randomUUID()}`;
    const as = { role: 'customer' as const, sub: attacker };
    const id = victim.id;
    const attempts = [
      call(app, 'GET', `/v1/accounts/${id}`, as),
      call(app, 'GET', `/v1/accounts/${id}/statements`, as),
      call(app, 'GET', `/v1/accounts/${id}/transactions`, as),
      call(app, 'POST', `/v1/accounts/${id}/deposits`, { ...as, body: { amountCents: 100 } }),
      call(app, 'POST', `/v1/accounts/${id}/freeze`, { ...as, body: {} }),
      call(app, 'POST', `/v1/accounts/${id}/unfreeze`, { ...as, body: {} }),
      call(app, 'POST', `/v1/accounts/${id}/close`, { ...as, body: {} }),
    ];
    for (const r of await Promise.all(attempts)) expect(r.status).toBe(404);
    expect(await getAcct(app, id, victim.cust)).toMatchObject({ status: 'ACTIVE', collateralCents: 30_000 });
    // a customer cannot open an account for someone else, nor use ops/processor-only endpoints
    expect((await repay(app, id, 100, { role: 'customer', ref: 'pay_attacker' })).status).toBe(403);
    expect((await call(app, 'POST', '/v1/accounts', { ...as, body: { customerId: victim.cust } })).status).toBe(403);
    expect((await call(app, 'GET', `/v1/accounts/${id}/audit`, as)).status).toBe(403);
    expect((await call(app, 'GET', '/v1/admin/reconcile', as)).status).toBe(403);
    expect((await call(app, 'POST', '/v1/admin/jobs/daily', { ...as, body: {}, key: null })).status).toBe(403);
    expect(
      (
        await call(app, 'POST', `/v1/webhooks/deposits/${victim.depositId}/confirm`, {
          ...as,
          body: { externalRef: 'abc', amountCents: 30_000 },
          key: null,
        })
      ).status,
    ).toBe(403);
  });

  it('rejects tampered, expired, wrong-audience, wrong-issuer, unknown-role and alg=none tokens', async () => {
    const { id } = await fundedAccount(app, 30_000);
    const t = await signToken('ops', 'x');
    const key = new TextEncoder().encode(process.env['JWT_SECRET']);
    const forged = (claims: Record<string, unknown>, aud = 'acme-credit', iss = 'acme-auth') =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('x')
        .setIssuer(iss)
        .setAudience(aud)
        .setExpirationTime('1h')
        .sign(key);
    const bad = [
      `${t}x`,
      `${t.slice(0, -4)}AAAA`,
      'garbage',
      `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"x","role":"ops"}').toString('base64url')}.`,
      await signToken('ops', 'x', '-1h'),
      await forged({ role: 'ops' }, 'someone-else'),
      await forged({ role: 'ops' }, 'acme-credit', 'evil-issuer'),
      await forged({ role: 'superuser' }),
    ];
    for (const token of bad) {
      const r = await app.inject({ method: 'GET', url: `/v1/accounts/${id}`, headers: { authorization: `Bearer ${token}` } });
      expect(r.statusCode, token.slice(0, 20)).toBe(401);
    }
    const ok = await app.inject({ method: 'GET', url: `/v1/accounts/${id}`, headers: { authorization: `Bearer ${t}` } });
    expect(ok.statusCode).toBe(200); // the control: a genuine token still works
  });
});

describe('state machine', () => {
  it('rejects invalid transitions', async () => {
    const cust = `c_${randomUUID()}`;
    const acc = await call(app, 'POST', '/v1/accounts', { role: 'customer', sub: cust, body: {} });
    const id = acc.body.id as string;
    expect((await call(app, 'POST', `/v1/accounts`, { role: 'customer', sub: cust, body: {} })).status).toBe(409); // one open account
    expect((await call(app, 'POST', `/v1/accounts/${id}/freeze`, { role: 'customer', sub: cust, body: {} })).status).toBe(409); // not active yet
    expect((await repay(app, id, 100)).status).toBe(409);
    expect((await call(app, 'POST', `/v1/accounts/${id}/liquidate`, { role: 'ops', body: {} })).status).toBe(409);
    const dep = await call(app, 'POST', `/v1/accounts/${id}/deposits`, { role: 'customer', sub: cust, body: { amountCents: 30_000 } });
    expect((await call(app, 'POST', `/v1/accounts/${id}/close`, { role: 'customer', sub: cust, body: {} })).status).toBe(409); // deposit pending
    const failed = await call(app, 'POST', `/v1/webhooks/deposits/${dep.body.id}/fail`, { role: 'processor', body: {}, key: null });
    expect(failed.body.status).toBe('FAILED');
    const late = await call(app, 'POST', `/v1/webhooks/deposits/${dep.body.id}/confirm`, {
      role: 'processor',
      body: { externalRef: 'late_pay', amountCents: 30_000 },
      key: null,
    });
    expect(late.status).toBe(409); // a failed deposit cannot be resurrected
    expect((await getAcct(app, id, cust)).collateralCents).toBe(0);
  });

  it('a closed account is terminal', async () => {
    const { id, cust } = await fundedAccount(app, 30_000);
    expect((await call(app, 'POST', `/v1/accounts/${id}/close`, { role: 'customer', sub: cust, body: {} })).status).toBe(200);
    expect((await call(app, 'POST', `/v1/accounts/${id}/close`, { role: 'customer', sub: cust, body: {} })).status).toBe(200); // idempotent by state
    for (const path of ['freeze', 'unfreeze'])
      expect((await call(app, 'POST', `/v1/accounts/${id}/${path}`, { role: 'customer', sub: cust, body: {} })).status).toBe(409);
    expect(
      (await call(app, 'POST', `/v1/accounts/${id}/deposits`, { role: 'customer', sub: cust, body: { amountCents: 100 } })).status,
    ).toBe(409);
    expect((await auth(app, id, 100)).status).toBe(402);
  });
});

describe('API consistency, health and persistence', () => {
  it('every error has the same shape and a request id; internal details never leak', async () => {
    const { id } = await fundedAccount(app, 30_000);
    const responses = [
      await call(app, 'GET', '/v1/nope', { role: 'ops' }),
      await call(app, 'GET', `/v1/accounts/${id}`),
      await call(app, 'GET', '/v1/accounts/zzz', { role: 'ops' }),
      await repay(app, id, -1, { role: 'ops' }),
      await repay(app, id, 999_999, { role: 'ops' }),
    ];
    for (const r of responses) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(Object.keys(r.body)).toEqual(['error']);
      expect(r.body.error.code).toMatch(/^[A-Z_]+$/);
      expect(typeof r.body.error.requestId).toBe('string');
      expect(JSON.stringify(r.body)).not.toMatch(/select |insert |pg_|stack|at \w+ \(/i);
    }
  });

  it('every response carries x-request-id: a valid client id is echoed, anything else is replaced', async () => {
    const get = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/healthz', headers });
    expect((await get({ 'x-request-id': 'req-12345678' })).headers['x-request-id']).toBe('req-12345678');
    const generated = (await get({})).headers['x-request-id'];
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    const hostile = (await get({ 'x-request-id': 'bad id with spaces & <script>' })).headers['x-request-id'];
    expect(hostile).toMatch(/^[0-9a-f-]{36}$/); // never reflected back
    const err = await app.inject({ method: 'GET', url: '/v1/nope', headers: { 'x-request-id': 'req-abcdefgh' } });
    expect(err.headers['x-request-id']).toBe('req-abcdefgh');
    expect(err.json().error.requestId).toBe('req-abcdefgh');
  });

  it('readiness reports 503 when the database is unreachable, then recovers', async () => {
    const spy = vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('connection refused'));
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
    spy.mockRestore();
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
  });

  it('state survives an application restart (a fresh app instance sees the same data)', async () => {
    const f = await fundedAccount(app, 30_000);
    const a = await auth(app, f.id, 7_000);
    const app2 = buildApp();
    await app2.ready();
    try {
      expect(await getAcct(app2, f.id, f.cust)).toMatchObject({ collateralCents: 30_000, heldCents: 7_000, availableCreditCents: 23_000 });
      expect((await call(app2, 'POST', `/v1/authorizations/${a.body.id}/capture`, { role: 'processor', body: {} })).status).toBe(200);
    } finally {
      await app2.close();
    }
  });
});
