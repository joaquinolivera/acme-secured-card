#!/usr/bin/env node
// Backlog planning: validates the AI-drafted specs in docs/backlog/, compares them with existing issues and PRs,
// and writes a plan. It publishes nothing (see publish-issues.mjs, which a human approves).
// Usage: node scripts/ai-sdlc/plan-backlog.mjs [--existing existing.json] [--out plan.json] [--summary summary.md]
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findDuplicate, parseBacklogFile, validateSpec } from './lib.mjs';

export function fetchExisting(gh = process.env.GH_BIN ?? 'gh') {
  const list = (kind) =>
    JSON.parse(
      execFileSync(gh, [kind, 'list', '--state', 'all', '--limit', '500', '--json', 'number,title,body,state'], { encoding: 'utf8' }),
    );
  return [...list('issue'), ...list('pr')];
}

export function plan(root, existing) {
  const dir = path.join(root, 'docs', 'backlog');
  const entries = readdirSync(dir)
    .filter((f) => /^ISSUE-\d{3}.*\.md$/.test(f))
    .sort()
    .map((file) => {
      let spec;
      try {
        spec = parseBacklogFile(readFileSync(path.join(dir, file), 'utf8'));
      } catch (e) {
        return { file, status: 'invalid', problems: [String(e.message)] };
      }
      const problems = validateSpec(spec, root);
      const base = {
        file,
        id: spec.meta.id,
        title: spec.meta.title,
        priority: spec.meta.priority,
        type: spec.meta.type,
        aiReady: spec.meta.ai_ready === 'true',
      };
      if (problems.length) return { ...base, status: 'invalid', problems };
      const dup = findDuplicate(spec, existing);
      return dup
        ? { ...base, status: 'duplicate', duplicateOf: { number: dup.number, title: dup.title, reason: dup.reason } }
        : { ...base, status: 'new' };
    });
  return { generatedAt: new Date().toISOString(), entries };
}

export function summarize(p) {
  const rows = p.entries.map(
    (e) =>
      `| ${e.id ?? e.file} | ${e.priority ?? ''} | ${e.title ?? ''} | **${e.status}**${e.duplicateOf ? ` (#${e.duplicateOf.number}: ${e.duplicateOf.reason})` : ''}${e.problems ? `<br>${e.problems.join('<br>')}` : ''} |`,
  );
  return `## Proposed backlog\n\n| Id | Priority | Title | Result |\n|---|---|---|---|\n${rows.join('\n')}\n\nNothing has been published. Approve the \`publish\` job to create the **new** issues.\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const existingFile = arg('existing');
  const existing = existingFile ? JSON.parse(readFileSync(existingFile, 'utf8')) : fetchExisting();
  const p = plan(process.cwd(), existing);
  writeFileSync(arg('out', 'plan.json'), `${JSON.stringify(p, null, 2)}\n`);
  const md = summarize(p);
  writeFileSync(arg('summary', 'plan-summary.md'), md);
  console.log(md);
  process.exit(p.entries.some((e) => e.status === 'invalid') ? 1 : 0);
}
