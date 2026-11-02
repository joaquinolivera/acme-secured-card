---
id: ISSUE-006
title: "Define handling for a deposit confirmed after the account closed"
priority: P1
type: bug
ai_ready: false
---
## Problem statement
If the processor confirms a deposit for an already-closed account, the service answers `409` and keeps nothing. The funds exist at the processor with no recorded obligation and no refund path.

## Requirement reference
R-28 in `docs/tdd-matrix.md`; `docs/architecture.md` §13.

## Evidence
- `src/services/deposits.ts` `confirmDeposit`: `account is closed; funds must be refunded by ops`.
- No refund endpoint, ledger account or outbox event exists for this case (`grep -rn -i refund src` finds only that message and an unrelated comment in `src/services/repayments.ts`).

## Scope
Needs a product decision (record as unapplied funds and request a refund, or reject at the rail). Not ready for autonomous execution.

## Non-goals
Reopening closed accounts.

## Acceptance criteria
- [ ] Decision recorded as an ADR.
- [ ] The confirmed funds are recorded and a refund is requested (outbox) exactly once, idempotently by payment reference.
- [ ] The books still balance and `reconcile` reports the unapplied funds explicitly.

## Required tests
Confirmation after close; duplicate delivery; reconcile.

## Dependencies
Product decision (hence `ai_ready: false`).

## Definition of Done
ADR merged; RED→GREEN per criterion; review without open P0.
