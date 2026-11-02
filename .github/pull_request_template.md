## What and why

<!-- One or two sentences. Link the requirement or defect this addresses. -->

## Financial-safety checklist

- [ ] Money is integer cents; no floats introduced
- [ ] Any balance change happens under the account row lock, in one transaction, with its ledger entry and audit row
- [ ] New money-moving endpoint requires `Idempotency-Key` (or is idempotent by state, and says why)
- [ ] `reconcile` still passes in the affected tests
- [ ] New failure paths are tested (not only the happy path)
- [ ] No secrets, tokens, or real customer data added

## AI assistance

- [ ] Not AI-assisted, or:
- AI run id (`ai-logs/runs/issue-N/<run-id>/`): <!-- from the PR body or run.json -->
- [ ] I read the diff myself; the independent review had no unresolved P0
- [ ] Transcripts are indexed in `PROMPTS.md` (`npm run check:ai-logs`)

## Verification

<!-- Paste the real output of `npm run verify` (format, lint, typecheck, tests, build). -->

## Risks / trade-offs
