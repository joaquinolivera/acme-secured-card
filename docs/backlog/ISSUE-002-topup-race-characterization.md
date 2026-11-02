---
id: ISSUE-002
title: "Characterize a limit increase racing concurrent purchases"
priority: P1
type: test
ai_ready: true
---
## Problem statement
A confirmed top-up deposit raises the credit limit while purchases may be authorizing at the same moment. Both paths take the account lock, so the result should be consistent, but no test proves it.

## Requirement reference
R-04 (concurrent purchases) and R-33 (limit increase) in `docs/tdd-matrix.md`; invariants I2, I3.

## Evidence
- `test/core.test.ts` has one *sequential* top-up test; `grep -n "topup\|top-up" test/*.ts` finds no concurrent one.
- `src/services/deposits.ts` `confirmDeposit` changes `credit_limit_cents` and `collateral_cents` under `lockAccount`.

## Scope
A characterization test (the behaviour is expected to already work). Fix production code only if the test exposes a defect.

## Non-goals
New product behaviour; any change to locking.

## Acceptance criteria
- [ ] With a fully drawn card, a top-up confirmation racing N purchases ends with approved purchases never exceeding the *final* limit, `principal + held ≤ limit` at every observed point, and `limit ≤ collateral`.
- [ ] Each purchase is either approved or declined cleanly (no `409 INVARIANT_VIOLATION`).
- [ ] `reconcile` is clean.

## Required tests
Concurrent integration test (`Promise.all`) asserting final state and counts only; run it repeatedly to confirm it is not flaky.

## Dependencies
None.

## Definition of Done
Test passes (or exposes a defect that is then fixed with its own RED→GREEN); no flakiness over repeated runs; review without open P0; matrix R-04 updated.
