# Acme Credit: secured credit card service

A service that owns the lending flow of a **secured credit card**. The customer posts collateral; once the payment processor **confirms** it, the card activates and the credit limit is derived from it. Purchases are authorized against available credit, settled repayments restore it, and at close the collateral is released or applied to unpaid debt. It also includes a double-entry ledger, a hash-chained audit log, card freeze, limit increase by extra deposit, interest, statements and late fees.

**Status:** a tested reference implementation, **not production-ready**. The payment processor, payout and identity provider are simulated (see [`docs/architecture.md`](docs/architecture.md) §12).

| Read | |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Start here: design, financial model, invariants, concurrency, idempotency, AWS, limitations |
| [`docs/decisions/`](docs/decisions/) | Seven short ADRs with rejected alternatives |
| [`docs/threat-model.md`](docs/threat-model.md) · [`docs/test-strategy.md`](docs/test-strategy.md) | Security boundaries; what is tested and how |
| [`docs/audit.md`](docs/audit.md) · [`docs/requirements-traceability.md`](docs/requirements-traceability.md) · [`docs/engineering-review.md`](docs/engineering-review.md) | What was found and changed, requirement-by-requirement evidence, final review |
| [`docs/interview-notes.md`](docs/interview-notes.md) · [`PROMPTS.md`](PROMPTS.md) | Interview prep; AI usage and transcript status |

## Quick start

**Docker** (API on :3000, PostgreSQL on :5432, migrations applied on start; *not executed in the build environment, CI runs it*):

```bash
docker compose up --build
JWT_SECRET=local-dev-secret-change-me-0123456789abcdef npm run demo   # walks the whole flow
```

**Without Docker** (Node >= 20, PostgreSQL 16):

```bash
npm ci
createdb acme
cp .env.example .env            # then set JWT_SECRET (openssl rand -hex 32)
export DATABASE_URL=postgres://postgres@localhost:5432/acme JWT_SECRET=$(openssl rand -hex 32)
npm run migrate && npm run dev                 # other shell, same JWT_SECRET: npm run demo
```

**Verify everything** (needs PostgreSQL and a `acme_test` database, which the tests wipe):

```bash
createdb acme_test
npm run verify      # format check, lint, typecheck, 73 tests, build
```

## Try the API

Amounts are integer cents. Money-moving requests need an `Idempotency-Key`. Roles: `customer`, `processor` (card network + payment rail), `ops`.

```bash
export JWT_SECRET=...                     # same value the server uses
CUST=$(npm run -s token -- customer "alice-$(date +%s)")   # one open account per customer, so use a fresh name per run
PROC=$(npm run -s token -- processor card-network)
OPS=$(npm run -s token -- ops ops-1)
api() { # api METHOD PATH TOKEN [JSON]
  curl -s -X "$1" "localhost:3000$2" -H "authorization: Bearer $3" -H 'content-type: application/json' \
       -H "idempotency-key: $(node -p 'crypto.randomUUID()')" ${4:+-d "$4"}; echo; }

ACC=$(api POST /v1/accounts $CUST '{}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
DEP=$(api POST /v1/accounts/$ACC/deposits $CUST '{"amountCents":50000}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
REF=bank-$(date +%s)                      # external payment references must be unique, so generate one per run
api POST /v1/webhooks/deposits/$DEP/confirm $PROC "{\"externalRef\":\"$REF-dep\",\"amountCents\":50000}"   # card activates, limit $500
AUTH=$(api POST /v1/accounts/$ACC/authorizations $PROC '{"amountCents":30000,"merchant":"Grocer"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')   # approved, $300 held
api POST /v1/accounts/$ACC/authorizations $PROC '{"amountCents":30000,"merchant":"Grocer"}'          # declined (402): only $200 left
api POST /v1/authorizations/$AUTH/capture $PROC '{}'                                                 # clearing: the hold becomes $300 of debt
api POST /v1/accounts/$ACC/repayments $PROC "{\"amountCents\":10000,\"externalRef\":\"$REF-pay\"}"   # settled $100 payment: credit restored
api GET  /v1/accounts/$ACC $CUST
api GET  /v1/admin/reconcile $OPS
```

### Endpoints (`/v1`)

