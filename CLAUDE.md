# Project instructions for Claude

Secured credit card service (collateral -> card -> spending -> repayment -> release). It handles money:
**build the simplest correct solution and make every change verifiable.**

## Engineering principles

1. **Think before coding.** Read the requirement and the code first. Separate facts from assumptions, state trade-offs, ask only about
   ambiguities that change correctness. Never invent requirements.
2. **Simplicity first.** KISS/YAGNI. No new service, dependency or abstraction without a demonstrated need.
3. **Surgical changes.** Touch only what the task requires, keep existing conventions, explain impactful changes, no drive-by refactors.
4. **Goal-driven execution.** Write the acceptance criteria as a test first, run real commands, fix failures instead of weakening checks,
   and **never claim something works unless you executed it**. List what you could not run.

## Financial safety rules (non-negotiable)

1. Money is **integer cents** (`BIGINT` / `number`). No floats. Amounts enter through `centsSchema`; currency is USD only.
2. Any code that changes an account's money runs in **one transaction** (`withTx`), takes the **row lock first** (`lockAccount`), changes
   balances with relative updates, posts a **balanced ledger transaction** (`ledger.post`) and an **audit row** (`audit`), and writes
   outbox events for external effects. Either all of it commits or none.
3. Money-moving `POST`s require `Idempotency-Key` (stored in the same transaction), unless the endpoint is idempotent by state and the
   code says why.
4. `ledger_*` and `audit_log` are **append-only**. Corrections are new compensating entries, never `UPDATE`/`DELETE`.
5. DB `CHECK` constraints and triggers are the last line of defence. **Never weaken one to make a test pass.**
6. Lock order is always: idempotency row -> account row -> child rows (deposit / authorization). Look up a child, lock the account,
   then re-read the child `FOR UPDATE`.
7. Every new money path needs: a happy-path test, a rejection test, a duplicate/retry test, a concurrency test, and a `reconcileOk` call.
8. No secrets in the repo, logs or fixtures. `JWT_SECRET` has no default.

## Commands

```bash
npm ci
npm run verify          # format:check + lint + typecheck + all tests + build (needs PostgreSQL, see README)
npm run test:unit       # pure rules, no DB
npm run check:ai-logs   # AI transparency gate (fails while transcripts are missing)
```

Tests use a real PostgreSQL and wipe the schema of the database in `TEST_DATABASE_URL` (default `acme_test`). The harness refuses
any database name that does not contain "test".

## Git

Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `ci:`, `chore:`). Do not rewrite history. Do not push, create remotes or change
repository visibility without the owner's explicit approval.

## AI transparency (mandatory for this challenge)

The submission needs **every AI prompt and response, in chronological order**, across all tools.

* Keep complete, authentic transcripts in `ai-logs/` and index them in `PROMPTS.md`. Never substitute summaries or reconstructions;
  record gaps openly.
* Claude Code sessions are captured automatically by the hooks in `.claude/settings.json`. Other tools must be exported by hand.
* Scan logs for secrets before committing; disclose any redaction.
* Definition of done: requirements met, checks actually run, minimal diffs, accurate docs, complete AI history (or disclosed gaps).

## Skills (in `.claude/skills/`)

`financial-correctness` (audit money paths), `test-strategy` (risk-based tests), `code-review` (strict review). Use them instead of ad hoc
checklists.
