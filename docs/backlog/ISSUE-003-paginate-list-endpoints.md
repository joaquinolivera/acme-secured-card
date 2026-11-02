---
id: ISSUE-003
title: "Paginate transactions, audit and statements endpoints"
priority: P1
type: enhancement
ai_ready: true
---
## Problem statement
`GET /v1/accounts/:id/transactions`, `/audit` and `/statements` return every row. A long-lived account makes responses unbounded in size and database work.

## Requirement reference
R-22 (API contracts) in `docs/tdd-matrix.md`; `docs/architecture.md` §13 "Unbounded reads".

## Evidence
- `src/app.ts` list queries (`ledger_transactions`, `audit_log`) have `ORDER BY` and no `LIMIT`.
- `src/services/billing.ts` `listStatements` has no `LIMIT`.
- `grep -n "limit\|cursor\|offset" src/app.ts` matches only `bodyLimit`.

## Scope
Keyset pagination with `limit` (default 50, max 200) and an opaque `cursor`; responses include `nextCursor`.

## Non-goals
Filtering, sorting options, changes to stored data or to money paths.

## Acceptance criteria
- [ ] Default page size is 50; `limit` above 200 or below 1 is `400`.
- [ ] Following `nextCursor` returns every row exactly once, in the original order, with no duplicates when rows are added between requests.
- [ ] A cursor from another account is rejected.
- [ ] Existing clients that ignore `nextCursor` still receive the first page.

## Required tests
Integration tests with more than one page of rows, boundary sizes, invalid limits, cross-account cursor.

## Dependencies
None. Changes the response shape additively (`nextCursor`), so call out in the PR.

## Definition of Done
RED→GREEN for each criterion; `docs/architecture.md` §13 updated; review without open P0; `npm run verify` green.
