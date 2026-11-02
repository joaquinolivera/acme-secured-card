---
name: financial-correctness
description: Audit or verify financial invariants in this secured-card service - money representation, transaction boundaries, locking, idempotency, ledger balance and audit trail. Use before merging any change that touches balances, deposits, authorizations, repayments, billing or account closing.
---

# Financial correctness audit

Work through these checks against the code and cite `file:line` evidence for each. Report PASS / FAIL / NOT VERIFIED; never mark PASS without
reading the code and a test that exercises it.

## 1. Representation
- Money is integer cents end to end; no `parseFloat`, `toFixed`, `Math.round` on money, no decimal strings.
- Inputs pass `centsSchema` (positive safe integer, bounded) and `currencySchema` (USD only).
- Interest uses `dailyInterest` (integer numerator + carried remainder). Any new rounding rule must be documented.

## 2. Transaction boundary
For every function that changes balances confirm, in order: `withTx` -> `lockAccount` -> checks -> relative `UPDATE` (`applyDelta`) ->
`ledger.post` -> `audit` -> `emit`. A `return` or `throw` between the first write and the last must leave nothing behind.

## 3. Concurrency
- The account row lock is taken **before** reading balances used in a decision.
- Child rows (deposit/authorization) are locked after the account, never before.
- No app-level mutex or in-memory state guarding money (breaks horizontal scaling).
- Deadlock retry only wraps the whole transaction (`withTx`), never a partial step.

## 4. Idempotency
- Money-moving POST: key required, stored in the same transaction, request hash compared, scope = caller.
- Webhook-style endpoint: idempotent by state; a re-delivery returns the same result; conflicting details are 409.
- Failed requests must not consume the key.

## 5. Ledger and audit
- Every posted transaction balances; every balance change has a matching ledger entry; `reconcile` is clean afterwards.
- No `UPDATE`/`DELETE` on `ledger_*` or `audit_log`; corrections are compensating entries.
- Audit `details` contain ids and amounts, never tokens or personal data.

## 6. Invariants to re-prove after any change
available credit >= 0; principal + held <= limit; limit <= confirmed collateral; card ACTIVE only with confirmed collateral;
collateral released only with zero debt (or via `liquidate`); a debt is settled at most once.

## How to verify
`npm run verify`, then run the mutation check: temporarily remove `FOR UPDATE` in `lockAccount` and confirm
`test/concurrency.test.ts` fails; restore it. Record exact results; do not paraphrase.