| Method and path | Role | Purpose |
|---|---|---|
| `POST /accounts` | customer, ops | Open an account (one open account per customer) |
| `GET /accounts/:id` | customer (own), ops, processor | Limit, owed, held, `availableCreditCents` |
| `POST /accounts/:id/deposits` | customer, ops | Announce a collateral deposit (pending, grants nothing) |
| `POST /webhooks/deposits/:id/confirm` · `/fail` | processor | Funds confirmed: activates the card or raises the limit |
| `POST /accounts/:id/authorizations` | processor | Authorize a purchase (`201` approved, `402` declined) |
| `POST /authorizations/:id/capture` · `/void` | processor | Clear (≤ authorized) or release a hold |
| `POST /accounts/:id/repayments` | processor, ops | Record a **settled** payment `{amountCents, externalRef}` (fees → interest → principal) |
| `POST /accounts/:id/freeze` · `/unfreeze` | customer, ops | Block or allow new purchases |
| `POST /accounts/:id/close` | customer, ops | Good-standing close, releases all collateral |
| `POST /accounts/:id/liquidate` | ops | Delinquent close: apply collateral, write off shortfall, release surplus |
| `GET /accounts/:id/statements` · `/transactions` | customer (own), ops | Statements; ledger entries |
| `GET /accounts/:id/audit` | ops | Audit trail with chain check |
| `POST /admin/jobs/daily` · `GET /admin/reconcile` | ops | Billing run; books-versus-balances check |
| `GET /healthz` · `/readyz` | none | Liveness; readiness (503 if the database is unreachable) |

Errors: `{"error":{"code":"INSUFFICIENT_CREDIT","message":"…","requestId":"…"}}`. Every response carries `x-request-id`.

## Configuration

`DATABASE_URL`, `JWT_SECRET` (required, ≥ 32 chars, **no default**), `PORT`, `AUTO_MIGRATE`, `POOL_MAX`, and product rules: `APR_BPS` (2400), `MIN_COLLATERAL_CENTS` (20000), `LIMIT_RATIO_BPS` (10000 = limit equals collateral; lower it to leave headroom for interest), `STATEMENT_CYCLE_DAYS` (30), `GRACE_DAYS` (21), `LATE_FEE_CENTS` (1500), `MIN_PAYMENT_FLOOR_CENTS` (2500), `MIN_PAYMENT_PCT_BPS` (1000), `AUTH_TTL_DAYS` (7). `ALLOW_SIMULATED_TIME=true` lets ops pass a past `asOf` date to the billing job; for tests and demos only, and the service refuses to start with it when `NODE_ENV=production`.

## Repository layout

```
src/app.ts              routes, auth, idempotency wrapper, error mapping
src/services/           accounts, deposits, spending, repayments, closing, billing
src/ledger.ts           balanced double-entry posting      src/reconcile.ts   books-vs-balances checker
src/idempotency.ts      exactly-once effects               src/audit.ts       hash-chained audit + outbox
migrations/             001 schema (CHECKs, triggers), 002 repayments
test/                   unit, API, concurrency, DB-integrity, billing, process tests (real PostgreSQL)
infra/terraform/        AWS: VPC, ALB, ECS Fargate, RDS Multi-AZ, Secrets Manager, scheduler, alarms
.github/workflows/      CI: quality, tests on PostgreSQL, security, docker smoke test, terraform
.claude/                project skills (financial-correctness, test-strategy, code-review) and transcript-capture hooks
```

## CI

`.github/workflows/ci.yml` runs on pull requests to `main` and pushes to `main` with read-only permissions and SHA-pinned actions: format, lint, typecheck, build; tests against a PostgreSQL service container; `npm audit` and a checksum-verified gitleaks scan of the full history; a Docker compose smoke test running the demo; `terraform fmt` and `validate`. There is no Go-style race detector for Node; races are covered by the concurrent integration tests. **The workflow has not been run on GitHub yet**; each command was run locally except the Docker, Terraform-validate and gitleaks-in-CI steps (see the engineering review for what was and was not executed).

## Before submitting (AI transparency is mandatory)

1. Export the claude.ai chat(s) into `ai-logs/claude-ai/` and update the table in [`PROMPTS.md`](PROMPTS.md); add any other AI tool you used.
2. `npm run check:ai-logs` must pass (or `-- --allow-gaps` if you are disclosing gaps).
3. `npm run verify`, then push, and confirm the CI run is green.
