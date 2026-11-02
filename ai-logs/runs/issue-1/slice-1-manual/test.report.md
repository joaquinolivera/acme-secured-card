(Verbatim final message returned by the Test Engineer subagent; its internal tool calls are not available to the orchestrator.)

I added `test/authorization-expiry.test.ts` with two tests. The late-capture test fails for the expected reason, and the capture-before-expiry test passes as a characterization test. I changed no production code and made no commit. I did not touch the R-11 row in `docs/tdd-matrix.md`, since that is part of the later Definition of Done.

**Command:** `npx vitest run test/authorization-expiry.test.ts`

**Result:** 1 failed, 1 passed.

**Failing test:** "rejects a late capture with 409, expires the auth, releases the hold, creates no debt, and replays identically". Its failure output:
```
AssertionError: expected 200 to be 409 // Object.is equality
 ❯ test/authorization-expiry.test.ts:39:22
     expect(r.status).toBe(409);
```
- **Why it's the expected failure:** the setup works, since the authorization was created, the clock is set one second past `expiresAt`, and no daily job ran. `capture` returned 200 and turned the lapsed hold into debt, which is the defect in the issue. The setup itself is sound, so this is not a typo or import problem.
- **Not yet reached:** the assertions after line 39 have not executed, so the code that makes the first assertion pass has not been checked against them.
  - Error code: `error.code` is `AUTHORIZATION_EXPIRED`.
  - Authorization status: `EXPIRED`.
  - Account figures: `heldCents` and `principalCents` are both 0.
  - Ledger: no `receivable_principal` entries, and the ledger transaction and entry counts are unchanged.
  - Audit: the audit row count increases.
  - Replay: the same key returns the same 409 body with `Idempotent-Replayed: true` and no extra audit row.
  - Reconcile: `reconcileOk` is clean.

**Passing test:** "still captures on the last instant before expiry". It captures at `expires_at - 1ms` and expects 200, status `CAPTURED`, held 0, principal 20,000, and a clean reconcile. It passes because today's `capture` ignores `expires_at`. It guards against the fix rejecting too early.

**Setup:** each test authorizes 20,000 at 2026-01-01T12:00Z on an account funded with 50,000 and reads `expiresAt` from the API response. The late-capture test sets the clock 1s after `expiresAt`, and the other sets it 1ms before.

**Boundary not covered:** capture exactly at `expires_at` is not tested. The job uses `expires_at < cutoff`, which suggests expiry is strict, but the issue doesn't say which way the boundary goes.

Untracked `ai-logs/runs/` already existed in the repo and is not mine.

---
Follow-up exchange (the orchestrator resumed the same subagent; its prompt is below, then its verbatim reply).

PROMPT: Orchestrator decision on the boundary you flagged: an authorization is expired only when the clock is STRICTLY AFTER expires_at (same rule as expireAuthorizations, which uses expires_at < now). So capture at exactly expires_at must still succeed. Please add ONE more test to test/authorization-expiry.test.ts (tests only, no production changes, no commit): 'still captures at exactly the expiry instant'. Use the existing lateScenario(), setNow(new Date(expiresAt).toISOString()), expect 200, status CAPTURED, held 0, principal 20_000, reconcileOk. It is a characterization test and should PASS today; do not break working code to make it fail. Then run the whole file once and report the exact result (expected: 1 failed, 2 passed).

REPLY: I added the test 'still captures at exactly the expiry instant' to `test/authorization-expiry.test.ts`. I made no production changes and no commit.

**Command:** `npx vitest run test/authorization-expiry.test.ts`

**Result:** 1 failed, 2 passed (3 tests), as you expected.

- **Failed:** the late-capture test, with `AssertionError: expected 200 to be 409` at `test/authorization-expiry.test.ts:39`. Its failure reason is the same as before: `capture` ignores `expires_at`, so it returns 200 instead of 409.
- **Passed:** the capture-before-expiry test (`expires_at - 1ms`) and the new test. The new one uses `setNow(new Date(expiresAt).toISOString())`, expects 200, status `CAPTURED`, held 0, principal 20,000, and a clean `reconcileOk`.

The new test passes today because `capture` doesn't check expiry at all. It is a guard for the fix: a fix that rejects at exactly `expires_at` (for example by using `>=`) would break it.
