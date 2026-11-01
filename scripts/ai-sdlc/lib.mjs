// Shared helpers for the AI-SDLC tooling. Dependency-free on purpose (Node built-ins only).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const REQUIRED_SECTIONS = [
  'Problem statement',
  'Requirement reference',
  'Evidence',
  'Scope',
  'Non-goals',
  'Acceptance criteria',
  'Required tests',
  'Dependencies',
  'Definition of Done',
];
export const PRIORITIES = ['P0', 'P1', 'P2'];
export const TYPES = ['bug', 'test', 'enhancement'];

/** Labels the workflows rely on. Kept minimal; see docs/ai-sdlc.md. */
export const LABELS = [
  { name: 'priority/P0', color: 'b60205', description: 'Can cause financial loss or break an invariant' },
  { name: 'priority/P1', color: 'd93f0b', description: 'Important reliability, test or documentation gap' },
  { name: 'priority/P2', color: 'fbca04', description: 'Optional' },
  { name: 'type/bug', color: 'd73a4a', description: 'Defect' },
  { name: 'type/test', color: '0e8a16', description: 'Missing or weak test' },
  { name: 'type/enhancement', color: 'a2eeef', description: 'Behaviour change or new capability' },
  { name: 'ai-proposed', color: 'ededed', description: 'Drafted by the AI planning workflow; needs human review' },
  { name: 'ai-ready', color: '5319e7', description: 'Human-approved: the issue-driven workflow may start' },
  { name: 'ai-in-progress', color: '1d76db', description: 'An AI run is working on this issue' },
  { name: 'ai-blocked', color: 'e99695', description: 'AI run stopped; needs a human' },
  { name: 'needs-decision', color: 'c5def5', description: 'A product or design decision is required first' },
];

// ---------------------------------------------------------------- backlog specs

/** Parses `---\nkey: value\n---` front matter plus `## Heading` sections. */
export function parseBacklogFile(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error('missing front matter');
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  const sections = {};
  let current = null;
  for (const line of m[2].split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = h[1];
      sections[current] = '';
    } else if (current) sections[current] += `${line}\n`;
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].trim();
  return { meta, sections, body: m[2].trim() };
}

const PATH_TOKEN = /^[\w./-]+\.(ts|mjs|js|md|sql|yml|yaml|json|tf)$/;

