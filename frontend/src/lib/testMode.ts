/**
 * Test mode: set localStorage['planee-test-mode'] = '1' BEFORE the first
 * navigation (Playwright: context.addInitScript) to make the app observable.
 *
 * It disables every automatic write and every automatic sync, so a test can
 * take a stable snapshot and attribute each change to the action that caused
 * it. It never changes what a normal build does — isTestMode() is false unless
 * the flag was deliberately set on that browser profile.
 *
 * That an app needs this at all is worth noticing: any code that mutates
 * synced data as a side effect of *reading* (dedup-on-read, "heal", auto-close,
 * lazily backfilling a field) is a data-loss risk in its own right, because it
 * can restamp rows the user never touched and beat another device's real edit.
 * Prefer not writing on read; use this flag to make the writes you cannot
 * avoid explicit, not to bless them.
 */
export const TEST_MODE_KEY = 'planee-test-mode';

export function isTestMode(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(TEST_MODE_KEY) === '1';
  } catch {
    return false; // storage blocked — treat as a normal run
  }
}
