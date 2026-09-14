import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIN_DIR, DIST_DIR, binName } from './paths';
import { normalizeStored } from './schema';

/** A real server on an ephemeral port with a brand-new database. */
export interface Backend {
  url: string;
  dbPath: string;
  /** What the server SERVES: the pull endpoint's view, from seq 0. */
  served(): Promise<Record<string, Record<string, unknown>[]>>;
  /** What the server STORED: a direct read of the sqlite file. */
  stored(): Promise<Record<string, Record<string, unknown>[]>>;
  epoch(): Promise<string>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startBackend(): Promise<Backend> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'planee-sync-'));
  const dbPath = join(dir, 'planee.db');
  const url = 'http://127.0.0.1:' + port;

  const proc: ChildProcess = spawn(binName(BIN_DIR, 'server'), [], {
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, STATIC_DIR: DIST_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout?.on('data', (d: unknown) => (log += String(d)));
  proc.stderr?.on('data', (d: unknown) => (log += String(d)));
  let exited = false;
  proc.on('exit', () => (exited = true));

  // Poll /healthz — never a fixed sleep, which is either slow or flaky.
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (exited) throw new Error('backend exited before it was ready:\n' + log);
    if (Date.now() > deadline) throw new Error('backend did not become healthy:\n' + log);
    try {
      const res = await fetch(url + '/healthz');
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    await sleep(50);
  }

  return {
    url,
    dbPath,
    async served() {
      const res = await fetch(url + '/sync/pull?since=0');
      const body = (await res.json()) as { rows: Record<string, Record<string, unknown>[]> };
      return body.rows ?? {};
    },
    async stored() {
      const raw = execFileSync(binName(BIN_DIR, 'dbdump'), [dbPath], { encoding: 'utf8' });
      return normalizeStored(JSON.parse(raw) as Record<string, Record<string, unknown>[]>);
    },
    async epoch() {
      const res = await fetch(url + '/healthz');
      return ((await res.json()) as { epoch: string }).epoch;
    },
    async stop() {
      proc.kill();
      // Windows holds the sqlite file (and -wal/-shm) for a moment after exit.
      for (let i = 0; i < 10; i++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          await sleep(100);
        }
      }
    },
  };
}
