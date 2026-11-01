# Engineering review (final)

Reviewer stance: skeptical staff engineer evaluating a senior backend candidate. **Independence caveat:** this review was written by the same assistant that wrote and hardened the code, so it is a self-review. It relies on executed evidence (below) instead of impressions, and a human should still read the code and the money paths in particular.

## 1. What was actually executed

| Check | Command | Result |
|---|---|---|
| Formatting | `npm run format:check` | pass |
| Lint (type-aware, no floating/misused promises) | `npm run lint` | 0 errors |
| Type check | `npm run typecheck` (TypeScript 6.0.3) | pass |
| Tests | `npm test` against local PostgreSQL 16 | **73 / 73 passed**, 7 files, about 10 s |
| Build | `npm run build` | pass |
| All of the above from a **clean clone** | `git clone`, `npm ci`, `npm run verify` | pass |
| Dependency audit | `npm audit --omit=dev` and `npm audit` | 0 vulnerabilities (both) |
| Secret scan | gitleaks 8.30.1 over all 8 commits and over the staged tree | no leaks |
| Compiled server and demo | `node dist/server.js` + `npm run demo` | full flow passes; `reconcile` clean |
| README examples | the README curl block, run twice against the compiled server | repeatable; results as documented |
| Compiled daily job | `node dist/jobs/daily.js` | exit 0, 3 accounts processed, none failed |
| Mutation checks (manual) | remove row lock; disable idempotency replay; remove repayment re-delivery check; remove spend CHECK; blind the audit hash to `details` | each caught by the intended tests; all code restored and the full suite re-passed |
| Capture hook and gate scripts | synthetic hook input; synthetic `ai-logs/` | work as designed; the gate **fails on the real repo** because transcripts are missing |
| Terraform formatting | OpenTofu `fmt -check -recursive` | clean (also proves the HCL parses) |

## 2. What was not executed

| Item | Why | Where it will be exercised |
|---|---|---|
| `docker build`, `docker compose up` | no Docker daemon in the build environment | CI job `docker` |
| `terraform validate` / `plan` / `apply` | provider registry blocked (OpenTofu `init` failed with 403); nothing applied | CI job `terraform` |
| The GitHub Actions workflow itself | no runner; YAML syntax was parsed and each command run locally | first push |
| Claude Code `Stop`/`SubagentStop` hooks with a real session | no Claude Code CLI session here | next Claude Code session |
| Load, soak, failover, backup/restore | out of scope | future |
| Coverage percentage | not measured; none is claimed | future |

## 3. Open defects and risks, by severity

| Sev | Item | Note |
|---|---|---|
| **P0** | **AI transcripts are missing** (mandatory requirement) | The assistant cannot export its own transcript. `npm run check:ai-logs` fails, deliberately. The owner must export the claude.ai chat into `ai-logs/` and update `PROMPTS.md`. Tooling, instructions and a gate are in place |
| P1 | Docker, Terraform validity and CI are unproven | See section 2. The first CI run may find environment differences |
| P1 | Processor credential compromise can confirm fake deposits or repayments | Role-limited and audited, not prevented. Needs IdP-issued asymmetric tokens, mTLS or signed webhooks (threat model T14/T15) |
| P1 | Interest and fees can push owed above the limit and the collateral | Deliberate; shortfall is written off on liquidation. Default ratio 100% leaves no headroom (architecture §4) |
| P1 | Payout of released collateral is simulated, yet the ledger credits `cash` at close | Needs a "payout in transit" account (architecture §12) |
| P1 | Unbounded list endpoints; linear daily job and `reconcile` | Architecture §13 |
| P1 | No rate limiting; HS256 shared-secret dev tokens | Threat model T14, T16 |
| P2 | No outbox relay, idempotency-key retention job, two-phase repayments with reversals, audit-head anchoring | Architecture §12 |

Defects found and fixed during this pass are listed in [`audit.md`](audit.md) (F1 customer-asserted repayments was the most serious).

## 4. Assessment

| Dimension | Judgement and evidence |
|---|---|
| Requirement completeness | All five required flows plus freeze, limit increase, interest, statements, late fees. See [traceability](requirements-traceability.md). One mandatory item (transcripts) is unmet |
| Financial correctness | Integer cents; exact interest; balanced ledger; reconcile after money tests; one deliberate, documented exception (owed can exceed the limit via interest/fees) |
| Concurrency safety | Per-account row lock with fixed order and DB backstop; parallel purchase, close, liquidation, repayment and billing races tested; lock-removal mutation fails the test |
| Idempotency | Three mechanisms matched to the case; parallel duplicate tests; replay-disabled mutation fails three tests. Key retention not built |
| Persistence and consistency | One transaction per command; rollback test proves no partial state; restart test; migrations 001 and 002 |
| Security boundaries | Roles, ownership checks with 404, token validation variants tested, strict validation, no secret defaults. Dev-grade identity and no rate limiting |
| Architecture quality | One service on purpose, with reasons and rejected alternatives (ADRs). Module seams allow a later split |
| Test quality | Real database, no mocked transactions, deterministic clock and seeds, assertions on final state. Five manual mutations. No coverage number, no load tests |
| Code readability | Small modules; the transaction pattern repeats identically in every money path. `any` is used for `pg` rows and test bodies (lint rules relaxed knowingly) |
| Operational readiness | Health/readiness, graceful shutdown (tested), structured logs with request ids, container and IaC written. Unrun in this environment, no runbook, no scheduled `reconcile` |
| Documentation quality | Describes the code as it is, including limitations; several earlier wrong claims were corrected (audit F11). The README examples were executed |
| CI reliability | SHA-pinned actions, least privilege, real PostgreSQL service, deterministic tests. Unproven until it runs |
| AI transparency compliance | **Not compliant yet** (transcripts). Disclosed openly in `PROMPTS.md`; capture hook and gate prepared |

## 5. Classification

* **Verified implementation (executed):** the service, schema, all 73 tests, build, audits, secret scan, clean-clone verify, README examples, compiled job.
* **Tested behaviour:** each invariant in `docs/architecture.md` §4 and each scenario in `docs/test-strategy.md`.
* **Assumptions:** USD only; UTC business dates; a single processor identity; interest accrued at 00:30 UTC on that day's opening principal; repayments represent already-settled funds; limit ratio 100% by default.
* **Simulated integrations:** payment processor and card network, payment rail, payout execution, identity provider.
* **Known limitations:** section 3 and architecture §13.
* **Future enhancements:** two-phase repayments with reversals, outbox relay, JWKS and mTLS, pagination, sharded billing, audit-head anchoring, scheduled reconcile with paging.

## 6. Verdict

Fit for technical review as a correct, well-tested reference implementation with honest documentation. **Not ready to submit** until the AI transcripts are exported (P0) and the first CI run confirms the container, Terraform and workflow. Not production-ready, and it does not claim to be.
