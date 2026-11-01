import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { pool, withTx, type Tx } from './db.js';
import { config } from './config.js';
import { authenticate, type Actor, type Role, actorLabel, SYSTEM } from './auth.js';
import { AppError, notFound } from './errors.js';
import { hashRequest, idempotent, type Result } from './idempotency.js';
import { centsSchema, currencySchema } from './money.js';
import { toDate, clock } from './clock.js';
import { createAccount, getAccount, setFrozen, view, assertAccess } from './services/accounts.js';
import { requestDeposit, confirmDeposit, failDeposit } from './services/deposits.js';
import { authorize, capture, voidAuth, getAuthorization } from './services/spending.js';
import { repay } from './services/repayments.js';
import { closeAccount, liquidateAccount } from './services/closing.js';
import { listStatements, runDaily } from './services/billing.js';
import { reconcile } from './reconcile.js';
import { verifyAuditChain } from './audit.js';

const id = z.string().uuid();
const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

interface Ctx {
  tx: Tx;
  actor: Actor;
  requestId: string;
  params: Record<string, string>;
  body: any;
}

export function buildApp(): FastifyInstance {
  const app = Fastify({
    bodyLimit: 16 * 1024,
    genReqId: (req) =>
      typeof req.headers['x-request-id'] === 'string' && /^[\w-]{8,64}$/.test(req.headers['x-request-id'])
        ? req.headers['x-request-id']
        : randomUUID(),
    logger: { level: process.env['LOG_LEVEL'] ?? 'info', redact: ['req.headers.authorization'] },
  });

  // Correlate client logs, server logs and audit rows: every response carries the request id.
  app.addHook('onSend', (req, reply, payload, done) => {
    void reply.header('x-request-id', req.id);
    done(null, payload);
  });

  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & { code?: string; statusCode?: number };
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION',
          message: 'invalid request',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          requestId: req.id,
        },
      });
    }
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, requestId: req.id } });
    if (err.code === '23514') {
      // CHECK violation: a safety invariant refused the change
      req.log.error({ err }, 'invariant violation');
      return reply
        .code(409)
        .send({ error: { code: 'INVARIANT_VIOLATION', message: 'operation rejected by integrity constraint', requestId: req.id } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: 'BAD_REQUEST', message: err.message, requestId: req.id } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'internal error', requestId: req.id } });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found', requestId: req.id } }),
  );

  /** Money-moving POST: authn/z -> validation -> idempotency -> one DB transaction -> response. */
  function mutate(
    path: string,
    roles: Role[],
    schema: z.ZodTypeAny,
    run: (c: Ctx, body: any) => Promise<Result>,
    opts: { idempotencyKey?: boolean } = {},
  ) {
    const needKey = opts.idempotencyKey ?? true;
    app.post(path, async (req, reply) => {
      const actor = await authenticate(req.headers.authorization, roles);
      const params = z.object({ id: id.optional(), depositId: id.optional() }).passthrough().parse(req.params) as Record<string, string>;
      const body = schema.parse(req.body ?? {});
      const exec = (tx: Tx) => run({ tx, actor, requestId: req.id, params, body }, body);
      let result: Result & { replayed?: boolean };
      if (needKey) {
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !KEY.test(key))
          throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header (8-128 chars [A-Za-z0-9_.:-]) is required');
        const hash = hashRequest(req.method, req.routeOptions.url, params, body);
        result = await withTx((tx) => idempotent(tx, actorLabel(actor), key, hash, () => exec(tx)));
      } else {
        result = await withTx(exec);
      }
      return reply.code(result.status).header('Idempotent-Replayed', String(!!result.replayed)).send(result.body);
    });
  }

  async function read<T>(req: FastifyRequest, roles: Role[], fn: (tx: Tx, actor: Actor) => Promise<T>): Promise<T> {
    const actor = await authenticate(req.headers.authorization, roles);
    const client = await pool.connect();
    try {
      return await fn(client, actor);
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------- health
  app.get('/healthz', () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  // ---------------------------------------------------------------- accounts
  mutate('/v1/accounts', ['customer', 'ops'], z.object({ customerId: z.string().min(1).max(100).optional() }).strict(), async (c, b) => {
    const customerId = c.actor.role === 'customer' ? c.actor.sub : b.customerId;
    if (!customerId) throw new AppError(400, 'VALIDATION', 'customerId is required for ops');
    if (c.actor.role === 'customer' && b.customerId && b.customerId !== c.actor.sub)
      throw new AppError(403, 'FORBIDDEN', 'cannot open an account for another customer');
    return createAccount(c.tx, c.actor, customerId, c.requestId);
  });

  app.get('/v1/accounts/:id', async (req) =>
    read(req, ['customer', 'ops', 'processor'], async (tx, actor) => {
      const { id: accountId } = z.object({ id }).parse(req.params);
      return view(await getAccount(tx, actor.role === 'processor' ? { ...actor, role: 'ops' } : actor, accountId));
    }),
  );

  app.get('/v1/accounts/:id/statements', async (req) =>
    read(req, ['customer', 'ops'], async (tx, actor) => {
      const { id: accountId } = z.object({ id }).parse(req.params);
      await getAccount(tx, actor, accountId);
      return { statements: await listStatements(tx, accountId) };
    }),
  );

  app.get('/v1/accounts/:id/transactions', async (req) =>
    read(req, ['customer', 'ops'], async (tx, actor) => {
      const { id: accountId } = z.object({ id }).parse(req.params);
      await getAccount(tx, actor, accountId);
      const { rows } = await tx.query(
        `SELECT t.id, t.type, t.effective_date, t.metadata,
                json_agg(json_build_object('account', e.ledger_account, 'dir', e.direction, 'cents', e.amount_cents) ORDER BY e.id) AS entries
           FROM ledger_transactions t JOIN ledger_entries e ON e.txn_id = t.id
          WHERE t.account_id = $1 GROUP BY t.id ORDER BY t.created_at, t.id`,
        [accountId],
      );
      return {
        transactions: rows.map((r) => ({
          id: r.id,
          type: r.type,
          effectiveDate: r.effective_date,
          entries: r.entries,
          metadata: r.metadata,
        })),
      };
    }),
  );

  app.get('/v1/accounts/:id/audit', async (req) =>
    read(req, ['ops'], async (tx) => {
      const { id: accountId } = z.object({ id }).parse(req.params);
      const { rows } = await tx.query(
        'SELECT seq, at, actor, action, request_id, details FROM audit_log WHERE account_id=$1 ORDER BY seq',
        [accountId],
      );
      return { chainIntactUpTo: (await verifyAuditChain(tx, accountId)) ?? 'all', entries: rows };
    }),
  );

  // ---------------------------------------------------------------- collateral
  const amountBody = z.object({ amountCents: centsSchema, currency: currencySchema }).strict();

  mutate('/v1/accounts/:id/deposits', ['customer', 'ops'], amountBody, (c, b) =>
    requestDeposit(c.tx, c.actor, c.params['id']!, b.amountCents, c.requestId),
  );

  // Processor webhooks: state-machine idempotent, so no Idempotency-Key needed (redelivery is safe).
  mutate(
    '/v1/webhooks/deposits/:depositId/confirm',
    ['processor'],
    z.object({ externalRef: z.string().min(3).max(100), amountCents: centsSchema, currency: currencySchema }).strict(),
    (c, b) => confirmDeposit(c.tx, c.actor, c.params['depositId']!, b.externalRef, b.amountCents, c.requestId),
    { idempotencyKey: false },
  );
  mutate(
    '/v1/webhooks/deposits/:depositId/fail',
    ['processor'],
    z.object({}).strict(),
    (c) => failDeposit(c.tx, c.actor, c.params['depositId']!, c.requestId),
    { idempotencyKey: false },
  );

  // ---------------------------------------------------------------- spending
  mutate(
    '/v1/accounts/:id/authorizations',
    ['processor'],
    z.object({ amountCents: centsSchema, merchant: z.string().min(1).max(100), currency: currencySchema }).strict(),
    (c, b) => authorize(c.tx, c.actor, c.params['id']!, b.amountCents, b.merchant, c.requestId),
  );
  mutate(
    '/v1/authorizations/:id/capture',
    ['processor'],
    z.object({ amountCents: centsSchema.optional(), currency: currencySchema }).strict(),
    (c, b) => capture(c.tx, c.actor, c.params['id']!, b.amountCents, c.requestId),
  );
  mutate('/v1/authorizations/:id/void', ['processor'], z.object({}).strict(), (c) => voidAuth(c.tx, c.actor, c.params['id']!, c.requestId));
  app.get('/v1/authorizations/:id', async (req) =>
    read(req, ['processor', 'ops'], async (tx) => getAuthorization(tx, z.object({ id }).parse(req.params).id)),
  );

  // ---------------------------------------------------------------- repayment, lifecycle
  // Settled-funds report from the payment processor (or ops). Idempotent by `externalRef`, so no Idempotency-Key.
  mutate(
    '/v1/accounts/:id/repayments',
    ['processor', 'ops'],
    z.object({ amountCents: centsSchema, externalRef: z.string().min(3).max(100), currency: currencySchema }).strict(),
    (c, b) => repay(c.tx, c.actor, c.params['id']!, b.amountCents, b.externalRef, c.requestId),
    { idempotencyKey: false },
  );
  mutate('/v1/accounts/:id/freeze', ['customer', 'ops'], z.object({}).strict(), (c) =>
    setFrozen(c.tx, c.actor, c.params['id']!, true, c.requestId),
  );
  mutate('/v1/accounts/:id/unfreeze', ['customer', 'ops'], z.object({}).strict(), (c) =>
    setFrozen(c.tx, c.actor, c.params['id']!, false, c.requestId),
  );
  mutate('/v1/accounts/:id/close', ['customer', 'ops'], z.object({}).strict(), (c) =>
    closeAccount(c.tx, c.actor, c.params['id']!, c.requestId),
  );
  mutate('/v1/accounts/:id/liquidate', ['ops'], z.object({}).strict(), (c) =>
    liquidateAccount(c.tx, c.actor, c.params['id']!, c.requestId),
  );

  // ---------------------------------------------------------------- operations
  mutate(
    '/v1/admin/jobs/daily',
    ['ops'],
    z
      .object({
        asOf: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .strict(),
    async (_c, b) => {
      const today = toDate(clock.now());
      if (b.asOf && b.asOf !== today && !config.allowSimulatedTime) throw new AppError(403, 'FORBIDDEN', 'simulated time is disabled');
      return { status: 200, body: await runDaily(b.asOf ?? today) };
    },
    { idempotencyKey: false },
  );

  app.get('/v1/admin/reconcile', async (req) => read(req, ['ops'], async () => reconcile()));

  return app;
}

export { SYSTEM, assertAccess, notFound };
