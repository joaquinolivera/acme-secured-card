# Interview preparation notes

For the live-coding round: 10 minutes of questions on this solution, then 50 minutes fixing a ticket in existing code. Everything below is checkable in the repository.

## The 60-second version

"One service and one PostgreSQL database, because the safety-critical step is *check credit and place a hold atomically* and I want it to be a single transaction rather than a saga. Every money command takes a per-account row lock, writes the balance change, a balanced ledger entry and an audit row in the same transaction, and is idempotent. The database backs the code up with CHECK constraints, append-only triggers and a deferred balance check, so a bug in my code can't overspend or rewrite history. The tests were checked by removing protections one at a time and watching specific tests fail."

## Decisions you should be able to defend

| Question they may ask | Short answer | Where |
|---|---|---|
| Why not microservices? | The invariant spans collateral, limit and balance; splitting it needs a saga for no scaling gain. Module seams allow a later split | ADR-0001 |
| How do you stop two purchases overspending? | `SELECT … FOR UPDATE` on the account row before checking available credit; relative updates; CHECK `principal + held ≤ limit` as backstop | ADR-0003, `lockAccount` |
| Why not SERIALIZABLE? | Retry storms on a hot account and retry logic everywhere; row lock queues instead | ADR-0003 |
| How is idempotency exactly-once? | Key row inserted in the same transaction as the effect; duplicates block on the unique index then replay; failure rolls the key back | ADR-0004, `idempotent()` |
| What if the same payment arrives twice with different keys? | `external_ref` is UNIQUE; same details replay, different details 409 | `repay`, `confirmDeposit` |
| Why integer cents? Why is interest exact? | No float error; remainder carried as a numerator so a year of tiny daily amounts sums exactly | ADR-0002, `dailyInterest` |
| How do you know balances are right? | Double-entry ledger; `reconcile` compares cached balances, holds, trial balance, audit chain | ADR-0005 |
| What stops history being rewritten? | Append-only triggers + hash chain; a DB superuser who recomputes the chain is *not* detected (say so) | threat model T8/T13 |
| Why can a customer not repay directly? | A claim isn't settlement. Processor-reported, unique reference. The first AI-assisted version had this bug; the audit caught it | ADR-0006, audit F1 |
| What is simulated? | Processor, payout execution, identity. No real money or rails | architecture §12 |
| Can debt exceed the limit? | Not through purchases; interest and fees can push owed above limit and even collateral. `liquidate` writes off the shortfall; set the ratio below 100% for headroom | architecture §4 |

## Likely live-coding tickets and where to start

* **Add a new money operation** (e.g. partial collateral withdrawal): copy the shape of `closeAccount`: `withTx` → `lockAccount` → checks → `applyDelta` → `ledger.post` → `audit` → `emit`; add a `CHECK`-safe invariant; tests per `CLAUDE.md` rule 7.
* **Change a rule** (late fee, minimum payment, limit ratio): `config.ts` + `billing.ts`; tests use `setNow`/`runJob`.
* **Fix a race**: write the failing parallel test first (`Promise.all`), then look at lock order.
* **Add an endpoint**: `mutate()` in `app.ts` handles auth, validation, idempotency and the transaction; you supply the service function.
* **Debug a reconcile discrepancy**: `GET /v1/admin/reconcile` names the account and the check; compare `ledger_entries` with the cached column.

## Commands to have ready

```bash
npm run verify                 # everything: format, lint, types, tests, build
npx vitest run test/concurrency.test.ts
npm run demo                   # end-to-end walkthrough (server running)
```

## Be ready to admit

* Docker, Terraform and the CI workflow could not run in my build environment. The first GitHub CI run found a real bug (the container health check used `localhost`, which Alpine resolves to IPv6); it was fixed and the second run passed all five jobs. Say so plainly: it shows why CI matters. `terraform plan/apply` were still never run.
* The AI transcripts were not exportable from inside the session; you export them (see `PROMPTS.md`).
* No load tests, no coverage number, no rate limiting, HS256 dev tokens.
* The first AI-assisted version had real defects that the audit caught and fixed (F1 customer-asserted repayments, F3 audit hashing, wrong claims in its own summary). Say so plainly, and say how you directed the AI: audit before changing, tests first, mutation checks, never claim an unrun check. That is the "directing AI" the challenge asks to see.
