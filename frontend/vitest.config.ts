import { defineConfig } from 'vitest/config';

// Unit tests only: pure TypeScript logic under src/. Svelte components and
// anything touching IndexedDB or the sync server are covered by the Playwright
// harness in tests/sync (npm run test:sync), which runs a real browser.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
