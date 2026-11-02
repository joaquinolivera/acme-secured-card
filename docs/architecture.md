# Architecture

Status: a **working, tested reference implementation**, not a production-ready lending system. Section 12 lists what is simulated and what would change before production.

Related: [financial invariants](#4-financial-model-and-invariants) · [threat model](threat-model.md) · [test strategy](test-strategy.md) · [decisions (ADRs)](decisions/) · [traceability](requirements-traceability.md)

## 1. What the service does

Owns the lending flow of a secured credit card: the customer posts collateral, **confirmed** collateral activates the card and sets the credit limit, purchases are authorized against available credit, settled repayments restore it, and at close the collateral is released or applied to unpaid debt. It also provides a double-entry ledger, a hash-chained audit log, card freeze, limit increase by extra deposit, interest, statements and late fees.

## 2. Shape of the system

```
 customer app ──JWT customer──┐
 card network ──JWT processor─┼─► ALB ─► API (Fastify, N stateless tasks) ─► PostgreSQL 16
 payment rail ──JWT processor─┤              │   one transaction per command      (system of record)
 ops tools    ──JWT ops───────┘              └─ outbox table ──► (relay: not built)
                    scheduler ──► same image, jobs/daily.js (interest, statements, late fees)
```

One deployable service, one database. Modules (`src/services/`): `accounts`, `deposits`, `spending`, `repayments`, `closing`, `billing`; cross-cutting: `ledger`, `idempotency`, `audit`, `money`, `reconcile`.

**Why one service (ADR-0001).** The core safety property is "check available credit and place the hold atomically". That needs a single transactional boundary. Splitting cards, ledger and billing into separate services would replace one `COMMIT` with a saga, adding failure modes exactly where money is at stake, with no scaling need today. Module seams are clean, so a later split is mechanical. Integration with other systems goes through the transactional outbox.

**Why TypeScript.** Strict typing across money paths, `zod` validation at the edge, and fast enough that PostgreSQL is the bottleneck. **Why PostgreSQL.** ACID transactions, row locks, partial unique indexes, `CHECK` constraints and triggers let the *database* enforce invariants independently of application code.

## 3. Money representation

* Integer **cents** (USD only), `BIGINT` in the database, `number` in code. No floats anywhere in money paths.
* Request amounts pass `centsSchema`: positive safe integer, at most `MAX_AMOUNT_CENTS` (default $100,000.00). Fractions, strings, zero, negatives and unknown fields get `400`.
* `currency` is optional on money requests and must be `USD` if present; anything else is `400`. The service never assumes another currency.
* The `pg` driver is configured to **throw** if a `BIGINT` exceeds `Number.MAX_SAFE_INTEGER` instead of silently rounding (tested).
* **Interest** is exact integer arithmetic: daily interest = `principal × APR / 365`; the sub-cent remainder is carried as a numerator over `10000 × 365` in `interest_remainder`, so nothing is lost or invented. One year on $1,000 at 24% is exactly $240.00 (tested). Only principal accrues interest.
* The **payment waterfall** is fees, then interest, then principal. Overpayment is rejected (`422 OVERPAYMENT`); there is no customer credit balance.

## 4. Financial model and invariants

| Concept | Meaning | Where |
|---|---|---|
| Confirmed collateral | Deposits the processor has confirmed, minus anything released or applied | `accounts.collateral_cents` |
| Pending deposit | Announced but not confirmed. **Grants nothing.** | `deposits.status = PENDING` |
| Credit limit | `floor(confirmed collateral × LIMIT_RATIO)`, ratio default 100%, never above collateral | `accounts.credit_limit_cents` |
| Held (pending authorizations) | Credit reserved by approved, not-yet-cleared purchases | `accounts.held_cents`, `authorizations` |
| Outstanding balance (owed) | `principal + interest + fees`; only *captured* purchases create principal | `accounts.principal/interest/fees_cents` |
| Available credit | `max(0, limit − owed − held)` | computed |
| Repayment | Settled funds reported by the processor, with a unique external reference | `repayments` |
| Applied collateral | Collateral used to pay debt on delinquent close | ledger `COLLATERAL_APPLIED` |
| Released collateral | Collateral returned to the customer on close | ledger `COLLATERAL_RELEASE` |

Authorization (a hold) and settlement are separate steps: authorize → capture (debt) for purchases; announce → confirm for deposits; processor-reported settled funds for repayments.

| # | Invariant | Enforced by | Verified by |
|---|---|---|---|
| I1 | A card is `ACTIVE` only with confirmed collateral | `confirmDeposit` is the only activation path; `CHECK active_needs_collateral` | `core`: inactive until confirmed; `concurrency`: DB refuses ACTIVE without collateral |
| I2 | Limit is derived from confirmed collateral and never exceeds it | `limitFor`; `CHECK limit_within_collateral` | `core` activation tests; `unit`; `concurrency` CHECK test |
| I3 | Principal + holds never exceed the limit, even under concurrency | account row lock; `CHECK spend_within_limit` | 40 parallel purchases → exactly 20 approved; exact-limit and one-cent-over cases |
| I4 | Available credit is never negative | floored in `availableCreditCents`; purchases require `amount ≤ available` | `core`, `billing` (liquidation case where owed > limit) |
| I5 | Only captured purchases create debt | `capture` is the only place principal grows | `core` authorize/capture test |
| I6 | A repayment needs settled funds, restores credit, cannot exceed what is owed | processor/ops role, unique `external_ref`, `allocate` | `core`: customer cannot self-report; overpayment `422` |
| I7 | A duplicate operation has one effect | `Idempotency-Key` in the same transaction / idempotent by state / unique external refs | parallel-retry tests for authorize, capture, deposit, repayment |
| I8 | Collateral is released only with zero debt and no holds, except through `liquidate` | `closeAccount`, `liquidateAccount` under the account lock | `core` close tests; `invariants` close-vs-repay, close-vs-purchase races |
| I9 | Collateral is applied to a debt at most once | `liquidate` under lock; `CLOSED` is terminal and rejects a second run | 4 parallel liquidations → one succeeds; liquidation racing a repayment |
| I10 | A failed operation leaves no partial state | one transaction per command (`withTx`) | `invariants`: exception after money moved leaves zero rows changed |
| I11 | Books balance: every ledger transaction nets to zero; cached balances equal the ledger | ledger deferred trigger; `reconcile` | `reconcileOk` at the end of money tests; unbalanced-commit test |
| I12 | History cannot be rewritten undetected | append-only triggers; per-account hash chain | tamper test (privileged edit is detected) |

**Deliberate exception to "debt never exceeds the limit".** Purchases are checked so that `owed + holds ≤ limit` at authorization time, and `principal + holds ≤ limit` is database-enforced. After that, **accrued interest and late fees can push total owed above the limit, and above the collateral**. Refusing to accrue them would be wrong. The remaining credit risk is handled by `liquidate` (apply collateral, write off the shortfall; see the billing test) and reduced by setting `LIMIT_RATIO_BPS` below 100% to leave headroom. With the default 100% ratio, a fully drawn account that stops paying will cost the lender money.

## 5. Transactions and concurrency (ADR-0003)

Every command runs in one PostgreSQL transaction (`withTx`, READ COMMITTED). Before any decision it takes the **per-account row lock** (`SELECT … FROM accounts WHERE id = $1 FOR UPDATE`). That serializes all money changes for one account and turns "read available credit, then place the hold" into a race-free step. Different accounts do not block each other.

* **Lock order** is fixed: idempotency row → account row → child row (deposit/authorization). Children are looked up, the account is locked, then the child is re-read `FOR UPDATE`. Capture-versus-void on one authorization therefore cannot both win or deadlock.
* `withTx` retries the whole unit on `40001`/`40P01` as a safety net.
* Balances change with relative updates (`x = x + $n`), never read-modify-write from the application.
* No in-process mutex guards money, so any number of API tasks can run.

Observed behaviour with the lock deliberately removed (mutation check, 3 runs): still exactly 20 of 40 purchases approved and final held = limit (the `CHECK` held), but 8–9 of the rejected requests surfaced as `409 INVARIANT_VIOLATION` instead of a clean `402` decline. With the lock: 20 approved, 20 cleanly declined. So the lock gives correct behaviour; the constraint gives safety if the lock were ever missed.

## 6. Idempotency (ADR-0004)

Three mechanisms, each used where it fits:

1. **`Idempotency-Key` header** on customer/processor commands (open account, deposit request, authorize, capture, void, freeze, close, liquidate). The key is scoped to the authenticated caller and stored with a hash of method, route, params and body, **inside the same transaction** as the business change. Concurrent duplicates block on the unique index and then replay the stored response (`Idempotent-Replayed: true`). The same key with a different payload is `422`. A request that fails rolls back, key included, so the client can retry. A decline (`402`) is a recorded outcome and is replayed.
2. **Idempotent by state** for processor webhooks (deposit confirm/fail): re-delivery returns the same result, a conflicting detail is `409`.
3. **Unique external reference** for settled money (`deposits.external_ref`, `repayments.external_ref`): one real-world payment can be applied at most once, whatever idempotency key accompanies a retry, and even if it arrives for two accounts at the same time.

## 7. Ledger, audit and events (ADR-0005)

* **Double-entry, append-only.** Each movement is one `ledger_transaction` with at least two entries; debits equal credits, checked in code and by a deferred constraint trigger at commit. `UPDATE`, `DELETE` and `TRUNCATE` on ledger, audit and repayments are blocked by triggers.
* Cached balances on `accounts` serve fast authorization; `reconcile` proves they equal the ledger, that held credit equals open authorizations, that the global trial balance is zero, and that every audit chain is intact. Statements are computed from the ledger.
* **Audit log** rows are written in the same transaction as the change and hash-chained per account (`sha256(prev | account | actor | action | canonical details)`). A privileged attacker who edits a row is detected; one who recomputes the whole chain is not, which is why anchoring the chain head in write-once storage is listed under production work.
* **Outbox**: events (`deposit.confirmed`, `card.activated`, `payout.requested`, …) are committed atomically with the state change. The relay to a bus is not built.

| Event | Debit | Credit |
|---|---|---|
| Deposit confirmed | `cash` | `collateral_liability` |
| Purchase captured | `receivable_principal` | `merchant_payable` |
| Repayment | `cash` | `receivable_fees` / `_interest` / `_principal` |
| Daily interest | `receivable_interest` | `interest_income` |
| Late fee | `receivable_fees` | `fee_income` |
| Collateral applied | `collateral_liability` | `receivable_*` |
| Shortfall write-off | `bad_debt_expense` | `receivable_*` |
| Collateral released | `collateral_liability` | `cash` |

## 8. Account lifecycle

```
PENDING_COLLATERAL ──confirmed collateral ≥ minimum──► ACTIVE ⇄ FROZEN
                                                          │
                       close (debt 0, no holds)  /  liquidate (ops, needs an OVERDUE statement)
                                                          ▼
                                                       CLOSED (terminal)
```

* Extra confirmed deposits on an active card raise the limit (limit increase). The limit does not decrease while the account is open.
* **Freeze** blocks new authorizations but allows repayments and clearing of earlier holds; interest keeps accruing. An ops freeze can only be lifted by ops.
* **Close** requires zero debt, no open holds, no pending deposit, and releases all collateral. **Liquidate** (ops, only after an overdue statement) voids holds, applies collateral to fees → interest → principal, writes off any shortfall, releases the surplus.

## 9. Billing

Interest accrues daily on principal (APR default 24%). A statement is issued every 30 days; totals come from the ledger. Minimum due is 10% of the balance, floor $25, capped at the balance; due 21 days after the statement. If payments in `(statement date, due date]` are below the minimum, **one** $15 late fee is charged and the statement is `OVERDUE`; reaching the minimum later clears the status (the fee stays). The daily job runs per account in its own transaction, day by day (accrue → statement → late fee), and is safe to run concurrently or repeatedly (tested). Business dates are UTC.

## 10. Horizontal scaling

The API is stateless; any number of tasks can run behind the load balancer because correctness lives in PostgreSQL (row locks, constraints, unique indexes). Contention exists only per account. Connection count is `tasks × POOL_MAX` and must stay under the database limit (use RDS Proxy or PgBouncer beyond a few dozen tasks). Writes scale with the primary; read replicas are not used because reads of balances must be current.

## 11. Deployment on AWS (IaC; validated in CI, never applied)

`infra/terraform/`: VPC with two AZs and a NAT, ALB with a TLS 1.3 policy, ECS Fargate service (circuit breaker with rollback, CPU autoscaling, 30 s drain), RDS PostgreSQL 16 Multi-AZ with encryption, 14-day point-in-time recovery and deletion protection, Secrets Manager entries injected by ECS, CloudWatch logs, an EventBridge Scheduler entry for the daily job, a one-off `migrate` task, and an alarm on invariant violations.

Release flow: build image → push to ECR → run the `migrate` task → update the service (rolling, health-checked on `/readyz`, automatic rollback). Migrations must be backward compatible with the previous version because old and new tasks overlap.

> **Verification status:** the CI `terraform` job runs `terraform fmt -check` and `terraform validate` against the real AWS provider and passes ([run](https://github.com/joaquinolivera/acme-secured-card/actions/runs/41384405357)). `terraform plan` and `apply` were never run (no AWS credentials), so semantic problems that only a plan reveals remain possible. Nothing was applied to AWS.

## 12. Simulated boundaries and what changes before production

Simulated, and **not** proof of real-world settlement:

* **Payment processor / card network / payment rail.** Deposits, authorizations, captures and repayments are posted by callers with the `processor` role. No real funds move.
* **Payout of released collateral.** `close` posts the ledger entry and a `payout.requested` outbox event; no payout is executed. In production, post to a "payout in transit" account and settle on the rail's confirmation.
* **Identity.** HS256 tokens signed with a shared secret (`npm run token`).

Before production: asymmetric JWT validation against the company IdP (JWKS) and mTLS or signed webhooks for the processor; the outbox relay; two-phase repayments with returns/NSF/chargeback reversals; refunds, disputes and multi-capture; idempotency-key retention job; rate limiting/WAF; anchoring the audit chain head in write-once storage; `reconcile` on a schedule with paging; backup restore drills; load testing; a security review and compliance work appropriate to lending (KYC/AML, statements regulation, data retention).

## 13. Known limitations

* Single currency (USD). Business dates are UTC.
* Merchant refunds, chargebacks, disputes and partial multi-capture are not modelled.
* Interest uses the principal at job-run time, so the job must run daily to be exact; a catch-up run after an outage uses the current balance.
* A deposit confirmed for an already-closed account returns `409` and needs an ops refund (closing is blocked while a deposit is pending, so this requires a processor anomaly).
* The simulated-time override (`ALLOW_SIMULATED_TIME`) exists only for tests and demos; the service refuses to start with it when `NODE_ENV=production`.
* **Unbounded reads:** `/transactions`, `/audit` and `/statements` return every row for the account (no pagination). Fine for the expected size, a problem for a long-lived busy account.
* **Linear batch work:** the daily job processes accounts one after another and `reconcile` scans every account. At scale, shard the job by account id and run `reconcile` incrementally.
* **Accrual timing:** the job accrues interest for a date when it runs on that date (00:30 UTC), on the principal at that moment. This is a modelling choice, not a regulatory-grade day-count convention.
* No CORS, security headers or WAF: the API is machine-to-machine behind a load balancer.
