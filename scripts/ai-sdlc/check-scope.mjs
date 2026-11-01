#!/usr/bin/env node
// Usage: node scripts/ai-sdlc/check-scope.mjs --role test|impl|review [--base HEAD]
// Exits 1 when the working tree changed files the role may not touch.
import { changedFiles, checkScope } from './lib.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const role = arg('role');
const files = changedFiles(process.cwd(), arg('base', 'HEAD'));
const { ok, violations } = checkScope(role, files);
console.log(JSON.stringify({ role, files, ok, violations }, null, 2));
process.exit(ok ? 0 : 1);
