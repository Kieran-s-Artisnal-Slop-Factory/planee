/**
 * Lockfile integrity tripwire.
 *
 * npm has a long-standing bug (npm/cli#4828 family) where regenerating
 * package-lock.json on a machine that skipped an optional dependency subtree
 * (e.g. the wasm32-wasi fallback bindings on Windows x64) silently DROPS those
 * entries from the lock. The lock then references packages that have no entry,
 * and `npm ci` — used by the Pages deploy — refuses to install.
 *
 * That has bitten this repo repeatedly via @emnapi/* + @napi-rs/wasm-runtime
 * (the wasm runtime shims of rolldown/vite and the Astro compiler). The fix is
 * twofold: package.json pins them as real root devDependencies and dedupes
 * every consumer onto them via `overrides` (real root deps can't be dropped),
 * and this test fails fast if the lock ever goes incomplete again — at
 * `npm test` time on the machine that corrupted it, not at deploy time.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface LockEntry {
  version?: string;
  optional?: boolean;
  peer?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as {
  packages: Record<string, LockEntry>;
};
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  devDependencies: Record<string, string>;
  overrides?: Record<string, string>;
};

const WASM_SHIMS = [
  '@emnapi/core',
  '@emnapi/runtime',
  '@emnapi/wasi-threads',
  '@napi-rs/wasm-runtime',
];

describe('package-lock.json integrity', () => {
  it('pins the wasm runtime shims as protected root entries', () => {
    for (const name of WASM_SHIMS) {
      // package.json must keep both the devDependency pin and the override —
      // removing either reopens the door to npm dropping the lock entries.
      expect(pkg.devDependencies[name], `${name} missing from devDependencies`).toBeDefined();
      expect(pkg.overrides?.[name], `${name} missing from overrides`).toBeDefined();

      const entry = lock.packages[`node_modules/${name}`];
      expect(entry, `${name} missing from package-lock.json`).toBeDefined();
      // A real root dep — not the droppable optional/peer leaf it used to be.
      expect(entry!.optional, `${name} must not be optional`).not.toBe(true);
      expect(entry!.peer, `${name} must not be peer`).not.toBe(true);
    }
  });

  it('every dependency referenced by a lock entry resolves to a lock entry', () => {
    // The invariant `npm ci` enforces, checked ahead of time: for a package at
    // path P depending on N, an entry must exist at P/node_modules/N, at some
    // ancestor's node_modules/N, or at the root node_modules/N. Peer deps
    // count too (npm 7+ auto-installs them; the @emnapi breakage was a peer of
    // @napi-rs/wasm-runtime) — except peers explicitly marked optional in
    // peerDependenciesMeta, which are legitimately absent.
    const missing: string[] = [];
    for (const [path, entry] of Object.entries(lock.packages)) {
      const required = {
        ...(entry.dependencies ?? {}),
        ...Object.fromEntries(
          Object.entries(entry.peerDependencies ?? {}).filter(
            ([name]) => !entry.peerDependenciesMeta?.[name]?.optional
          )
        ),
      };
      for (const name of Object.keys(required)) {
        let found = false;
        let base = path;
        for (;;) {
          const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
          if (lock.packages[candidate]) {
            found = true;
            break;
          }
          if (!base) break;
          const cut = base.lastIndexOf('/node_modules/');
          base = cut === -1 ? '' : base.slice(0, cut);
        }
        if (!found) missing.push(`${path || '(root)'} -> ${name}`);
      }
    }
    expect(missing, `lockfile references packages with no entry (npm ci will fail):\n${missing.join('\n')}`).toEqual([]);
  });
});
