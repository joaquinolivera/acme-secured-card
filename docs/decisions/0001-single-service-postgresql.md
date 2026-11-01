# ADR-0001: One service, one PostgreSQL database

**Status:** accepted

**Context.** The critical operation is "check available credit and place a hold". Collateral, limit, balances and ledger change together and are owned by one team.

**Decision.** One deployable service (modular inside) with PostgreSQL as the single system of record. Other systems are told about changes through a transactional outbox.

**Alternatives rejected.**
* *Several microservices (cards, ledger, billing).* Replaces a single `COMMIT` with a saga or two-phase commit in the exact place that must not fail; adds network hops, partial-failure states and operational cost, with no scaling pressure to justify them.
* *In-memory or SQLite.* Cannot demonstrate row locking, constraints, concurrent writers or multi-instance safety, which is what a lending core must prove.
* *Event sourcing.* Attractive for audit, but the double-entry ledger plus hash-chained audit already gives traceability with far less machinery.

**Consequences.** Simple to reason about and test. Writes scale with one primary (adequate for a card programme of this size; sharding by account is possible later because all contention is per account). A later split along module lines (`billing`, `ledger`) is mechanical.
