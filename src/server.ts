import { buildApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';

const app = buildApp();
if (process.env['AUTO_MIGRATE'] === 'true') await migrate(); // convenient locally; in prod run as a release step

let shuttingDown = false;
async function shutdown(sig: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ sig }, 'shutting down'); // stop accepting, drain in-flight requests, then close the pool
  await app.close();
  await pool.end();
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    shutdown(sig).then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}
await app.listen({ port: config.port, host: '0.0.0.0' });
