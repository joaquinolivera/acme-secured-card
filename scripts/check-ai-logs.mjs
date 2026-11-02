#!/usr/bin/env node
// Submission gate for the "AI transparency" requirement. Usage: npm run check:ai-logs [-- --allow-gaps]
//  - fails if ai-logs/ holds no transcript files
//  - fails if PROMPTS.md lists a source as MISSING (unless --allow-gaps: then the gaps must be disclosed there)
//  - fails if a transcript file is not referenced in PROMPTS.md (by its path, or by a containing directory such as a run
//    folder `ai-logs/runs/issue-12/<run-id>/`), or PROMPTS.md references a path that does not exist
//  - prints size, sha256 and the time span of each JSONL transcript so completeness can be eyeballed
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const logsDir = path.join(root, 'ai-logs');
const allowGaps = process.argv.includes('--allow-gaps');
const problems = [];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const referenced = [
  ...(existsSync(path.join(root, 'PROMPTS.md')) ? readFileSync(path.join(root, 'PROMPTS.md'), 'utf8') : '').matchAll(/`(ai-logs\/[^`]+)`/g),
].map((m) => m[1]);
const files = existsSync(logsDir) ? walk(logsDir).filter((f) => !/README\.md$|\.gitkeep$/.test(f)) : [];
const prompts = existsSync(path.join(root, 'PROMPTS.md')) ? readFileSync(path.join(root, 'PROMPTS.md'), 'utf8') : '';

if (files.length === 0) problems.push('ai-logs/ contains no transcript files');

for (const f of files) {
  const rel = path.relative(root, f).split(path.sep).join('/');
  const buf = readFileSync(f);
  let span = '';
  if (f.endsWith('.jsonl')) {
    const stamps = buf
      .toString('utf8')
      .split('\n')
      .map((l) => {
        try {
          return JSON.parse(l).timestamp;
        } catch {
          return undefined;
        }
      })
      .filter(Boolean)
      .sort();
    if (stamps.length) span = ` ${stamps[0]} -> ${stamps[stamps.length - 1]}`;
  }
  console.log(`${rel}  ${statSync(f).size} bytes  sha256:${createHash('sha256').update(buf).digest('hex').slice(0, 16)}${span}`);
  const covered = referenced.some((r) => rel === r || (r.endsWith('/') && rel.startsWith(r)));
  if (!covered) problems.push(`${rel} is not referenced in PROMPTS.md`);
}

for (const m of prompts.matchAll(/`(ai-logs\/[^`]+)`/g)) {
  if (!existsSync(path.join(root, m[1]))) problems.push(`PROMPTS.md references ${m[1]}, which does not exist`);
}
const missing = prompts.split('\n').filter((l) => /\|\s*MISSING\b/.test(l));
for (const l of missing) {
  const msg = `source marked MISSING: ${l.split('|')[2]?.trim() ?? l.trim()}`;
  if (allowGaps) console.warn(`WARNING (disclosed gap): ${msg}`);
  else problems.push(msg);
}

if (problems.length) {
  console.error(`\nAI transparency check FAILED:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log('\nAI transparency check passed.');
