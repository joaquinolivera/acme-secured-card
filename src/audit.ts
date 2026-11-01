import { createHash } from 'node:crypto';
import type { Tx } from './db.js';
import { actorLabel, type Actor } from './auth.js';

const GENESIS = '0'.repeat(64);

/**
 * Appends to the per-account hash chain. Callers hold the account row lock, so the
 * chain has a single writer at a time. hash = sha256(prev_hash | account | actor | action | details).
 */
export async function audit(
  tx: Tx,
  p: { accountId: string; actor: Actor; action: string; requestId?: string; details?: Record<string, unknown> },
): Promise<void> {
  const prev = await tx.query('SELECT hash FROM audit_log WHERE account_id = $1 ORDER BY seq DESC LIMIT 1', [p.accountId]);
  const prevHash: string = prev.rows[0]?.hash ?? GENESIS;
  const details = p.details ?? {};
  const hash = chainHash(prevHash, p.accountId, actorLabel(p.actor), p.action, details);
  await tx.query(
    `INSERT INTO audit_log(account_id, actor, action, request_id, details, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [p.accountId, actorLabel(p.actor), p.action, p.requestId ?? null, JSON.stringify(details), prevHash, hash],
  );
}

export function chainHash(prev: string, accountId: string, actor: string, action: string, details: unknown): string {
  return createHash('sha256')
    .update([prev, accountId, actor, action, canonical(details)].join('|'))
    .digest('hex');
}

/**
 * Key-sorted JSON with the same semantics as JSON.stringify/jsonb storage (undefined object values are
 * dropped, undefined array items become null), so the hash computed before insert equals the one recomputed
 * from the stored row.
 */
export function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Recomputes the whole chain for an account; returns the first broken seq, or null if intact. */
export async function verifyAuditChain(tx: Tx, accountId: string): Promise<number | null> {
  const { rows } = await tx.query('SELECT * FROM audit_log WHERE account_id = $1 ORDER BY seq', [accountId]);
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || r.hash !== chainHash(prev, accountId, r.actor, r.action, r.details)) return Number(r.seq);
    prev = r.hash;
  }
  return null;
}

export async function emit(tx: Tx, topic: string, payload: Record<string, unknown>): Promise<void> {
  await tx.query('INSERT INTO outbox(topic, payload) VALUES ($1, $2)', [topic, JSON.stringify(payload)]);
}
