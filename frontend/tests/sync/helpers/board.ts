import { expect, type Locator, type Page } from '@playwright/test';
import type { Backend } from './backend';
import type { Device } from './devices';
import { diffStore } from './compare';
import {
  assertConverged,
  assertFieldEverywhere,
  assertInvariants,
  assertIsolatedDelta,
  capture,
  type Db,
  type FourLeg,
} from './oracle';

/**
 * Shared plumbing for the board and markdown UI specs: seeding a project the
 * way the app shapes its rows, opening the board, finding cards, and dragging
 * them with real pointer events.
 *
 * Seeding goes through the test hook's repoPut (the real repo write path);
 * the action under test always goes through the UI.
 */

export type Status = 'todo' | 'in_progress' | 'done' | 'wontfix' | 'out_of_scope' | 'bumped';
export type Column = 'todo' | 'in_progress' | 'done';

export interface SeedVersion {
  id: string;
  number: string;
  completed?: boolean;
  description?: string | null;
}

export interface SeedCard {
  task: string;
  /** The version_task id, which is the card's data-id. Omit for an unscheduled task. */
  link?: string;
  version?: string;
  title: string;
  status?: Status;
  position?: number;
  description?: string | null;
  subtasks?: string | null;
}

export interface SeedProject {
  project: { id: string; name: string; description?: string };
  versions: SeedVersion[];
  cards: SeedCard[];
}

const sync = () => ({ updated_at: new Date().toISOString(), deleted_at: null, server_seq: null, field_updated_at: {} });

/** Write a project, its versions, tasks and links on `device` through the repo. */
export async function seedProject(device: Device, seed: SeedProject): Promise<void> {
  await device.call('repoPut', 'project', {
    id: seed.project.id,
    ...sync(),
    name: seed.project.name,
    description: seed.project.description ?? '',
  });
  for (const v of seed.versions) {
    await device.call('repoPut', 'version', {
      id: v.id,
      ...sync(),
      number: v.number,
      project: seed.project.id,
      description: v.description ?? null,
      completed: v.completed ?? false,
    });
  }
  for (const c of seed.cards) {
    await device.call('repoPut', 'task', {
      id: c.task,
      ...sync(),
      project: seed.project.id,
      title: c.title,
      task_type: 'feature',
      description: c.description ?? null,
      priority: 4,
      subtasks: c.subtasks ?? null,
    });
    if (!c.link) continue;
    await device.call('repoPut', 'version_task', {
      id: c.link,
      ...sync(),
      version: c.version ?? seed.versions[0]!.id,
      task: c.task,
      status: c.status ?? 'todo',
      position: c.position ?? 0,
    });
  }
}

/** Run syncs in order, failing on the first that does not succeed. */
export async function syncAll(...devices: Device[]): Promise<void> {
  for (const device of devices) {
    const result = await device.sync();
    expect(result.ok, device.name + ' sync: ' + result.error).toBe(true);
  }
}

/** Home's board URL (D17): `/?project=…&version=…[&task=…]`. */
export function boardPath(projectId: string, versionId?: string | null, taskId?: string | null): string {
  const params = new URLSearchParams({ project: projectId });
  if (versionId) params.set('version', versionId);
  if (taskId) params.set('task', taskId);
  return '/?' + params.toString();
}

/** Open the board (Home) for a project and version and wait until it has rendered it. */
export async function openBoard(device: Device, projectId: string, versionId: string): Promise<void> {
  await device.goto(boardPath(projectId, versionId));
  await waitForBoard(device.page, projectId, versionId);
}

/** Wait for the test hook after a navigation the page started itself (a link, a redirect). */
export async function waitForHook(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as never)['__planee']), undefined, { timeout: 15_000 });
}

/** The current URL's path and query, as `{ path, params }`. */
export function urlParts(page: Page): { path: string; params: Record<string, string> } {
  const url = new URL(page.url());
  return { path: url.pathname, params: Object.fromEntries(url.searchParams) };
}

/**
 * Poll until the page shows the board URL for exactly these params. The board
 * rewrites its URL with replaceState after it loads, so this is polled.
 * Pass `task` when a card dialog is (or should be) open.
 */
