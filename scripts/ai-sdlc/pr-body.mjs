#!/usr/bin/env node
// Builds the draft-PR description from an orchestrator result. Usage: node pr-body.mjs result.json <issue-number>
// Issue text is never interpolated here: only the run record's own fields (status, run id, review findings) are used.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function prBody(result, issueNumber) {
  const findings = result.review ?? [];
  const esc = (s) => String(s ?? '').replace(/[|\r\n]/g, ' ');
  const table = findings.length
    ? `| Severity | File | Finding |\n|---|---|---|\n${findings.map((f) => `| ${esc(f.severity)} | \`${esc(f.file)}\` | ${esc(f.summary)} |`).join('\n')}`
    : '_The reviewer reported no findings._';
  return `Closes #${issueNumber}

**AI-assisted draft. A human must review and approve before merge. The workflow never merges.**

| | |
|---|---|
| Run | \`${esc(result.runId)}\` |
| Status | ${esc(result.status)} |
| Branch | \`${esc(result.branch)}\` |

Commits follow RED → GREEN → record: the first commit adds the failing test, the second the smallest fix, the last stores the run record (prompts, agent outputs, commands and results) under \`ai-logs/runs/issue-${Number(issueNumber)}/${esc(result.runId)}/\`.

### Independent review findings
${table}

### Reviewer checklist
- [ ] The test fails without the fix (RED commit) and passes with it
- [ ] Financial invariants and transaction boundaries preserved
- [ ] Only files relevant to the issue changed
- [ ] CI is green (see note: PRs opened by \`GITHUB_TOKEN\` do not start CI by themselves; push an empty commit or reopen the PR)
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.stdout.write(prBody(JSON.parse(readFileSync(process.argv[2], 'utf8')), process.argv[3]));
}
