import { createHash } from 'node:crypto';
import type { Tx } from './db.js';
import { AppError } from './errors.js';

export interface Result {
  status: number;
  body: unknown;
}

export const hashRequest = (...parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/**
 * Exactly-once effect per (scope, key), inside the SAME transaction as the business change.
 *  - First request: inserts the key, runs `exec`, stores the response; all commit atomically.
 *  - Concurrent duplicate: its INSERT blocks on the unique index until the first commits, then replays.
 *  - Same key, different payload: 422 (client bug), never silently accepted.
 *  - If exec throws, the key row rolls back with everything else, so the client can retry safely.
 */
export async function idempotent(
  tx: Tx,
  scope: string,
  key: string,
  requestHash: string,
  exec: () => Promise<Result>,
): Promise<Result & { replayed: boolean }> {
  const ins = await tx.query(
    `INSERT INTO idempotency_keys(scope, key, request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1`,
    [scope, key, requestHash],
  );
  if (ins.rowCount === 0) {
    const r = await tx.query('SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE scope=$1 AND key=$2', [
      scope,
      key,
    ]);
    const row = r.rows[0];
    if (row.request_hash !== requestHash) {
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
    }
    return { status: row.response_status, body: row.response_body, replayed: true };
  }
  const result = await exec();
  await tx.query('UPDATE idempotency_keys SET response_status=$3, response_body=$4 WHERE scope=$1 AND key=$2', [
    scope,
    key,
    result.status,
    JSON.stringify(result.body),
  ]);
  return { ...result, replayed: false };
}
