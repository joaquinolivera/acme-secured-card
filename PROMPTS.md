# AI usage: prompt and transcript index

The challenge requires **every prompt and response, in chronological order, for every AI tool used**. Raw transcripts live in
[`ai-logs/`](ai-logs/). This file is the index and the place where gaps are disclosed. It contains no summaries presented as transcripts.

## Status of each source

| # | Source | When (America/Asuncion) | Status | File |
|---|--------|-------------------------|--------|------|
| 1 | claude.ai Project "Belozfi", chat "Code challenge project review" (context review, clarifying questions, initial implementation, delivery of the first ZIP) <https://claude.ai/chat/fb0779f8-28d7-429e-9ddf-3ad3826190da> | 2026-11-01 from 02:02 | MISSING (not exported yet) | none |
| 2 | Same chat: hardening session (audit, tests, CI, docs; started by the `ai-instructions` attachment prompt) | 2026-11-01 from 11:14 | MISSING (not exported yet) | none |
| 2a | Subagent handoffs for the first TDD slice (ISSUE-001): Test Engineer, Implementation Engineer, Independent Reviewer | 2026-11-01 | Prompts sent and final reports returned are preserved verbatim; the subagents' internal tool calls are NOT available (partial) | `ai-logs/runs/issue-1/slice-1-manual/` |
| 3 | Claude Code CLI sessions | n/a | None used so far. A capture hook is installed for any future session (see below) | none |
| 4 | Other AI tools (IDE copilot, other assistants) | n/a | None reported. Add a row for each one used | none |

**Why rows 1 and 2 are MISSING:** the assistant that did the work runs inside a claude.ai chat and has no access to its own full transcript.
The only retrieval tool available to it returned just the first turn of the chat and truncated the rest, without tool calls, so a faithful
export could not be produced from inside the session. Rebuilding the conversation from memory would be a reconstruction, which the
challenge forbids presenting as verbatim. The owner must export the chat (see `ai-logs/README.md`) and replace the `MISSING` rows with
the file names.

**Gap in history that cannot be recovered by tooling:** none known beyond the two rows above, but the owner should confirm no other AI
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
