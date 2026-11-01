import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

/** Starts the real server process (not an in-process app) and checks it shuts down cleanly on SIGTERM. */
describe('process lifecycle', () => {
  it('serves health checks, then exits 0 on SIGTERM after closing the HTTP server and the DB pool', async () => {
    const port = 39000 + Math.floor(Math.random() * 500);
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: { ...process.env, PORT: String(port), LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

    let healthy = false;
    for (let i = 0; i < 60 && !healthy; i++) {
      try {
        healthy = (await fetch(`http://127.0.0.1:${port}/readyz`)).status === 200;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    expect(healthy, out).toBe(true);

    child.kill('SIGTERM');
    child.kill('SIGTERM'); // a second signal must be ignored, not cause a double close
    expect(await exited).toBe(0);
    expect(out).toContain('shutting down');
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow(); // port is closed
  });
});
