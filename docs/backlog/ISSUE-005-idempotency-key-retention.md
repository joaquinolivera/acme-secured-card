---
id: ISSUE-005
title: "Purge expired idempotency keys"
priority: P2
type: enhancement
ai_ready: true
---
## Problem statement
`idempotency_keys` grows forever; replayed responses older than any realistic retry window are dead weight.

## Requirement reference
R-25 (recovery and retry) in `docs/tdd-matrix.md`; ADR-0004 consequences.

## Evidence
- `src/idempotency.ts` inserts, reads and updates `idempotency_keys` rows; `migrations/001_init.sql` defines the table. `grep -rn idempotency_keys src migrations` finds no `DELETE`, so rows are never purged.

## Scope
A retention job (default 7 days) invoked from the existing daily job, in bounded batches.

## Non-goals
Changing replay semantics inside the retention window.

## Acceptance criteria
- [ ] Keys older than the retention window are deleted; newer keys still replay.
- [ ] Deletion is batched and safe to run concurrently and repeatedly.
- [ ] A purged key used again behaves as a new request (documented).

## Required tests
Simulated-clock integration tests: before/after the window, concurrent runs, batch bound.

## Dependencies
None.

## Definition of Done
RED→GREEN; ADR-0004 and architecture §13 updated; review without open P0.
