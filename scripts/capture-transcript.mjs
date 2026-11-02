#!/usr/bin/env node
// Claude Code hook for `Stop` and `SubagentStop`: copies the raw session transcript (JSONL) into
// ai-logs/claude-code/ so the challenge's "every prompt and response" requirement is met automatically.
// The transcript is cumulative, so the latest copy always supersedes earlier ones (same file name).
// This script never blocks the session: failures are reported on stderr and the exit code stays 0.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const outDir = path.join(root, 'ai-logs', 'claude-code');
  mkdirSync(outDir, { recursive: true });

  const session = String(input.session_id ?? 'unknown-session').replace(/[^\w.-]/g, '_');
  const copies = [];
  if (input.transcript_path) copies.push([input.transcript_path, `${session}.jsonl`]);
  if (input.agent_transcript_path) {
    copies.push([input.agent_transcript_path, `${session}__subagent-${path.basename(input.agent_transcript_path)}`]);
  }
  if (copies.length === 0) console.error('capture-transcript: hook input had no transcript path');
  for (const [src, name] of copies) {
    if (!existsSync(src)) {
      console.error(`capture-transcript: transcript not found: ${src}`);
      continue;
    }
    copyFileSync(src, path.join(outDir, name));
  }
} catch (err) {
  console.error(`capture-transcript: ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(0);
