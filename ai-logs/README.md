# AI session logs

Put **complete, unedited** transcripts here, one file per session or tool, and list each file in `../PROMPTS.md` (the gate checks this).

```
ai-logs/
  claude-code/   raw JSONL written automatically by the Stop/SubagentStop hook (scripts/capture-transcript.mjs)
  claude-ai/     manual exports of claude.ai chats (e.g. 2026-11-01_code-challenge-project-review.md)
  other/         any other tool
```

## Exporting claude.ai chats

Use the account data export in claude.ai settings (or copy the full thread) and save it unmodified. The chat for this project is
`https://claude.ai/chat/fb0779f8-28d7-429e-9ddf-3ad3826190da`. Export it again after the last message so the file is complete.

## Before committing

1. Scan for secrets: `gitleaks dir ai-logs --redact` (or let the CI `security` job scan the history).
2. If you redact anything, say so in `PROMPTS.md`. Do not silently edit a transcript.
3. Run `npm run check:ai-logs`.
