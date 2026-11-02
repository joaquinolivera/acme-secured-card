# Audit of the delivered implementation

Phase 1 of the hardening pass. **Independence caveat:** the baseline was written by the same assistant in the previous session, so this is a self-audit, made with a deliberately adversarial checklist and backed by tests and mutation runs rather than by reading alone. A human reviewer should still read the code.

## 1. Baseline facts (inspected before any change)

| Topic | Finding |
|---|---|
| Language / framework | TypeScript (ESM, Node 22), Fastify 5, `pg`, `zod`, `jose`; Vitest for tests |
| Architecture | One service; modules `accounts`, `deposits`, `spending`, `repayments`, `closing`, `billing`; PostgreSQL 16 schema with `CHECK` constraints and triggers |
| Persistence | PostgreSQL, one migration (`001_init.sql`), per-account row locks, relative balance updates |
| API | Accounts, deposits (+ processor webhooks), authorizations (capture/void), repayments, freeze/unfreeze, close, liquidate, statements, transactions, audit, daily job, reconcile, health |
| Tests | 31 tests, 3 files, passing; real PostgreSQL; concurrency tests present; no unit tests of pure rules; no process-level or restart tests |
| CI | **None** |
| Lint / format | **None** |
| Local run | `docker-compose.yml` and README present; not executed (no Docker daemon available) |
| IaC | Terraform for AWS present; **never formatted or validated** |
| AI transcripts | `PROMPTS.md` was a stub with no transcripts |
| Secrets | None found by reading; no automated scan existed |

## 2. Findings

