// Entry point for the scheduled task (EventBridge -> ECS RunTask): node dist/jobs/daily.js
import { runDaily } from '../services/billing.js';
import { toDate, clock } from '../clock.js';
import { pool } from '../db.js';

const result = await runDaily(toDate(clock.now()));
console.log(JSON.stringify({ level: 'info', msg: 'daily job finished', ...result }));
await pool.end();
process.exit(result.failed.length ? 1 : 0);
