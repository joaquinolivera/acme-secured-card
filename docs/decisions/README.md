# Architecture decision records

Short records of decisions that are costly to reverse or that a reviewer will ask about. Format: context, decision, alternatives rejected, consequences.

| ADR | Decision |
|---|---|
| [0001](0001-single-service-postgresql.md) | One service, one PostgreSQL database |
| [0002](0002-integer-cents-and-exact-interest.md) | Integer cents; exact integer interest |
| [0003](0003-per-account-row-lock.md) | Per-account row lock for concurrency |
| [0004](0004-idempotency.md) | Idempotency: keys in the same transaction, plus state and external references |
| [0005](0005-ledger-audit-outbox.md) | Double-entry ledger, hash-chained audit, transactional outbox |
| [0006](0006-settled-repayments-from-processor.md) | Repayments are settled funds reported by the processor |
| [0007](0007-toolchain-pins.md) | Toolchain pins (TypeScript 6.0, minimatch override) |
