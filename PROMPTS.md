# AI usage: prompt and transcript index

The challenge requires **every prompt and response, in chronological order, for every AI tool used**. Raw transcripts live in
[`ai-logs/`](ai-logs/). This file is the index and the place where gaps are disclosed. It contains no summaries presented as transcripts.

## Status of each source

| # | Source | When (America/Asuncion) | Status | File |
|---|--------|-------------------------|--------|------|
| 1 | claude.ai Project "Belozfi", chat "Code challenge project review" (context review, clarifying questions, initial implementation, delivery of the first ZIP) <https://claude.ai/chat/fb0779f8-28d7-429e-9ddf-3ad3826190da> | 2026-11-01 from 02:02 | Partial: sanitized Markdown rendering of turns 1-43, provided by the owner (not the raw JSON export; see "Sanitization and coverage" below) | `ai-logs/claude-ai/2026-11-01_code-challenge-project-review.sanitized.md` |
| 2 | Same chat: hardening session (audit, tests, CI, docs; started by the `ai-instructions` attachment prompt) | 2026-11-01 from 11:14 | Partial: included in the same file as row 1 (turns 1-43 in one chronological file) | `ai-logs/claude-ai/2026-11-01_code-challenge-project-review.sanitized.md` |
| 2a | Subagent handoffs for the first TDD slice (ISSUE-001): Test Engineer, Implementation Engineer, Independent Reviewer | 2026-11-01 | Prompts sent and final reports returned are preserved verbatim; the subagents' internal tool calls are NOT available (partial) | `ai-logs/runs/issue-1/slice-1-manual/` |
| 3 | Claude Code CLI sessions | n/a | None used so far. A capture hook is installed for any future session (see below) | none |
| 4 | Other AI tools (IDE copilot, other assistants) | n/a | None reported. Add a row for each one used | none |

**Sanitization and coverage (rows 1 and 2):** the assistant that did the work cannot read its own full transcript from inside the chat, so the
owner provided a file produced from the claude.ai account export. It is **not** the raw JSON and it is **not unmodified**. Its own header says:
sensitive strings are replaced with placeholders (for example `[GITHUB_USERNAME]`, `[REDACTED_JWT_SECRET]`, `[REDACTED_PASSWORD]`,
`[REDACTED_PERSONAL_EMAIL]`), internal IDs, timestamps and hidden thinking are omitted, tool commands and results are historical records that were
not re-run, and attachments and ZIP files are not included. The file was committed byte for byte as received (sha256 prefix `318c82164e62821a`);
nothing was edited in the repository. It contains 43 turns and ends at turn 43, so everything after that point (the rest of the chat, including
the later Dependabot and merge work and the export itself) is **not** in it. The raw export stays with the owner and can be shown on request.

**Gap in history that cannot be recovered by tooling:** the coverage and sanitization limits described above, but the owner should confirm no other AI
tool was used before the first session.

## Capturing future interactions

* **Claude Code:** `.claude/settings.json` registers `scripts/capture-transcript.mjs` on the `Stop` and `SubagentStop` hooks. After every
  response it copies the raw JSONL transcript (and subagent transcripts) to `ai-logs/claude-code/`. Verified only with synthetic hook input
  (copy works, missing files and malformed input never block the session); it has **not** been exercised by a real Claude Code run.
* **Issue-driven AI runs:** `scripts/ai-sdlc/orchestrate.mjs` stores, for every agent turn, the exact prompt, the raw agent output, session id, cost and the commands run, under the folder ai-logs/runs/issue-N/RUN-ID/ (placeholders, not a path). Reference each real run folder once in the table above, in backticks. See `docs/ai-sdlc.md` §7 for what each layer does and does not capture.
* **claude.ai chats:** export manually and save under `ai-logs/claude-ai/` (instructions in `ai-logs/README.md`).
* **Submission gate:** `npm run check:ai-logs` fails while any source is `MISSING`, any transcript file is unindexed here, or no
  transcripts exist. `npm run check:ai-logs -- --allow-gaps` downgrades MISSING rows to warnings for a submission that discloses the gaps.

## How the AI was directed (summary, not a transcript)

The owner supplied the challenge, interview notes and `CLAUDE.md` principles and chose stack and scope from options (TypeScript/Fastify,
PostgreSQL, ledger + audit + freeze/limit-increase + interest/statements/late fees, Terraform on AWS). The assistant was told to ask before
building when requirements were ambiguous, and in the second session to audit before changing anything, fix P0/P1 risks, and never claim
an unexecuted check passed.