/** Returns a list of problems; empty means the draft is publishable. Evidence must point at files that exist. */
export function validateSpec(spec, repoRoot) {
  const problems = [];
  const { meta, sections } = spec;
  if (!/^ISSUE-\d{3}$/.test(meta.id ?? '')) problems.push('id must look like ISSUE-001');
  if (!meta.title || meta.title.length > 120) problems.push('title is required and at most 120 characters');
  if (!PRIORITIES.includes(meta.priority)) problems.push(`priority must be one of ${PRIORITIES.join(', ')}`);
  if (!TYPES.includes(meta.type)) problems.push(`type must be one of ${TYPES.join(', ')}`);
  if (!['true', 'false'].includes(meta.ai_ready)) problems.push('ai_ready must be true or false');
  for (const s of REQUIRED_SECTIONS) if (!sections[s]) problems.push(`missing or empty section: ${s}`);

  const evidence = sections['Evidence'] ?? '';
  const paths = [...evidence.matchAll(/`([^`]+)`/g)].map((m) => m[1].split(/[\s:]/)[0]).filter((t) => PATH_TOKEN.test(t));
  if (paths.length === 0) problems.push('Evidence must reference at least one repository file in backticks');
  for (const p of new Set(paths))
    if (!existsSync(path.join(repoRoot, p))) problems.push(`Evidence references a file that does not exist: ${p}`);
  if (!/^- \[ \] /m.test(sections['Acceptance criteria'] ?? ''))
    problems.push('Acceptance criteria must contain at least one "- [ ]" item');
  return problems;
}

export const parseAcceptanceCriteria = (text) => [...text.matchAll(/^- \[[ x]\] (.+)$/gm)].map((m) => m[1].trim());

export const normalizeTitle = (t) =>
  String(t)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function jaccard(a, b) {
  const A = new Set(normalizeTitle(a).split(' '));
  const B = new Set(normalizeTitle(b).split(' '));
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (A.size + B.size - inter || 1);
}

/** An existing issue/PR counts as a duplicate by backlog marker, identical normalized title, or very similar title. */
export function findDuplicate(spec, existing) {
  const marker = `backlog-id: ${spec.meta.id}`;
  for (const e of existing) {
    if ((e.body ?? '').includes(marker)) return { ...e, reason: 'same backlog id' };
    if (normalizeTitle(e.title) === normalizeTitle(spec.meta.title)) return { ...e, reason: 'same title' };
    if (jaccard(e.title, spec.meta.title) >= 0.8) return { ...e, reason: 'very similar title' };
  }
  return null;
}

export function labelsFor(spec) {
  const labels = [`priority/${spec.meta.priority}`, `type/${spec.meta.type}`, 'ai-proposed'];
  if (spec.meta.ai_ready === 'false') labels.push('needs-decision');
  return labels;
}

export const issueBody = (spec) =>
  `<!-- backlog-id: ${spec.meta.id} -->\n${spec.body}\n\n---\n_Proposed by the AI backlog-planning workflow from \`docs/backlog/\`. A human must review it; add the \`ai-ready\` label to let the issue-driven workflow start._\n`;

// ---------------------------------------------------------------- untrusted text

/** Issue text is untrusted input: strip control characters and cap the size before it goes anywhere near a prompt. */
export function sanitizeUntrusted(text, max = 20000) {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return cleaned.length > max ? `${cleaned.slice(0, max)}\n[truncated]` : cleaned;
}

/** Wraps text in a fence that cannot be closed from inside the text. */
export function fenceUntrusted(text) {
  let fence = '~~~~';
  while (text.includes(fence)) fence += '~';
  return `${fence}untrusted-issue-content\n${text}\n${fence}`;
}

export const slugify = (t) => normalizeTitle(t).replace(/ /g, '-').slice(0, 40).replace(/-+$/, '');

// ---------------------------------------------------------------- role scope guard

const globToRegExp = (g) =>
  new RegExp(
    `^${g
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\uE000')
      .replace(/\*/g, '[^/]*')
      .replace(/\uE000/g, '.*')}$`,
  );

/**
 * Which files each agent role may change. The orchestrator checks this after every agent turn, so a role
 * constraint does not depend on the agent obeying its prompt.
 *  - test:   tests (and the test matrix) only
 *  - impl:   production code and docs; never tests, workflows, agent config, or package/tooling files
 *  - review: nothing
 */
export const ROLE_RULES = {
  test: { allow: ['test/**', 'docs/tdd-matrix.md'] },
  impl: {
    allow: ['src/**', 'migrations/**', 'docs/**'],
    deny: [
      'test/**',
      '.github/**',
      '.claude/**',
      'scripts/**',
      'package.json',
      'package-lock.json',
      'eslint.config.js',
      'vitest.config.ts',
      'tsconfig*.json',
      'CLAUDE.md',
      'ai-logs/**',
    ],
  },
  review: { allow: [] },
};

export function checkScope(role, files) {
  const rule = ROLE_RULES[role];
  if (!rule) throw new Error(`unknown role: ${role}`);
  const allow = rule.allow.map(globToRegExp);
  const deny = (rule.deny ?? []).map(globToRegExp);
  const violations = files.filter((f) => deny.some((d) => d.test(f)) || !allow.some((a) => a.test(f)));
  return { ok: violations.length === 0, violations };
}

export function changedFiles(repo, baseRef) {
  const run = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean);
  return [...new Set([...run('diff', '--name-only', baseRef), ...run('ls-files', '--others', '--exclude-standard')])].sort();
}
