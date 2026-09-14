import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { startBackend, type Backend } from './backend';
import { STORE_NAMES } from './schema';

const HOOK = '__planee';

/**
 * One "device" = one Playwright BrowserContext.
 *
 * A context has its own IndexedDB, localStorage, sessionStorage, service-worker
 * registration and cache partition, so two contexts are two genuinely
 * independent client databases. This is the whole point: a "device B" faked by
 * clearing one IndexedDB and re-pulling can never test two live databases
 * converging, which is the only thing that matters.
 */
export interface Device {
  name: string;
  page: Page;
  context: BrowserContext;
  errors: string[];
  goto(path?: string): Promise<void>;
  call<T>(method: string, ...args: unknown[]): Promise<T>;
  dumpAll(): Promise<Record<string, Record<string, unknown>[]>>;
  dump(store: string): Promise<Record<string, unknown>[]>;
  get(store: string, id: string): Promise<Record<string, unknown> | undefined>;
  sync(): Promise<SyncResult>;
  cursors(): Promise<Record<string, unknown>>;
  outbox(): Promise<Record<string, unknown>[]>;
}

export interface SyncResult {
  ok: boolean;
  pushed: number;
  pulled: number;
  rejected: number;
  conflicts: number;
  error?: string;
}

export async function makeDevice(
  context: BrowserContext,
  backend: Backend,
  name: string,
  opts: { serviceWorkers?: boolean } = {}
): Promise<Device> {
  const errors: string[] = [];
  // Set BEFORE the first navigation: the app reads the flag once at startup,
  // and any automatic write that fires before it is set makes the first
  // snapshot unattributable.
  await context.addInitScript(
    ([key, mode, onboarded]) => {
      localStorage.setItem(key, '1');
      localStorage.setItem(mode, 'sync');
      localStorage.setItem(onboarded, '1');
    },
    ['planee-test-mode', 'planee-sync-mode', 'planee-onboarded']
  );

  const page = await context.newPage();
  // The sync loop reports refused rows and failed pushes on the console AND in
  // the SyncResult the specs assert on — and several sabotage cases provoke
  // exactly those on purpose. Only errors the app did not expect count here.
  const isSyncReport = (text: string) =>
    text.includes('[planee sync]') ||
    /Failed to load resource: the server responded with a status of 5[0-9][0-9]/.test(text);
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isSyncReport(msg.text())) errors.push(name + ' console: ' + msg.text());
  });
  page.on('pageerror', (err) => errors.push(name + ' pageerror: ' + err.message));
  void opts;

  const device: Device = {
    name,
    page,
    context,
    errors,
    async goto(path = '/') {
      await page.goto(backend.url + path);
      await page.waitForFunction((hook) => Boolean((window as never)[hook]), HOOK, {
        timeout: 15_000,
      });
    },
    call<T>(method: string, ...args: unknown[]): Promise<T> {
      return page.evaluate(
        ({ hook, method: m, args: a }) =>
          (window as unknown as Record<string, Record<string, (...x: unknown[]) => unknown>>)[hook]![
            m
          ]!(...a) as unknown,
        { hook: HOOK, method, args }
      ) as Promise<T>;
    },
    dumpAll: () => device.call('rawDumpAll'),
    dump: (store) => device.call('rawDump', store),
    get: (store, id) => device.call('rawGet', store, id),
    sync: () => device.call('syncNow'),
    cursors: () => device.call('getCursors'),
    outbox: () => device.call('outbox'),
  };
  return device;
}

export const test = base.extend<{
  /** SQL that builds the server database before it starts (see BackendOptions). Set with test.use(). */
  backendSeedSql: string | null;
  backend: Backend;
  deviceA: Device;
  deviceB: Device;
}>({
  backendSeedSql: [null, { option: true }],
  backend: async ({ backendSeedSql }, use) => {
    const backend = await startBackend({ seedSql: backendSeedSql });
    await use(backend);
    await backend.stop();
  },
  // Fresh contexts per test. A leaked cursor or a surviving tombstone from a
  // previous case can mask exactly the bug the next case is looking for.
  deviceA: async ({ browser, backend }, use) => {
    const context = await browser.newContext();
    const device = await makeDevice(context, backend, 'A');
    await device.goto();
    await use(device);
    expect(device.errors, 'device A logged errors').toEqual([]);
    await context.close();
  },
  deviceB: async ({ browser, backend }, use) => {
    const context = await browser.newContext();
    const device = await makeDevice(context, backend, 'B');
    await device.goto();
    await use(device);
    expect(device.errors, 'device B logged errors').toEqual([]);
    await context.close();
  },
});

export { expect, STORE_NAMES };