export async function expectBoardUrl(
  page: Page,
  expected: { project: string; version: string; task?: string }
): Promise<void> {
  await expect.poll(() => urlParts(page)).toEqual({ path: '/', params: expected });
}

export async function waitForBoard(page: Page, projectId: string, versionId: string): Promise<void> {
  const root = page.getByTestId('board-root');
  await expect(root).toHaveAttribute('data-project', projectId, { timeout: 15_000 });
  await expect(root).toHaveAttribute('data-version', versionId);
  await expect(page.locator('[data-kanban-column="todo"]')).toBeVisible();
}

export const columnLocator = (page: Page, column: Column): Locator =>
  page.locator(`[data-kanban-column="${column}"]`);

/** A card by its version_task id, anywhere on the board. */
export const cardLocator = (page: Page, linkId: string): Locator =>
  page.locator(`[data-kanban-card][data-id="${linkId}"]`);

/** A card by its version_task id, in one column only. */
export const cardIn = (page: Page, column: Column, linkId: string): Locator =>
  columnLocator(page, column).locator(`[data-kanban-card][data-id="${linkId}"]`);

/** The ids of the cards in a column, top to bottom. */
export const columnIds = (page: Page, column: Column): Promise<string[]> =>
  columnLocator(page, column)
    .locator('[data-kanban-card]')
    .evaluateAll((cards) => cards.map((c) => c.getAttribute('data-id') ?? ''));

/** Wait until a card is on screen, in `column`, confirmed by storage and not saving. */
export async function expectSettledCard(page: Page, column: Column, linkId: string): Promise<Locator> {
  const card = cardIn(page, column, linkId);
  await expect(card).toBeVisible();
  await expect(card).not.toHaveClass(/\boptimistic\b/);
  await expect(card).not.toHaveAttribute('aria-busy', 'true');
  return card;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Drag a card with real mouse input: press on the card body (its badge row —
 * never a button, which would be a click), cross the 4px threshold, travel to
 * `to` in steps so pointermove fires along the way (the board aims with
 * elementFromPoint on every move), and release.
 *
 * `expectGhost` is checked while the button is still down: an editable board
 * shows the floating copy; a read-only board must not have started a drag.
 */
export async function dragCard(
  page: Page,
  card: Locator,
  to: () => Promise<Point>,
  { expectGhost = true }: { expectGhost?: boolean } = {}
): Promise<void> {
  await card.scrollIntoViewIfNeeded();
  const handle = card.locator('.kb-badges');
  const box = (await handle.boundingBox())!;
  expect(box, 'card has no badge row to grab').toBeTruthy();
  const start = { x: box.x + box.width - 6, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 8, start.y + 8, { steps: 4 });
  const target = await to();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  // Settle on the target with a couple of extra moves: the board re-aims on
  // each pointermove, and the last aim is what the drop commits.
  await page.mouse.move(target.x + 1, target.y, { steps: 2 });
  await page.mouse.move(target.x, target.y, { steps: 2 });
  if (expectGhost) await expect(page.locator('.kb-ghost')).toBeVisible();
  else await expect(page.locator('.kb-ghost')).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator('.kb-ghost')).toHaveCount(0);
}

/** A point near the top of a column's list — a drop there lands first in the column. */
export function topOfColumn(page: Page, column: Column): () => Promise<Point> {
  return async () => {
    const list = columnLocator(page, column).locator('[data-kanban-list]');
    const box = (await list.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + 12 };
  };
}

/** A point in the upper quarter of a card — a drop there lands above it. */
export function aboveCard(card: Locator): () => Promise<Point> {
  return async () => {
    const box = (await card.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + Math.max(3, box.height / 4) };
  };
}

/** The board's card dialog (the complete dialog has no close button; the FAB's is a <dialog>). */
export const cardDialog = (page: Page): Locator =>
  page.locator('[role="dialog"]').filter({ has: page.locator('.close') });

