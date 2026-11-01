import pg from 'pg';
import { config } from './config.js';

// BIGINT -> number, guarded: we never silently lose precision on money.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint ${v} exceeds safe integer range`);
  return n;
});
pg.types.setTypeParser(1082, (v) => v); // DATE -> 'YYYY-MM-DD' string (no timezone surprises)

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.poolMax });
export type Tx = pg.PoolClient;

const RETRYABLE = new Set(['40001', '40P01']); // serialization failure, deadlock

/**
 * Runs fn in a transaction (READ COMMITTED + explicit row locks).
 * The whole unit is retried on deadlock/serialization errors, so fn must be
 * side-effect free outside the transaction.
 */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && i < attempts) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
