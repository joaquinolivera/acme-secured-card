# ADR-0005: Double-entry ledger, hash-chained audit, transactional outbox

**Status:** accepted

**Context.** Cached balances answer "can this purchase proceed?" quickly, but they can drift if a bug writes one without the other. Reviewers and auditors need to reconstruct what happened.

**Decision.**
* Every money movement is one balanced, append-only ledger transaction. Cached balances are updated in the same transaction and **reconciled** against the ledger (`GET /v1/admin/reconcile`). Statements read the ledger.
* Every state change writes an audit row, hash-chained per account, in the same transaction.
* External effects (payout requests, events) are written to an `outbox` table in the same transaction.

**Alternatives rejected.**
* *Balances only (no ledger).* No independent proof that balances are right.
* *Ledger only (derive every balance by summing).* Slower authorization path and more locking on the hot path.
* *Publish events directly to a bus inside the request.* A crash between commit and publish loses or invents events.
* *External WORM audit service now.* Right for production; out of scope here. The chain head can be anchored later.

**Consequences.** Two sources of truth that are continuously checked against each other. The outbox relay is not built. The hash chain detects edits but not a full recomputation by a database superuser.
