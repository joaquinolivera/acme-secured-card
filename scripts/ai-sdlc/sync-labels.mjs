#!/usr/bin/env node
// Creates or updates the labels the AI-SDLC relies on (idempotent). Usage: node scripts/ai-sdlc/sync-labels.mjs [--dry-run]
// Needs an authenticated `gh` with access to the repository; run it yourself once, it is not part of any workflow.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { LABELS } from './lib.mjs';

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const dry = process.argv.includes('--dry-run');
  for (const l of LABELS) {
    const args = ['label', 'create', l.name, '--color', l.color, '--description', l.description, '--force'];
    if (dry) console.log(`gh ${args.join(' ')}`);
    else execFileSync(process.env.GH_BIN ?? 'gh', args, { stdio: 'inherit' });
  }
}
