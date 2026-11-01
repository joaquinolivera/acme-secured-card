# ADR-0006: Repayments are settled funds reported by the processor

**Status:** accepted (changed during the audit; see `docs/audit.md` finding F1)

**Context.** The first implementation let the **customer** call `POST /repayments`, which instantly restored their credit. Nothing proved money had arrived. That conflates a customer's claim with external settlement and is a direct route to free credit.

**Decision.** Only the `processor` (or `ops` for manual adjustments) can record a repayment, and each carries a unique `externalRef`. Re-delivery of the same reference returns the original result; reuse with different details is `409`. How the customer initiates a payment is outside this service.

**Alternatives rejected.**
* *Two-phase repayments (pending → confirmed) like deposits.* The right shape once returns, NSF and chargebacks matter, but today it adds states and endpoints without changing the core guarantee. Listed as pre-production work.
* *Keep customer-initiated and trust the call.* Unsafe.

**Consequences.** Credit is restored only on a processor-asserted settlement. A compromised processor credential could still report fake payments (see threat model T14/T15). Reversals of settled repayments are not modelled.
