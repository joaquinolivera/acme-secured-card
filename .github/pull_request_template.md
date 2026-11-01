## What and why

<!-- One or two sentences. Link the requirement or defect this addresses. -->

## Financial-safety checklist

- [ ] Money is integer cents; no floats introduced
- [ ] Any balance change happens under the account row lock, in one transaction, with its ledger entry and audit row
- [ ] New money-moving endpoint requires `Idempotency-Key` (or is idempotent by state, and says why)
- [ ] `reconcile` still passes in the affected tests
- [ ] New failure paths are tested (not only the happy path)
- [ ] No secrets, tokens, or real customer data added

## Verification

<!-- Paste the real output of `npm run verify` (format, lint, typecheck, tests, build). -->

## Risks / trade-offs
