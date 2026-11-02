# Threat model

Scope: this service and its database. Out of scope: the customer app, the card network and payment rail internals, the identity provider. "Tested" means a test in this repository exercises it; "Designed" means it is in the infrastructure code or design but not exercised here.

## Assets

1. **Money state**: collateral, limits, balances, ledger. Loss or inflation is direct financial loss.
2. **Audit trail**: needed to explain and defend every money movement.
3. **Customer identity and account data**: an opaque customer id and balances; no card numbers, names or contact data are stored.
4. **Secrets**: JWT signing secret, database credentials.

## Actors and trust

| Actor | Token role | Trusted to |
|---|---|---|
| Customer | `customer` | read and operate **only their own** account; request deposits; freeze; close |
| Processor (card network + payment rail) | `processor` | authorize/capture/void; confirm deposits; report settled repayments. A compromised processor credential is the highest-impact threat |
| Ops | `ops` | freeze/unfreeze any account, liquidate, run the daily job, read audit, reconcile |

Trust boundary: everything arriving over HTTP is untrusted until the bearer token is verified and the route's role list admits it.

## Threats and mitigations

| # | Threat | Mitigation | Status |
|---|---|---|---|
| T1 | Customer claims a repayment they never made to restore their credit | Customers cannot call the repayment endpoint (403); repayments are processor/ops-reported with a unique external reference | Tested |
| T2 | One real payment/deposit applied twice (retry, replay, two accounts at once) | `UNIQUE external_ref`; idempotent-by-state webhooks; `Idempotency-Key` in the same transaction | Tested, including parallel and cross-account races |
| T3 | Overspend through parallel purchases | Account row lock; `CHECK spend_within_limit` as a backstop | Tested (40 parallel; lock-removal mutation) |
| T4 | Reading or acting on another customer's account (IDOR) | Ownership checked on every route; foreign ids return 404 so existence is not revealed | Tested for every customer endpoint |
| T5 | Privilege escalation (customer calling processor/ops routes) | Role list per route | Tested (403s) |
| T6 | Forged, tampered, expired, wrong-audience, wrong-issuer, `alg=none` or unknown-role tokens | HS256 pinned, issuer/audience/expiry/role verified | Tested. Shared-secret signing is a dev simplification (see T14) |
| T7 | Malformed or hostile input (floats, huge numbers, unknown fields, SQL fragments, oversized bodies) | Strict `zod` schemas, UUID path validation, 16 KB body limit, parameterized SQL only | Tested for numeric and field validation; no string-built SQL exists |
| T8 | Rewriting history (editing ledger or audit rows) | Append-only triggers; hash chain; `reconcile` | Tested, including a privileged edit being detected. A full-chain recomputation by a DB superuser is **not** detected (see T13) |
| T9 | Money created or destroyed by a bug | Balanced-transaction deferred trigger; `CHECK` constraints; `reconcile` | Tested |
| T10 | Information leakage in errors and logs | Uniform error shape, no stack/SQL in responses, `Authorization` header redacted from logs | Tested for response bodies; log redaction configured, not asserted |
| T11 | Secrets in the repository | No default for `JWT_SECRET` (service refuses to start without a ≥32-char secret); `.env.example` has no value; gitleaks in CI over full history | Tested (config); the CI gitleaks job passes over the full history ([run](https://github.com/joaquinolivera/acme-secured-card/actions/runs/41384405357)) |
| T12 | Simulated-time override abused to post arbitrary billing dates | Off by default; process refuses to start with it when `NODE_ENV=production`; also requires the ops role | Tested |
| T13 | Audit chain recomputed by an attacker with full database control | Not mitigated in code. Mitigation: periodically anchor the chain head in S3 Object Lock | Designed only |
| T14 | Shared-secret JWT compromise lets anyone mint any role | Not mitigated in code. Mitigation: IdP-issued RS256/ES256 tokens verified via JWKS; mTLS for the processor | Designed only |
| T15 | Replay of a captured webhook request | Idempotent-by-state and unique references make replays harmless for money. No request signing or timestamp window | Partially mitigated |
| T16 | Denial of service (request floods, expensive endpoints) | Body limit; per-account locking prevents one account starving others. No rate limiting | **Not implemented**; belongs at WAF/ALB |
| T17 | Database or task compromise | Private subnets, security groups ALB → app → DB only, encryption at rest, Secrets Manager, empty task IAM role | Designed only; not applied |
| T18 | Vulnerable dependencies | `npm audit` (prod and dev) in CI; Dependabot for npm, Actions and Docker; pinned Action SHAs | 0 vulnerabilities locally and in the CI `security` job ([run](https://github.com/joaquinolivera/acme-secured-card/actions/runs/41384405357)) |

## Residual risks, stated plainly

* Processor credential compromise (T14/T15) can confirm fake deposits or repayments. The controls above limit damage to what a processor may do, and the audit trail records it, but they do not prevent it.
* No rate limiting (T16).
* The audit chain does not defend against a database superuser (T13).
* Everything marked "Designed only" is unverified by execution.
