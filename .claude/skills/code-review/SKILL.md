---
name: code-review
description: Strict technical review of a change to this secured-card service - correctness, financial safety, simplicity, security, maintainability and fit with the challenge requirements. Use when asked to review a diff, a PR, or the whole repository before submission.
---

# Strict code review

Review as a skeptical staff engineer evaluating a senior candidate. Be specific: every finding has severity, evidence (`file:line`), failure
scenario, and a proposed fix. Distinguish **verified** (you ran it) from **assumed**.

## Order of review
1. **Does it satisfy the requirement?** Re-read the challenge text; list anything missing or invented.
2. **Financial safety** - apply the `financial-correctness` skill to every money path touched.
3. **Security** - authn/authz on every route, tenant isolation (customer sees only own account; foreign id -> 404), input validation,
   error messages without internals, secrets, logging of tokens/PII, dependency advisories.
4. **Simplicity** - could this be smaller? Remove speculative abstraction, unused exports, dead code. Reject new dependencies without need.
5. **Tests** - do they fail when the code is wrong? Are error paths and concurrency covered? Any sleeps, shared state, or mocked DB?
6. **Operations** - migrations backward compatible, health/readiness, graceful shutdown, structured logs, config via env with no secret defaults.
7. **Docs** - do README/architecture describe what the code does today, including known limitations? Any claim without evidence?

## Severity
- **P0** can lose or duplicate money, break an invariant, or leak data. Blocks merge.
- **P1** reliability, test, maintainability or documentation gap that a reviewer would flag.
- **P2** nice to have; list but do not implement unless asked.

## Output format
Findings table (ID | Severity | Evidence | Scenario | Fix), then "Verified", "Not verified", "Assumptions". No praise padding.
