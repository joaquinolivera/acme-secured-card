# Requirements-to-tests matrix

Input to the agentic TDD workflow ([`ai-sdlc.md`](ai-sdlc.md)). It is derived from reading the code and the 73 existing tests, not from the documentation alone. Baseline at the time of writing: `npx vitest run` → **7 files, 73 passed, 0 failed** (PostgreSQL 16 local).

Legend. **Status:** Implemented / Partial / Missing. **Cover:** how well the existing tests pin the behaviour (Strong = tested for the happy path, rejection, retry and race; Partial = some of these; None). **Gap** IDs link to evidence-backed backlog drafts in [`backlog/`](backlog/).

## P0: financial correctness

| ID | Requirement | Financial invariant | Status | Test type | Existing coverage | Missing scenarios | Gap |
|---|---|---|---|---|---|---|---|
| R-01 | Deposit confirmation | Only confirmed funds count; one payment applies once (I1, I7) | Implemented | API+DB, concurrency | Strong: `core` activation, redelivery, mismatch; `concurrency` 8 parallel webhooks; `invariants` duplicate ref | none known | none |
| R-02 | Card activation | ACTIVE only with confirmed collateral ≥ minimum (I1) | Implemented | API+DB, schema | Strong: `core`, `concurrency` CHECK test | none known | none |
| R-03 | Credit-limit enforcement | `principal + held ≤ limit`; available ≥ 0 (I3, I4) | Implemented | API+DB, concurrency, schema | Strong: exact/over-by-one, 40 parallel, CHECK, mutation checked | none known | none |
| R-04 | Concurrent purchases | No two requests pass the same headroom (I3) | Implemented | concurrency | Strong: 40 parallel, mixed, seeded random | **limit change racing purchases** (top-up confirmed while purchases are authorizing) is untested | GAP-2 |
| R-05 | Idempotent financial operations | One effect per key / reference (I7) | Implemented | concurrency | Strong: parallel retries, declined replay, failed request keeps key free, per-caller scope, payment refs | none known | none |
| R-06 | Repayment accounting | Settled funds only; waterfall; no overpayment (I6) | Implemented | unit, API+DB, concurrency | Strong: `unit` waterfall, `core`, `concurrency` redelivery + cross-account | none known | none |
| R-07 | Collateral application and release | Released only at zero debt, applied once (I8, I9) | Implemented (payout simulated) | API+DB, concurrency | Strong: close races, concurrent liquidation, liquidation vs repayment | the ledger credits `cash` at close before any payout settled | GAP-4 |
| R-08 | Atomic rollback | Failed command leaves no rows (I10) | Implemented | integration | Strong: exception after money moved; rejected requests; duplicate reference | none known | none |
| R-09 | Precision and validation | Integer cents, USD only, safe integers (I11) | Implemented | unit, API | Strong: floats, unsafe ints, currency, bigint parser, interest exactness | none known | none |
| R-10 | Cross-account authorization | A customer reaches only their own account | Implemented | API | Strong: every customer endpoint; token forgery variants | none known | none |
| R-11 | **Authorization hold lifecycle** | A hold that has expired can no longer become debt, regardless of whether the daily job has run | **Partial / defect** | API+DB, simulated clock | **Partial:** `billing` "lapsed authorizations" runs the job *first*; nothing tests `capture` between expiry and the job. `capture` never reads `expires_at` (`src/services/spending.ts`) | capture just after the TTL, before any job; capture exactly at the TTL; job after a rejected late capture leaves holds consistent | **GAP-1** |

## P1: reliability and maintainability

| ID | Requirement | Status | Existing coverage | Missing scenarios | Gap |
|---|---|---|---|---|---|
| R-20 | Invalid state transitions | Implemented | `ops` state machine, closed terminal | none known | none |
| R-21 | Persistence across restarts | Implemented | `ops` second app instance; `shutdown` | none known | none |
| R-22 | API contracts | Implemented | error shape, request-id header | list endpoints return unbounded arrays; no contract for page size | GAP-3 |
| R-23 | Database errors | Partial | readiness 503 and recovery | a query failing mid-command (non-constraint error) → 500 with rollback; only the constraint path is tested | not raised (no evidence of a defect) |
| R-24 | Audit consistency | Implemented | rollback leaves no audit row; tamper detection | none known | none |
| R-25 | Recovery and retry | Partial | idempotent replays; concurrent daily jobs | idempotency keys are never purged | GAP-5 |
| R-26 | Health and shutdown | Implemented | `ops`, `shutdown` | none known | none |
| R-27 | CI validation | Written, **not executed** | `.github/workflows/ci.yml` parsed; commands run locally | first GitHub run | none (needs the push) |
| R-28 | Money stranded by processor anomalies | Partial | closed-account confirmation returns 409 | no path to refund funds confirmed for a closed account (`src/services/deposits.ts`: "must be refunded by ops") | GAP-6 |

## P2: optional functionality

| ID | Requirement | Status | Existing coverage |
|---|---|---|---|
| R-30 | Statements | Implemented | `billing`: from the ledger, settled, zero balance |
| R-31 | Interest | Implemented | `unit` exactness; `billing` |
| R-32 | Late fees | Implemented | `billing`: once, cure |
| R-33 | Limit increase | Implemented | `core` top-up (also frozen) |
| R-34 | Card freezing | Implemented | `core`, `ops` |

Per the workflow rule, no P2 work is scheduled before every P0 row is demonstrably correct. R-11 is the only P0/P1 row with a missing scenario that points at a defect; it is the first slice.

## Verification evidence

| What | Command | Observed |
|---|---|---|
| Baseline | `npx vitest run` | 7 files, 73 tests, all passed |
| Evidence for GAP-1 | read `capture` in `src/services/spending.ts` | no reference to `expires_at`; expiry exists only in `expireAuthorizations`, called from the daily job |
| Evidence for GAP-3 | `grep -n "limit\|cursor\|offset" src/app.ts` | only `bodyLimit`; list queries have no `LIMIT` |
| Evidence for GAP-4 | `grep -n COLLATERAL_RELEASE -A3 src/services/closing.ts` | `Cr cash` posted inside `close` and `liquidate` |
| Evidence for GAP-5 | `grep -rn idempotency_keys src migrations` | insert/select/update only; no delete |
| Evidence for GAP-2 | `grep -n "topup\|top-up" test/*.ts` | one sequential top-up test; no race |
| Evidence for GAP-6 | `src/services/deposits.ts` | `account is closed; funds must be refunded by ops`, with no refund mechanism |

Slice results are appended to [`ai-sdlc.md`](ai-sdlc.md) (sample lifecycle) as they complete.
