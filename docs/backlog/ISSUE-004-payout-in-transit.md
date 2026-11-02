---
id: ISSUE-004
title: "Post released collateral to a payout-in-transit account until the payout settles"
priority: P1
type: enhancement
ai_ready: false
---
## Problem statement
`close` and `liquidate` credit `cash` for the released collateral immediately, although the payout is only *requested* (outbox event). The ledger claims cash left the company before it did.

## Requirement reference
R-07 in `docs/tdd-matrix.md`; `docs/architecture.md` §12 "Simulated boundaries"; audit finding F14.

## Evidence
- `src/services/closing.ts`: both release postings use `{ account: 'cash', dir: 'C', ... }`.
- `src/services/closing.ts`: `emit(tx, 'payout.requested', ...)` is the only payout action.

## Scope
Needs a design decision first (new ledger account, settlement endpoint, who confirms). Not ready for autonomous execution.

## Non-goals
Building a real payout rail.

## Acceptance criteria
- [ ] Release credits `payout_in_transit`, not `cash`.
- [ ] A processor confirmation moves `payout_in_transit` to `cash` exactly once (idempotent by reference).
- [ ] `reconcile` includes the new account and the trial balance stays zero.

## Required tests
Ledger posting tests, idempotent settlement, race of settlement vs duplicate, reconcile.

## Dependencies
Product decision on the settlement flow (hence `ai_ready: false`).

## Definition of Done
Decision recorded as an ADR; RED→GREEN per criterion; migration is backward compatible; review without open P0.
