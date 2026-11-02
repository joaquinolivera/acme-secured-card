#!/usr/bin/env node
// Creates GitHub issues for the entries a human approved. Re-checks for duplicates immediately before creating, never adds
// `ai-ready` (a human does that after reading the issue), and supports --dry-run.
// Usage: node scripts/ai-sdlc/publish-issues.mjs --plan plan.json [--dry-run]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LABELS, findDuplicate, issueBody, labelsFor, parseBacklogFile } from './lib.mjs';
import { fetchExisting } from './plan-backlog.mjs';

export function publish(root, planJson, { dryRun = false, gh = process.env.GH_BIN ?? 'gh', existing = null } = {}) {
  const run = (...args) => execFileSync(gh, args, { encoding: 'utf8' });
  const known = existing ?? fetchExisting(gh);
  const results = [];
  if (!dryRun) for (const l of LABELS) run('label', 'create', l.name, '--color', l.color, '--description', l.description, '--force');
  for (const e of planJson.entries.filter((x) => x.status === 'new')) {
    const spec = parseBacklogFile(readFileSync(path.join(root, 'docs', 'backlog', e.file), 'utf8'));
    const dup = findDuplicate(spec, known);
    if (dup) {
      results.push({ id: e.id, action: 'skipped-duplicate', number: dup.number });
      continue;
    }
    const args = [
      'issue',
      'create',
      '--title',
      spec.meta.title,
      '--body',
      issueBody(spec),
      ...labelsFor(spec).flatMap((l) => ['--label', l]),
    ];
    if (dryRun) results.push({ id: e.id, action: 'would-create', labels: labelsFor(spec) });
    else {
      const url = execFileSync(gh, args, { encoding: 'utf8' }).trim();
      known.push({ number: -1, title: spec.meta.title, body: issueBody(spec) });
      results.push({ id: e.id, action: 'created', url });
    }
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const i = process.argv.indexOf('--plan');
  const out = publish(process.cwd(), JSON.parse(readFileSync(process.argv[i + 1], 'utf8')), { dryRun: process.argv.includes('--dry-run') });
  console.log(JSON.stringify(out, null, 2));
}
