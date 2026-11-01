# Worked example: ISSUE-001 through the agentic TDD workflow

A real, evidence-backed issue taken from the secured-card challenge through RED → GREEN → REFACTOR → REVIEW → VERIFY. Read it with [`ai-sdlc.md`](ai-sdlc.md).

> **What this is and is not.** The three roles were run as three separate subagents, sequentially, by the orchestrating assistant in an interactive session. It was **not** executed by `scripts/ai-sdlc/orchestrate.mjs` or by the GitHub workflows (no model API key and no repository access were available), and **no GitHub issue, project board, label, workflow run or pull request exists yet**. The handoff checks the orchestrator script automates were performed by hand with the same rules. Subagent internal tool calls are not available, so the records under `ai-logs/runs/issue-1/slice-1-manual/` are the prompts sent and the final reports returned, not complete transcripts.

## 1. The issue

[`docs/backlog/ISSUE-001-capture-expired-authorization.md`](backlog/ISSUE-001-capture-expired-authorization.md), priority **P1**, type bug, requirement R-11 in [`tdd-matrix.md`](tdd-matrix.md).

**Evidence found before writing anything** (no speculation): `capture` in `src/services/spending.ts` never reads `expires_at`; expiry is enforced only by `expireAuthorizations`, which the daily job calls; the existing test "lapsed authorizations release their hold" runs the job *first*. So whether a late capture became debt depended on job timing.

Workflow A would validate this draft (all required sections, cited files exist), check it against existing issues and PRs, and, after the `backlog-approval` approval, file it labelled `ai-proposed`. A maintainer would then add `ai-ready`. Neither step was run.

## 2. The cycle

| Phase | Role | What happened | Orchestrator's independent check |
|---|---|---|---|
| **RED** | Test Engineer | Wrote `test/authorization-expiry.test.ts`: a late-capture test and a characterization test for capture 1 ms before expiry | Re-ran the file: **1 failed, 2 passed**; failure `AssertionError: expected 200 to be 409` at the first real assertion, after a valid setup (authorization created, clock past expiry, no job). Scope: only a test file changed. Related suites (`billing`, `core`: 21 tests) still green |
| decision | Orchestrator | Boundary was unspecified. Decided: expired only when the clock is *strictly after* `expires_at`, like `expireAuthorizations` | Test Engineer pinned it with a characterization test at exactly `expires_at` |
| **GREEN** | Implementation Engineer | 12-line change in `capture`: past expiry, release the hold, mark `EXPIRED`, audit, and **return** a 409 result (a throw would roll the release back). Stopped, rather than edit the test, when `format:check` failed on the Test Engineer's file | Scope: only `src/services/spending.ts`. Tests pass. Formatting routed back to the Test Engineer; the diff was verified token-identical, i.e. formatting only |
| **mutation check** | Orchestrator | Four mutations of the fix: `>=` boundary, hold not released, wrong audit action, guard removed | Three caught. **The audit-action mutation survived**: the test only counted audit rows. Routed to the Test Engineer, who asserted the row's action and authorization id; re-run: caught |
| **REFACTOR** | n/a | Skipped: the change is already small and follows the existing pattern | |
| **REVIEW** | Independent Reviewer (fresh agent, read-only) | **0 P0, 3 P1, 2 P2** | `git status` confirmed it changed nothing. `REVIEW_JSON` parsed |
| fixes | Test Engineer | P1s: matrix row R-11 updated; job after a rejected late capture; only the lapsed hold released (second live hold) plus a later partial capture; over-amount late capture is 409 not 422. P2: retry with a new key | Two further mutations caught (release the whole account hold; check the expiry after the 422) |
| **VERIFY** | Orchestrator | `npm run verify` | format, lint, typecheck OK; **9 files, 105 tests passed**; build OK. The new file passed 3 repeat runs (no flakiness) |

Accepted without change (P2): an overlong comment, and the behaviour that a late capture on a FROZEN or CLOSED account now releases the lapsed hold and answers `AUTHORIZATION_EXPIRED` instead of `INVALID_STATE`. The reviewer judged that arguably better.

## 3. Commits (branch `fix/capture-expired-authorization`, stacked on `feat/ai-sdlc-workflow`)

```
2051b20 test: capture of an expired authorization must be rejected (RED: fails until the fix)
6012ccc test: assert the audit row content and apply formatting for the expiry tests
d490381 fix: reject capture of an expired authorization regardless of daily-job timing
c6e096b test: pin hold-release scope, job interaction, 422 ordering and retry for expired captures
454a99c chore(ai): record the manual TDD run for ISSUE-001
```

The first commit is intentionally red; the rest of the branch is green. Hashes are local and will change if the branch is rebased again.

## 4. What the example surfaced about the process itself

* The orchestrator's `check-scope` CLI disagreed with `orchestrate.mjs` about run records (fixed on the tooling branch with a regression test).
* My first RED validation skipped the format check, so a format failure appeared only at GREEN. The orchestrator should run `format:check` on the Test Engineer's output (listed in the follow-ups below).
* The audit mutation survived until a mutation check was run on the *new* tests. A passing RED→GREEN is not enough; the workflow should keep the "mutate the fix" step.

## 5. Follow-ups, not done

* Make `orchestrate.mjs` run `npx prettier --check` on each agent's output before the RED/GREEN decision.
* Run this same issue through the real orchestrator and workflow once the repository is connected and an API key is configured; compare with this record.
* ISSUE-002, 003 and 005 are ready for the same treatment; ISSUE-004 and 006 need a product decision first.