/** Open a card's dialog by its title button. */
export async function openCardDialog(page: Page, linkId: string): Promise<Locator> {
  await cardLocator(page, linkId).locator('.kb-title-btn').click();
  const dialog = cardDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Open a MarkdownField's editor (its `{testid}-edit` button) and switch to the
 * Source tab. Resolves with the CodeMirror content element.
 */
export async function openSourceEditor(field: Locator, testid: string): Promise<Locator> {
  await field.getByTestId(testid + '-edit').click();
  await expect(field.getByTestId(testid + '-save')).toBeEnabled({ timeout: 15_000 });
  await field.getByRole('button', { name: 'Source', exact: true }).click();
  const source = field.locator('.cm-content');
  await expect(source).toBeVisible();
  return source;
}

/**
 * Type `lines` into CodeMirror as a person would, one line per Enter. The
 * markdown keymap continues list markup on Enter ("- [ ] "), so each new line
 * first selects whatever the editor put at its start and types over it: the
 * stored text is then exactly `lines`, whatever the continuation rules are.
 */
export async function typeSource(page: Page, source: Locator, lines: string[]): Promise<void> {
  await source.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  for (const [i, line] of lines.entries()) {
    if (i > 0) {
      await page.keyboard.press('Enter');
      await page.keyboard.press('Shift+Home');
      await page.keyboard.press('Delete');
    }
    if (line) await page.keyboard.type(line);
  }
}

/**
 * Re-date a row written through the repo: `updated_at` and every per-field
 * stamp become `at`, and the outbox entry is re-queued to match. For cases
 * whose assertions depend on WHEN rows were written (the recent-issues
 * ranking), so the order is fixed rather than a matter of milliseconds.
 */
export async function backdate(device: Device, store: string, id: string, at: string): Promise<void> {
  const row = await device.get(store, id);
  expect(row, store + '/' + id + ' to backdate').toBeTruthy();
  const stamps = Object.fromEntries(
    Object.keys((row!.field_updated_at as Record<string, string> | undefined) ?? {}).map((field) => [field, at])
  );
  await device.call('rawPut', store, { ...row, updated_at: at, field_updated_at: stamps });
  await device.call('enqueue', store, id, at);
}

/** A raw row on a device, polled until `predicate` holds. */
export async function pollRow(
  device: Device,
  store: string,
  id: string,
  predicate: (row: Record<string, unknown> | undefined) => boolean,
  message: string
): Promise<Record<string, unknown>> {
  await expect.poll(async () => predicate(await device.get(store, id)), { message, timeout: 10_000 }).toBe(true);
  return (await device.get(store, id))!;
}

export function assertInvariantsEverywhere(legs: FourLeg): void {
  assertInvariants(legs.a, 'device A');
  assertInvariants(legs.b, 'device B');
  assertInvariants(legs.served, 'server (served)');
  assertInvariants(legs.stored, 'server (stored)');
}

export function assertIsolatedEverywhere(
  before: FourLeg,
  after: FourLeg,
  allowed: { store: string; id: string }[]
): void {
  assertIsolatedDelta(before.a, after.a, allowed);
  assertIsolatedDelta(before.b, after.b, allowed);
  assertIsolatedDelta(before.served, after.served, allowed);
  assertIsolatedDelta(before.stored, after.stored, allowed);
}

/** Sync bookkeeping every edit legitimately changes. */
const BOOKKEEPING = new Set(['updated_at', 'server_seq', 'field_updated_at']);

/**
 * Within ONE row: the data fields that changed between two snapshots must be
 * exactly `fields`. assertIsolatedDelta works per row; this narrows it to the
 * columns, so an edit that rewrote a sibling field of the same row (a stale
 * snapshot put, a status reset) is caught too.
 */
export function assertChangedFields(before: Db, after: Db, store: string, id: string, fields: string[], label: string): void {
  const pick = (db: Db) => (db[store] ?? []).filter((r) => r.id === id);
  const changed = new Set(
    diffStore(pick(before), pick(after))
      .map((d) => d.path.replace(/^id=[^.]+\.?/, '').split(/[.[]/, 1)[0]!)
      .filter((field) => field && !BOOKKEEPING.has(field))
  );
  expect([...changed].sort(), label + ': changed fields of ' + store + '/' + id).toEqual([...fields].sort());
}

export function assertChangedFieldsEverywhere(
  before: FourLeg,
  after: FourLeg,
  store: string,
  id: string,
  fields: string[]
): void {
  for (const leg of ['a', 'b', 'served', 'stored'] as const) {
    assertChangedFields(before[leg], after[leg], store, id, fields, 'leg "' + leg + '"');
  }
}

export type { Backend, Device };

// ---------------------------------------------------------------------------
// Scenario shared by board-ui.spec.ts and its sabotage twin
// ---------------------------------------------------------------------------

export const CONCURRENT = {
  project: 'ui-cc-project',
  version: 'ui-cc-v1',
  task: 'ui-cc-task',
  link: 'ui-cc-link',
  title: 'Write the release notes',
  renamed: 'Write the 0.1.0 release notes',
};

export interface ConcurrentRun {
  before: FourLeg;
  legs: FourLeg;
}

/**
 * A and B share a synced card. A drags it to Done on its board while B,
 * which has not seen that, renames it with the card's inline editor. Then
 * A, B, A sync.
 *
 * `afterRename` runs on B straight after its UI edit is stored and before any
 * sync — the sabotage suite injects its fault there.
 */
export async function dragWhileRenaming(
  a: Device,
  b: Device,
  backend: Backend,
  afterRename?: (staleLinkOnB: Record<string, unknown>) => Promise<void>
): Promise<ConcurrentRun> {
  const c = CONCURRENT;
  await seedProject(a, {
    project: { id: c.project, name: 'Concurrent' },
    versions: [{ id: c.version, number: '0.1.0' }],
    cards: [{ task: c.task, link: c.link, title: c.title, status: 'todo', position: 0 }],
  });
  await syncAll(a, b, a);
  await openBoard(a, c.project, c.version);
  await openBoard(b, c.project, c.version);
  await expectSettledCard(a.page, 'todo', c.link);
  await expectSettledCard(b.page, 'todo', c.link);
  const before = await capture(a, b, backend);
  const staleLinkOnB = (await b.get('version_task', c.link))!;

  // A: drag TODO -> Done.
  await dragCard(a.page, cardIn(a.page, 'todo', c.link), topOfColumn(a.page, 'done'));
  await expectSettledCard(a.page, 'done', c.link);
  await pollRow(a, 'version_task', c.link, (r) => r?.status === 'done', 'A stored the drag');

  // B: rename through the card's inline editor (the pencil).
  const cardOnB = cardIn(b.page, 'todo', c.link);
  await cardOnB.locator('.kb-pencil').click();
  const title = cardOnB.locator('form input[type="text"]');
  await expect(title).toHaveValue(c.title);
  await title.fill(c.renamed);
  await cardOnB.locator('form button[type="submit"]').click();
  await expect(cardOnB.locator('.kb-title-btn')).toHaveText(c.renamed);
  await pollRow(b, 'task', c.task, (r) => r?.title === c.renamed, 'B stored the rename');
  // B's board never saw the drag.
  await expect(cardIn(b.page, 'todo', c.link)).toBeVisible();

  if (afterRename) await afterRename(staleLinkOnB);

  await syncAll(a, b, a);
  const legs = await capture(a, b, backend);
  return { before, legs };
}

/**
 * What must hold after dragWhileRenaming: every leg agrees, on BOTH intended
 * edits, with nothing else changed — not a sibling field of either row, not
 * another row.
 */
export function assertDragWhileRenaming({ before, legs }: ConcurrentRun): void {
  const c = CONCURRENT;
  assertConverged(legs);
  assertFieldEverywhere(legs, 'version_task', c.link, 'status', 'done');
  assertFieldEverywhere(legs, 'task', c.task, 'title', c.renamed);
  // The drop into an empty column writes the sort key it already had, so the
  // only data field of the link that changes is its status.
  assertChangedFieldsEverywhere(before, legs, 'version_task', c.link, ['status']);
  assertChangedFieldsEverywhere(before, legs, 'task', c.task, ['title']);
  assertIsolatedEverywhere(before, legs, [
    { store: 'version_task', id: c.link },
    { store: 'task', id: c.task },
  ]);
  assertInvariantsEverywhere(legs);
}
