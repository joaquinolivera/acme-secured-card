# ADR-0004: Idempotency

**Status:** accepted

**Context.** Clients and processors retry. A retried command must not move money twice, including when retries race.

**Decision.** Three mechanisms by case:
1. `Idempotency-Key` header for commands: the key and a hash of the request are stored **in the same transaction** as the effect; concurrent duplicates block on the unique index and replay the stored response; a different payload under the same key is `422`; a failed request rolls back the key too.
2. Idempotent by state for webhooks (deposit confirm/fail).
3. Unique external references for settled money (`deposits.external_ref`, `repayments.external_ref`), so one real payment applies once even under different keys or accounts.

**Alternatives rejected.**
* *Redis or a separate store for keys.* Cannot be atomic with the database effect; a crash between the two reopens the window.
* *Reject duplicates instead of replaying.* Forces clients to handle a conflict for what is a success; replay is friendlier and standard.
* *Keys for everything.* Webhooks already carry a natural unique reference; an extra key adds nothing.

**Consequences.** Exactly-once effect per key. Keys live forever until a retention job is added (not built; listed in limitations). A decline is replayed as a decline.
