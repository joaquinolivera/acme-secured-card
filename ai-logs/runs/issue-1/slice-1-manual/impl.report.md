(Verbatim final message returned by the Implementation Engineer subagent; its internal tool calls are not available to the orchestrator.)

`npm run verify` is still red, and I stopped there. The first step, `format:check`, fails on `test/authorization-expiry.test.ts`, which I'm not allowed to edit. The production change itself works, and all targeted tests pass.

**The verify failure.** Prettier flags the Test Engineer's new test file for formatting. The fix is `npx prettier --write test/authorization-expiry.test.ts`, which the Test Engineer should run. Because `format:check` fails first, lint, typecheck, the full test run and build never ran. Please re-run `npm run verify` once the file is formatted.

**The change** is in `src/services/spending.ts`, `capture`, and adds 12 lines. After the existing `status !== 'AUTHORIZED'` check, it does this:
- **Expiry rule:** if `clock.now() > new Date(auth.expires_at)`, the authorization counts as expired. It is strictly after, the same rule as `expireAuthorizations`.
- **Release and mark:** it calls `releaseHold(..., 'EXPIRED')`, which marks the authorization `EXPIRED` and gives the held amount back.
- **Audit:** it writes an `AUTHORIZATION_EXPIRED` audit entry with `trigger: 'capture'`.
- **Result:** it returns `{ status: 409, body: { error: { code: 'AUTHORIZATION_EXPIRED', message, requestId } } }` instead of throwing, so the release is committed. That body is also what a replay with the same `Idempotency-Key` returns.

The account lock was already taken by `lockAuth`, so everything runs in one transaction. A capture at `expires_at` minus 1 ms or at exactly `expires_at` is untouched. I ran `npx prettier --write src/services/spending.ts` on my own file only.

**Commands and results**
- `npx vitest run test/authorization-expiry.test.ts`: 1 file passed, 3 of 3 tests passed. This was run after the change; I did not re-run the test before it to watch it fail.
- `npx vitest run test/billing.test.ts test/core.test.ts test/concurrency.test.ts test/invariants.test.ts`: 4 files passed, 45 of 45 tests passed.
- `npm run verify` (first run, before formatting my file): `format:check` warned on `src/services/spending.ts` and `test/authorization-expiry.test.ts`.
- `npm run verify` (after formatting my file): `format:check` warned on `test/authorization-expiry.test.ts` only.

**Still open from the Definition of Done:** the `docs/tdd-matrix.md` row R-11 update and the independent review. I did not touch the docs file.

Nothing is committed.

---
Orchestrator follow-ups routed back to the Test Engineer (same subagent resumed; verbatim final replies):

1) Prettier on test file. REPLY: Prettier reformatted `test/authorization-expiry.test.ts`, and all 3 tests now pass against the fixed production code. I ran only the commands you listed and committed nothing. Line count: `wc -l` gave 83 lines before `npx prettier --write` and 89 after. Prettier only changed formatting, and I edited no assertion or logic. Format check: `npx prettier --check test/authorization-expiry.test.ts` reported "All matched files use Prettier code style!". Tests: `npx vitest run test/authorization-expiry.test.ts` gave 1 file passed and 3 tests passed (3).

2) Mutation M3 (audit action renamed) survived; strengthen the audit assertion. REPLY: The late-capture test now checks the audit row's content as well as the count. The file passes: 1 file, 3 tests. I made no production changes and no commit. After the existing `after.audit > before.audit` assertion, the test reads the newest `audit_log` row for the account (`SELECT action, details FROM audit_log WHERE account_id=$1 ORDER BY seq DESC LIMIT 1`) and asserts `action === 'AUTHORIZATION_EXPIRED'` and `details.authorizationId === authId`. `npx prettier --write` reported the file unchanged. I did not re-run your mutation check.
