import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export const FRONTEND_DIR = resolve(here, '../../..');
export const REPO_DIR = resolve(FRONTEND_DIR, '..');
export const BACKEND_DIR = join(REPO_DIR, 'backend');
export const DIST_DIR = join(FRONTEND_DIR, 'dist');
export const BIN_DIR = join(FRONTEND_DIR, 'tests', 'sync', '.bin');

/** Prebuilt binaries, not "go run": teardown then kills ONE known pid. */
export function binName(dir: string, name: string): string {
  return join(dir, process.platform === 'win32' ? name + '.exe' : name);
}