| ID | Sev | Finding | Evidence | Resolution |
|---|---|---|---|---|
| F1 | **P0** | **A customer could restore their own credit by calling `POST /repayments`**, with no proof that funds arrived. This conflates a claim with settlement and is a path to free credit | `src/app.ts` route allowed `customer`; `repay` took only an amount | Repayments are now recorded by `processor`/`ops` with a unique `externalRef` (`migrations/002_repayments.sql`, `src/services/repayments.ts`). Tests: customer gets 403; re-delivery applies once; cross-account race. ADR-0006 |
| F2 | **P0** (mandatory requirement) | **No AI transcripts exist in the repository.** The challenge requires every prompt and response | `ai-logs/` empty; `PROMPTS.md` was an index only | **Open, needs the owner.** The assistant cannot read its own full transcript. Added a capture hook for Claude Code, a submission gate (`npm run check:ai-logs`), export instructions, and an honest status table. See `PROMPTS.md` |
| F3 | P1 | Latent audit-chain defect: `canonical()` hashed `undefined` object values that JSON storage drops, so a future audit call passing an undefined field would make its own chain look tampered | Failing unit test written first (`'{"a":1,"b":undefined}'` ≠ `'{"a":1}'`) | `canonical()` now follows `JSON.stringify` semantics. Unit test |
| F4 | P1 | Currency was implicit; "unsupported currency" had no defined behaviour | Money requests with `currency: "USD"` were rejected as an unknown field | `currency` is optional and must be `USD`; anything else is `400`. Test |
| F5 | P1 | The test harness would drop the `public` schema of whatever `TEST_DATABASE_URL`/`DATABASE_URL` pointed at | `test/helpers.ts` | The harness refuses any database name without "test" |
| F6 | P1 | Graceful shutdown handler returned a floating promise, so a failure while closing would be swallowed; behaviour never tested | ESLint `no-misused-promises` | Handler rewritten (single-shot, logs and exits non-zero on failure); real-process test |
| F7 | P1 | `ALLOW_SIMULATED_TIME` could be enabled in a production process; `.env.example` shipped a usable-looking JWT secret | `src/config.ts`, `.env.example` | Service refuses to start with it under `NODE_ENV=production`; `.env.example` has no secret value. Tests |
| F8 | P1 | No lint, formatter, type-aware checks for floating promises, CI, dependency audit or secret scan | repository | ESLint (type-checked, `no-floating-promises`), Prettier, `.github/workflows/ci.yml`, Dependabot, `npm audit` clean (0 vulnerabilities after the `minimatch` override) |
| F9 | P1 | TypeScript 7 (chosen only because it was `latest`) is not supported by `typescript-eslint` | `npm install` peer conflict | Pinned to 6.0.x (ADR-0007) |
| F10 | P1 | Terraform was not canonically formatted (CI `fmt -check` would fail) and the CloudWatch log group used a KMS key whose policy would not let Logs use it (`apply` would fail with AccessDenied) | `tofu fmt -check`; review | Formatted; removed the KMS key from the log group. Still **not validated** (provider registry blocked in the build environment) |
| F11 | P1 | **Documentation claims that were wrong**: the previous summary said the lock-removal mutation approved "11 of 20" purchases (11 was the number of declines), and a test titled "echoes a client request id" never checked a header (none was set). Several test titles also overclaimed (wrong-audience token, "every customer endpoint") | re-ran the mutation and recorded histograms; read the tests | Real figures recorded in `docs/architecture.md` and `docs/test-strategy.md`; `x-request-id` header added and tested; tests extended to match their titles |
| F12 | P1 | Missing tests for several required scenarios: rollback atomicity, concurrent liquidation, repay/close and purchase/close races, concurrent daily jobs, declined-request replay, token forgery variants, state-machine rejections, readiness on DB failure, restart persistence | gap analysis against the required list | 42 tests added (31 → 73) |
| F13 | P1 | **Disclosed design limitation:** total owed can exceed the credit limit and the collateral once interest and fees accrue; the database enforces only `principal + held ≤ limit` | `liquidation applies collateral…` test shows owed > collateral | Not changed (refusing to accrue would be wrong). Documented in `docs/architecture.md` §4; mitigation is `LIMIT_RATIO_BPS` < 100% |
| F14 | P1 | Released collateral posts `Dr collateral_liability / Cr cash` at close, before any payout has settled | `src/services/closing.ts` | Documented as a simulated boundary; production needs a "payout in transit" account |
| F15 | P2 | Not built: outbox relay, idempotency-key retention, rate limiting, webhook signing, IdP/JWKS, audit-head anchoring, two-phase repayments with reversals | design review | Listed in `docs/architecture.md` §12 and the threat model |
| F16 | P1 | Docker image, compose stack, Terraform validate and the CI workflow had **not been executed** in the build environment | no Docker daemon, registry blocked, no Actions runner | **Resolved by the first GitHub CI runs.** Run 1 ([failed](https://github.com/joaquinolivera/acme-secured-card/actions/runs/41384217804)) found a real defect, F17; run 2 ([passed, 5/5 jobs](https://github.com/joaquinolivera/acme-secured-card/actions/runs/41384405357)) executed the compose stack, the demo against the container, `terraform fmt`+`validate`, gitleaks and the audits |
| F17 | P1 | The container `HEALTHCHECK` used `http://localhost:3000`. On Alpine `localhost` resolves to `::1` first and the server listens on IPv4 only, so a healthy API was reported unhealthy and `docker compose up --wait` failed | CI run 1, job "Container build and smoke test": API logged "Server listening at http://127.0.0.1:3000" and the container was "unhealthy" | Health check now uses `127.0.0.1` with a start period (commit `fix(docker)`); CI run 2 passed |

## 3. Acceptance criteria used

1. Every invariant in `docs/architecture.md` §4 is enforced in code or schema **and** has a test that fails when the protection is removed (five manual mutation runs recorded in `docs/test-strategy.md`).
2. `npm run verify` (format check, lint, typecheck, all tests, build) passes from a clean checkout against a real PostgreSQL.
3. `npm audit` reports 0 vulnerabilities; a secret scan of the history finds nothing.
4. Documentation describes the code as it is, including simulated boundaries and limitations.
5. The AI-transparency gate passes, **or** every gap is disclosed (`--allow-gaps`).

## 4. Plan executed

P0 first (F1, then F2 tooling), then P1 in order of money risk (F3–F7, F11–F12), then tooling and CI (F8–F10), then documentation. Results are in `docs/engineering-review.md`.
