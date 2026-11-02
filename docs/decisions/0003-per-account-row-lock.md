# ADR-0003: Per-account row lock for concurrency

**Status:** accepted

**Context.** Two purchases, a repayment and a close can hit the same account at once. The check-then-update on available credit must not interleave.

**Decision.** Every money command takes `SELECT … FROM accounts WHERE id = $1 FOR UPDATE` first, inside one READ COMMITTED transaction, with a fixed lock order (idempotency row → account → child row). Balance changes are relative updates. `CHECK` constraints and triggers back this up. The whole transaction is retried on deadlock/serialization failure.

**Alternatives rejected.**
* *SERIALIZABLE isolation everywhere.* Correct, but produces frequent retryable failures under contention and pushes retry logic into every caller.
* *Optimistic version column.* Needs retries for every conflict; a hot account would retry-storm instead of queueing.
* *Advisory locks.* Equivalent but invisible to the schema and easier to forget.
* *Application mutex.* Wrong the moment there are two API tasks.

**Consequences.** Simple and provably serial per account; different accounts run in parallel. A very hot single account serializes, which is correct for one card. **Evidence:** the 40-parallel-purchase test; with the lock removed the same test fails (and the `CHECK` still prevented overspending). The lock-order rule is a convention enforced by review and the `financial-correctness` skill, not by tooling.
