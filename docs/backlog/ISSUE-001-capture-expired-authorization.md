---
id: ISSUE-001
title: "Reject capture of an expired authorization regardless of daily-job timing"
priority: P1
type: bug
ai_ready: true
---
## Problem statement
An authorization's hold lapses after `AUTH_TTL_DAYS`, but only the daily job moves it to `EXPIRED`. Until the job runs, `capture` still succeeds and turns the lapsed hold into debt. Whether a late capture is accepted therefore depends on job timing, not on the authorization's age.

## Requirement reference
R-11 (authorization hold lifecycle) in `docs/tdd-matrix.md`; invariant I5 (only valid, unexpired authorizations create debt).

## Evidence
- `src/services/spending.ts` `capture`: reads `status` and amounts, never `expires_at`.
- `src/services/spending.ts` `expireAuthorizations`: the only place expiry is enforced, called from `src/services/billing.ts` `processAccount`.
- `test/billing.test.ts` "lapsed authorizations release their hold" runs the job first and then captures (409). No test captures between expiry and the job.

## Scope
`capture` treats an authorization whose `expires_at` is in the past as expired: it releases the hold, marks it `EXPIRED`, records the outcome in the audit log and responds `409`. The release must be committed (not rolled back by throwing).

## Non-goals
Changing the TTL, the daily job, `void`, or `authorize`. No new endpoints, no schema change.

## Acceptance criteria
- [ ] Capturing after `expires_at`, with no daily job run, returns `409` with code `AUTHORIZATION_EXPIRED`.
- [ ] The same request marks the authorization `EXPIRED`, sets `held_cents` back, creates no principal and no ledger entry.
- [ ] Capturing before `expires_at` still succeeds (including on the last instant before expiry).
- [ ] The rejection is audited and replays identically for the same `Idempotency-Key`.
- [ ] `reconcile` is clean afterwards.

## Required tests
Integration with the simulated clock: late capture without a job; capture just before expiry; replay with the same key; `reconcileOk`; existing "lapsed authorizations" test still passes.

## Dependencies
None.

## Definition of Done
Failing test observed for the right reason first, then passing; related suites green; independent review without open P0; `npm run verify` green; `docs/tdd-matrix.md` row R-11 updated; PR links the issue.
