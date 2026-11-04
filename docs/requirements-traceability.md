# Requirements traceability matrix (final)

Priority of the **remaining** risk: **P0** can cause financial loss, wrong balances, duplicated money movement, a security hole or breach of a mandatory requirement. **P1** is an important quality, reliability, testing or documentation gap. **P2** is optional. "Not run here" means defined in the repository but not executed in the build environment.

## Challenge requirements

| Requirement | Current implementation | Evidence | Risk | Required action |
|---|---|---|---|---|
| Collateral deposits (receive and confirm) | **Implemented.** Customer announces a deposit (`PENDING`); only the processor webhook confirms funds. Confirmation is idempotent and the payment reference is unique | `src/services/deposits.ts` `requestDeposit`, `confirmDeposit`; `deposits.external_ref UNIQUE`. Tests: `core` activation, redelivery, amount mismatch; `concurrency` 8 parallel webhooks; `invariants` rollback, duplicate reference | P2 | None. Real rail integration is simulated |
| Card activation only after confirmed collateral; limit from deposit | **Implemented.** `confirmDeposit` is the only path to `ACTIVE`; limit = `floor(collateral × ratio)` | `confirmDeposit`, `limitFor`; `CHECK active_needs_collateral`, `limit_within_collateral`. Tests: `core` (inactive until confirmed, partial deposits, top-up raises limit), `concurrency` CHECK tests, `unit` limit | P2 | None |
| Spending: authorize purchases, never above the limit | **Implemented.** Authorization places a hold under the account lock; decline is a recorded outcome (402); capture turns the hold into debt (≤ authorized) | `src/services/spending.ts` `authorize`, `capture`, `voidAuth`; `CHECK spend_within_limit`. Tests: `core` (exact headroom ok, +1 cent declined), `concurrency` 40 parallel, mixed, random mix | P2 | None |
| Repayments restore available credit | **Implemented.** Settled funds reported by the processor/ops with a unique reference; waterfall fees → interest → principal; overpayment rejected; customers cannot self-report | `src/services/repayments.ts`, `migrations/002_repayments.sql`, `src/money.ts` `allocate`. Tests: `core` (customer 403, restore credit, overpayment 422), `unit` waterfall, `concurrency` re-delivery and cross-account | P1 | Reversals (returns/NSF/chargebacks) and two-phase repayments are not modelled (ADR-0006) |
| Collateral release or application to debt | **Implemented.** `close` (zero debt, no holds, no pending deposit) releases all; `liquidate` (ops, after an overdue statement) applies collateral, writes off any shortfall, releases surplus | `src/services/closing.ts`; ledger types `COLLATERAL_RELEASE`, `COLLATERAL_APPLIED`, `WRITE_OFF`. Tests: `core` close; `billing` liquidation (shortfall and surplus); `invariants` races | P1 | Payout is simulated: `close` posts the release and a `payout.requested` event but no money moves (see architecture §12) |
| Concurrency safety | **Implemented.** Per-account `FOR UPDATE`, fixed lock order, relative updates, deadlock retry, DB constraints as backstop | `lockAccount`, `withTx`, `applyDelta`. Tests: `concurrency` and `invariants` (8 race tests in `concurrency`, 5 in `invariants`). Lock-removal mutation fails the 40-parallel test | P2 | None |
| Idempotency | **Implemented.** Keys stored in the same transaction; replay; payload-mismatch 422; state-idempotent webhooks; unique external references | `src/idempotency.ts`; `repayments.external_ref`. Tests: `concurrency` 10 parallel retries, `invariants` declined replay / failed request does not burn key / per-caller scope. Replay-disabled mutation fails 3 tests | P1 | Add a retention job for old keys (not built) |
| Financial consistency | **Implemented.** One transaction per command; balanced ledger (deferred trigger); `reconcile` compares balances, holds, trial balance and audit chains | `src/ledger.ts`, `src/reconcile.ts`. Tests: `invariants` rollback, `concurrency` unbalanced commit, `reconcileOk` after money tests | P1 | Run `reconcile` on a schedule in production (not wired) |
| Auditability | **Implemented.** Audit row in the same transaction, per-account hash chain, append-only triggers; request id in header and error body | `src/audit.ts`. Tests: `concurrency` tamper detection, `invariants` no audit row on failure, `unit` hashing, `ops` request id | P1 | Anchor the chain head in write-once storage; a full recomputation by a DB superuser is undetected |
| Security | **Partially implemented.** JWT with pinned algorithm, issuer, audience, expiry, role; per-route roles; ownership checks with 404; strict validation; no secret defaults; production guard on simulated time | `src/auth.ts`, `src/app.ts`, `src/config.ts`. Tests: `ops` token forgery and cross-account, `core`, `unit` config. Threat model in `docs/threat-model.md` | P1 | HS256 shared secret is a dev simplification; no rate limiting; no webhook signing (threat model T13–T16) |
| Test coverage | **Implemented for the stated risks;** coverage percentage not measured | 106 tests in 9 files (`docs/test-strategy.md`); five manual mutation checks | P1 | Add coverage reporting if desired; load and failover tests are absent |
| Architecture explained with trade-offs | **Implemented** | `docs/architecture.md`, `docs/decisions/` (7 ADRs) | P2 | None |
| Infrastructure as code, cloud deployment explained | **Written; `fmt` + `validate` pass in CI; never planned or applied** | `infra/terraform/*.tf`, `docs/architecture.md` §11; CI job `terraform` ([run](https://github.com/joaquinolivera/acme-secured-card/actions/runs/41384405357)) | P1 | `terraform plan` needs AWS credentials and was not run; semantic errors that only `plan`/`apply` reveal remain possible |
| Local run is repeatable | **Verified** | `README.md`; compiled server + `npm run demo` against local PostgreSQL; CI job `docker` builds the image, starts compose and runs the demo against the container ([run](https://github.com/joaquinolivera/acme-secured-card/actions/runs/41384405357)) | P2 | None. The CI run also found and fixed a health-check bug (audit F17) |
| GitHub Actions CI | **Executed: 5/5 jobs pass** (after one fix) | `.github/workflows/ci.yml`: quality, test (PostgreSQL service), security, docker, terraform; SHA-pinned actions; `permissions: contents: read`. Run 1 failed in `docker` (F17); run 2 passed all five ([run](https://github.com/joaquinolivera/acme-secured-card/actions/runs/41384405357)) | P2 | Runs only for PRs into `main`: stacked PRs (#2, #3) get CI after retargeting |
| Prompts and AI responses included | **NOT MET.** No transcripts in the repository | `PROMPTS.md`, `ai-logs/`, `npm run check:ai-logs` (currently fails by design) | **P0** | **Owner must export the claude.ai chat(s) into `ai-logs/` and update `PROMPTS.md`** |
| Thinking process / decisions documented | **Implemented** | `docs/architecture.md`, ADRs, `docs/audit.md` | P2 | None |

## Required financial invariants

| Invariant | Status | Where proved |
|---|---|---|
| Card not active before collateral confirmed | Enforced + tested | I1 in `docs/architecture.md` |
| Limit derived from confirmed collateral | Enforced + tested | I2 |
| Available credit never negative | Enforced + tested | I4 |
| Outstanding debt never exceeds the limit | **Partial, by design.** Purchases keep `owed + holds ≤ limit` at authorization time and `principal + held ≤ limit` is DB-enforced; accrued interest and fees can push `owed` above the limit | architecture §4 (deliberate exception), audit F13 |
| Purchase never exceeds available credit | Enforced + tested | I3 |
| Only authorized (and captured) purchases create debt | Enforced + tested | I5 |
| Settled repayments restore credit without exceeding what is owed | Enforced + tested | I6 |
| Duplicates never duplicate effects | Enforced + tested | I7 |
| No release of collateral with debt outstanding except via settlement | Enforced + tested | I8 |
| Collateral applied to debt only once | Enforced + tested | I9 |
| Failed transactions leave no partial state | Enforced + tested | I10 |
| No floats; unsupported currency, invalid amounts, overflow handled | Enforced + tested | architecture §3 |
| Operations traceable and auditable | Enforced + tested | I11, I12 |
