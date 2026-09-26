import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export const FRONTEND_DIR = resolve(here, '../../..');
export const REPO_DIR = resolve(FRONTEND_DIR, '..');
export const BACKEND_DIR = join(REPO_DIR, 'backend');
/**
 * Where the suite builds the frontend and the Go binaries. Overridable so two
 * harness runs can share a checkout without overwriting each other's build
 * (PLANEE_DIST_DIR / PLANEE_BIN_DIR, relative to frontend/ or absolute).
 */
export const DIST_DIR = resolve(FRONTEND_DIR, process.env.PLANEE_DIST_DIR ?? 'dist');
export const BIN_DIR = resolve(FRONTEND_DIR, process.env.PLANEE_BIN_DIR ?? join('tests', 'sync', '.bin'));

/** Prebuilt binaries, not "go run": teardown then kills ONE known pid. */
export function binName(dir: string, name: string): string {
  return join(dir, process.platform === 'win32' ? name + '.exe' : name);
}
