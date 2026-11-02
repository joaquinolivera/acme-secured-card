(Verbatim final message returned by the Independent Reviewer subagent; its internal tool calls are not available to the orchestrator.)

No P0 findings. The change is correct, but R-11 in `docs/tdd-matrix.md` is still not updated, and a few test scenarios are missing. I ran `npx vitest run test/authorization-expiry.test.ts test/billing.test.ts` and all 11 tests pass. I changed nothing.

## Findings

**P1 – `docs/tdd-matrix.md:21` (R-11 not updated).** The Definition of Done requires this row to be updated, and the branch doesn't touch the file. The row still says "Partial / defect", "`capture` never reads `expires_at`" and "GAP-1". Line 47 still calls R-11 the defect slice. The row should become covered and point at `test/authorization-expiry.test.ts`.

**P1 – `test/authorization-expiry.test.ts` (matrix scenario "job after a rejected late capture leaves holds consistent" is not tested).** The matrix row lists it explicitly. It guards against a double release. The code looks safe, because `capture` holds the account lock and re-reads the status under it. The job only selects `AUTHORIZED` rows (`spending.ts:117-120`) and runs under the same account lock. Nothing in a test proves it, though. It would need a late capture, then `runJob`, then `heldCents` still 0 and `reconcileOk`.

**P1 – `test/authorization-expiry.test.ts` (second held authorization and partial capture untested).**
- `heldCents` is asserted as 0 with a single authorization. If `capture` released the wrong amount, for example the whole account hold, this test would still pass. A second live authorization is needed to show only this hold is released (`spending.ts:79`).
- A late capture with an explicit `amountCents` is not tested. The expiry check deliberately runs before the `CAPTURE_EXCEEDS_AUTH` 422 check (`spending.ts:72` vs `:83`), so an over-amount late capture now returns 409 rather than 422. That ordering is reasonable but unpinned.

**P2 – `test/authorization-expiry.test.ts` (no retry with a different key or no key).** After a late capture, a second capture with a new key should return 409 `INVALID_STATE` (status `EXPIRED`) and change no state. Today this only follows from the line-71 guard.

**P2 – `test/authorization-expiry.test.ts` (FROZEN and CLOSED not covered).** A late capture on a FROZEN or CLOSED account is untested. Behaviour is sound: the hold is released and the response is `AUTHORIZATION_EXPIRED` instead of `INVALID_STATE`. That is arguably better, because a lapsed hold should free credit whatever the account state, but it is a behaviour change.

**P2 – `src/services/spending.ts:72-83` (minor style).**
- The comment runs about 140 characters.
- `new Date(auth.expires_at)` is redundant if pg returns a `Date` for `timestamptz`. It is harmless.
- The audit `details` has `trigger: 'capture'`, which the job's expiry path does not emit. The job writes no audit row, so this is a new audit shape, but it is acceptable.

## What I checked and found sound

- **Criterion 1 (409 `AUTHORIZATION_EXPIRED`):** met and tested (`authorization-expiry.test.ts:35-37`). Removing the fix returns 200, which was the observed RED.
- **Criterion 2 (state after rejection):** met and tested. The test checks status `EXPIRED`, `heldCents` 0, `principalCents` 0, no `receivable_principal` rows and unchanged ledger txn and entry counts.
- **Criterion 3 (capture before expiry):** met and tested at `expiresAt-1` and at exactly `expiresAt`. Changing `>` to `>=` would fail the exact-instant test, so the boundary is pinned.
- **Criterion 4 (audit and replay):**
  - The newest audit row's action and authorization id are asserted, and the commit message says a mutation check found the gap and closed it.
  - Replay asserts 409, an identical body (including `requestId`), `Idempotent-Replayed: true`, and no extra audit row.
  - Returning a result instead of throwing means `idempotent()` stores the response and the transaction commits (`idempotency.ts:41-46`). This is the same pattern as the 402 decline.
- **Criterion 5 (`reconcile` clean):** `reconcileOk` is asserted in all three tests.
- **Lock order:** `lockAuth` takes the account lock first, then the authorization row `FOR UPDATE` (`spending.ts:62-67`). The status is read after both locks, so a concurrent capture or the job cannot double-release.
- **Hold release:** `releaseHold` does the same `held -= amount` that the job and `void` do.
- **Clock comparison:** `clock.now() > new Date(auth.expires_at)` is strictly-after, matching the job's `expires_at < cutoff`. Both sides are absolute instants, so there is no timezone issue.
- **Error shape:** the 409 body matches `src/app.ts:59` (`{ error: { code, message, requestId } }`) with no data leakage.
- **Scope:** only `capture` changed, plus the new test file. `ai-logs/runs/` is untracked and not part of the commits. The existing "lapsed authorizations" test still passes.

REVIEW_JSON: {"findings":[{"severity":"P1","file":"docs/tdd-matrix.md","summary":"Row R-11 (line 21) and the line-47 note are not updated; DoD requires marking R-11 covered and referencing test/authorization-expiry.test.ts"},{"severity":"P1","file":"test/authorization-expiry.test.ts","summary":"Matrix scenario 'job after a rejected late capture leaves holds consistent' is untested; add late capture, then runJob, then held still 0 and reconcile clean"},{"severity":"P1","file":"test/authorization-expiry.test.ts","summary":"Held assertion uses a single authorization, so a wrong-amount release would pass; add a second live auth and a late partial-amount capture (expiry now precedes the 422 CAPTURE_EXCEEDS_AUTH check at spending.ts:72 vs :83)"},{"severity":"P2","file":"test/authorization-expiry.test.ts","summary":"No test for retry after the rejection with a new key (expect 409 INVALID_STATE, no state change) or for late capture on FROZEN/CLOSED accounts (now returns AUTHORIZATION_EXPIRED instead of INVALID_STATE)"},{"severity":"P2","file":"src/services/spending.ts","summary":"Minor: overlong comment at line 73; new Date() wrapper likely redundant; audit details gain trigger:'capture' not emitted by the job path"}]}

---
Orchestrator follow-up after the review: the P1 findings were routed to the Test Engineer (same subagent resumed). Prompt summary: add the four tests (job after rejected late capture; only the lapsed hold released + later partial capture of another hold; over-amount late capture is 409 not 422; retry with a new key is 409 INVALID_STATE with no state change) and update only the R-11 row of docs/tdd-matrix.md; tests and the matrix only, no production code, no commit. The P2 findings on comment length and FROZEN/CLOSED behaviour were accepted by the orchestrator without change.

Verbatim reply: I added the four characterization tests to `test/authorization-expiry.test.ts` and updated the R-11 row in `docs/tdd-matrix.md`. All 7 tests in the file pass, and `npx prettier --check test/authorization-expiry.test.ts` reports it clean. I changed no production code and made no commit. [Results: prettier clean on both touched files; `npx vitest run test/authorization-expiry.test.ts` 1 file passed, 7 tests passed; matrix diff 2 lines (the R-11 row and the "first slice" sentence). Tests added: 1) a daily job after a rejected late capture leaves holds consistent; 2) only the lapsed hold is released, and a later partial capture of another hold works; 3) an over-amount late capture is reported as expired (409), not as 422; 4) a second capture with a different key after the rejection is refused without changing state. The `capture` helper now takes an optional body and `runJob` is imported from ./helpers.js. Matrix R-11: Implemented / Strong / none known / "GAP-1 fixed on branch fix/capture-expired-authorization (PR pending human approval)".]
