---
name: test-strategy
description: Build a risk-based test plan and regression tests for this secured-card service. Use when adding or changing a money-moving feature, after a bug is found, or to review coverage of critical financial scenarios.
---

# Risk-based test strategy

## Procedure
1. List the change's risks in this order: money created/lost, overspend, double effect (retry/duplicate/concurrent), unauthorized access,
   partial failure, wrong state transition, precision/overflow.
2. Map each risk to the cheapest test level that can *actually* catch it:
   - **Unit** (`test/unit.test.ts`): pure rules (allocation waterfall, limit, minimum due, interest, hashing). No DB.
   - **API + real PostgreSQL** (`test/core.test.ts`, `ops.test.ts`, `billing.test.ts`): flows, validation, authz, state machine, statements.
   - **Concurrency** (`test/concurrency.test.ts`, `invariants.test.ts`): fire requests with `Promise.all`; assert on final state, never on timing.
   - **DB integrity**: attack the schema directly (`pool.query`) to prove CHECKs/triggers hold even if app code is wrong.
   - **Process** (`test/shutdown.test.ts`): real server process, signals.
3. For each money path write: happy path, boundary (exactly equal to the limit/balance), rejection, retry with the same key, parallel
   duplicates, and a failure injected mid-transaction. End with `reconcileOk(app)`.
4. Make it deterministic: simulated clock (`setNow`, `runJob`), seeded randomness, no sleeps, no shared accounts between tests (use `fundedAccount`).
5. **Prove the test can fail.** Break the production code on purpose (e.g. drop the row lock, skip the idempotency insert), watch the test
   fail, restore the code, watch it pass. Note the observed result in the PR.

## Rules
- Do not mock the database or the transaction boundary.
- Assert error codes and that *no state changed* on failure (`footprint(accountId)` before/after).
- Do not report coverage numbers or pass counts that were not produced by a command you ran.
