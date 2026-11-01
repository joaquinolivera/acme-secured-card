# Test strategy

Principle: tests exist to catch **financial** failures (money created or lost, overspend, double effect, wrong access), so each risk is mapped to the cheapest test level that can actually catch it. The database is real PostgreSQL; the transaction boundary is never mocked.

## Running

```bash
createdb acme_test                       # once; the harness wipes this schema on every run
npm test                                 # all 73 tests (needs PostgreSQL)
npm run test:unit                        # pure rules, no database
npm run verify                           # format check + lint + typecheck + tests + build
```

`TEST_DATABASE_URL` (default `postgres://postgres@localhost:5432/acme_test`) selects the database. The harness **refuses to wipe any database whose name does not contain "test"**.

## Inventory (73 tests, 7 files, all passing at the time of writing)

| File | Tests | Level | Covers |
|---|---:|---|---|
| `unit.test.ts` | 17 | unit | payment waterfall, limit, minimum due, daily interest exactness, audit hashing and canonicalization, date math, config safety (no default secret, no simulated time in production) |
| `core.test.ts` | 13 | API + real DB | collateral/activation, limit increase by top-up, webhook redelivery, spending and repayment, freeze, close, authentication/authorization, input validation |
| `ops.test.ts` | 10 | API + real DB | unsafe numbers and currency, cross-account access, token forgery, state machine, error shape, request-id header, readiness when the DB is down, restart persistence |
| `invariants.test.ts` | 11 | API + real DB | atomic rollback, no trace on rejected requests, idempotency details, races: close vs repay, close vs purchase, concurrent liquidation, liquidation vs repayment, concurrent daily jobs |
| `concurrency.test.ts` | 13 | concurrent + DB integrity | 40 parallel purchases, mixed operations, 10 parallel retries of one key, payment-reference re-delivery and cross-account race, capture vs void, parallel webhooks, seeded random operation mix; direct attacks on the schema (append-only, unbalanced commit, CHECKs, audit tamper) |
| `billing.test.ts` | 8 | API + simulated clock | exact interest, statements from the ledger, late fee once, cure, authorization expiry, liquidation with write-off and with surplus |
| `shutdown.test.ts` | 1 | process | real server process: health, SIGTERM, clean exit, closed port |

## Mapping to the required scenarios

| Scenario | Test |
|---|---|
| Deposit confirmation activates the right limit | `core` activation; top-up |
| Unconfirmed collateral cannot activate | `core` (pending deposit grants nothing) |
| Duplicate deposit confirmation does not duplicate funds | `core` redelivery; `concurrency` 8 parallel webhooks |
| Purchase within, exactly at, and over the limit | `core` authorize test (exact headroom ok, one cent over declined) |
| Invalid and negative amounts | `core`, `ops` (floats, negatives, zero, strings, unsafe integers, absurd size, wrong currency) |
| Two simultaneous purchases cannot exceed credit | `concurrency` 40 parallel; mixed operations |
| Duplicate purchase requests, one effect | `concurrency` 10 parallel retries; `invariants` declined replay |
| Repayment restores the right credit | `core` |
| Duplicate repayment cannot restore credit twice | `concurrency` re-delivered payment, parallel and cross-account |
| Failed operations roll back completely | `invariants` exception after money moved; rejected requests leave no rows |
| Collateral not released with debt outstanding | `core` close; `invariants` close races |
| Collateral application does not settle twice | `invariants` concurrent liquidation; liquidation vs repayment |
| Concurrent purchases and repayments preserve invariants | `concurrency` mixed and randomized |
| Unauthorized and cross-account operations | `ops`, `core` |
| Invalid state transitions | `ops` state machine |
| Database failure handling | `ops` readiness returns 503 and recovers (simulated by making the pool query fail once) |
| Restart and persistence | `ops` second app instance sees the same data; `shutdown` |
| Audit consistency with transactions | `invariants` rollback leaves no audit row; `concurrency` tamper detection |
| Health checks, graceful shutdown | `ops`, `shutdown` |

## Making the tests deterministic

* Each test builds its own accounts (`fundedAccount`); no shared mutable state between tests. Files run sequentially against one database.
* Time is injected (`clock`), so billing tests jump dates with `setNow`/`runJob`. No sleeps.
* Concurrency tests assert on **final state and counts**, never on timing or ordering. The randomized test uses a seeded generator so failures reproduce.
* Money tests finish with `reconcileOk`, which fails on any ledger/balance/audit-chain discrepancy.

## Do the tests fail when the code is wrong? (mutation checks, run by hand)

Each production protection was disabled in turn, the relevant tests were run, and the code was restored (the full suite passed afterwards).

| Mutation | Result |
|---|---|
| Remove the account row lock (`FOR UPDATE`) | `concurrency`: 40-parallel test fails (3 runs: 20 approved, 8–9 requests became `409 INVARIANT_VIOLATION` instead of `402`; balances stayed correct) |
| Disable idempotency replay | 3 tests fail (parallel retries, declined replay, retried capture) |
| Remove the repayment re-delivery check | the payment-reference test fails |
| Remove the `spend_within_limit` CHECK | the "CHECK constraints refuse overspending" test fails |
| Make the audit hash ignore `details` | the tamper-detection test and the hash unit test fail |

These are manual runs, not an automated mutation-testing tool, and cover only these five protections.

## Not tested, honestly

* **Coverage percentage**: not measured; no number is claimed.
* **Load and soak behaviour**, deadlock frequency under heavy contention, large-account performance.
* **Database failover**, network partitions, crash-during-commit recovery beyond what PostgreSQL guarantees.
* **Backups and restores.**
* **Docker image, compose stack, Terraform plan/apply, GitHub Actions**: defined but not executed in the build environment; CI runs them.
* **Go-style race detection**: not applicable to Node. Races in the data layer are covered by the concurrent integration tests above.
