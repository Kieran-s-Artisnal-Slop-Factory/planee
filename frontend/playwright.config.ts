import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/sync',
  // retries: 0 on purpose. A flaky sync test is an untrustworthy sync test —
  // retrying until green is how a real race gets reclassified as "flake".
  retries: 0,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  globalSetup: './tests/sync/global-setup.ts',
  reporter: [['list'], ['./tests/sync/trust-gate.ts']],
  use: { trace: 'retain-on-failure' },
});
