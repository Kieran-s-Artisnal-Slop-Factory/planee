import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { BACKEND_DIR, BIN_DIR, DIST_DIR, FRONTEND_DIR, binName } from './helpers/paths';

/**
 * Build what the suite runs against: the PRODUCTION frontend bundle and a
 * compiled backend binary.
 *
 * Not the dev server. The dev server does not register the service worker and
 * resolves the sync URL differently, so a suite that runs against it tests a
 * code path no user ever runs — which is how "all green" and "sync is broken"
 * coexist.
 *
 * Set PLANEE_SKIP_BUILD=1 to reuse the last build while iterating.
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.PLANEE_SKIP_BUILD === '1' && existsSync(DIST_DIR)) return;
  execFileSync('npm', ['run', 'build'], { cwd: FRONTEND_DIR, stdio: 'inherit', shell: true });
  execFileSync('go', ['build', '-o', binName(BIN_DIR, 'server'), '.'], {
    cwd: BACKEND_DIR,
    stdio: 'inherit',
  });
  execFileSync('go', ['build', '-o', binName(BIN_DIR, 'dbdump'), './cmd/dbdump'], {
    cwd: BACKEND_DIR,
    stdio: 'inherit',
  });
  // Builds old-schema server databases for the upgrade cases (startBackend's seedSql).
  execFileSync('go', ['build', '-o', binName(BIN_DIR, 'sqlexec'), './cmd/sqlexec'], {
    cwd: BACKEND_DIR,
    stdio: 'inherit',
  });
}
