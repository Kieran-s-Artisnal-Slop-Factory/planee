import type { Locator, Page } from '@playwright/test';
import { test, expect } from './helpers/devices';
import type { Device } from './helpers/devices';
import { assertConverged, assertFieldEverywhere, capture } from './helpers/oracle';
import {
  assertChangedFieldsEverywhere,
  assertInvariantsEverywhere,
  assertIsolatedEverywhere,
  backdate,
  boardPath,
  cardDialog,
  cardIn,
  columnIds,
  dragCard,
  expectBoardUrl,
  expectSettledCard,
  openBoard,
  openCardDialog,
  openSourceEditor,
  pollRow,
  seedProject,
  syncAll,
  topOfColumn,
  aboveCard,
  typeSource,
  urlParts,
  waitForBoard,
  waitForHook,
} from './helpers/board';

/**
 * Phase 10b's navigation, through the real UI (D16–D20): the slim navbar, the
 * FAB's create dialogs, the command palette, `?task=` deep links, the
 * recent-issues strip on Home, and a MarkdownField's keys inside the card
 * dialog.
 *
 * Cases that change data sync both devices and assert all four legs, the
 * intended values and the structural invariants.
 */

/** Open the FAB's menu and pick an item; resolves with the create dialog. */
async function openFab(page: Page, kind: 'task' | 'version' | 'project'): Promise<Locator> {
  await page.getByTestId('fab').click();
  await expect(page.getByTestId('fab-menu')).toBeVisible();
  await page.getByTestId('fab-new-' + kind).click();
  const dialog = page.getByTestId('create-dialog');
  await expect(dialog).toHaveAttribute('data-kind', kind);
  await expect(page.getByTestId('fab-menu')).toHaveCount(0);
  return dialog;
}

/** Ctrl+K, then wait for the palette to hold focus. */
async function openPalette(page: Page): Promise<Locator> {
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('palette');
  await expect(palette).toBeVisible();
  await expect(palette.getByTestId('palette-input')).toBeFocused();
  return palette;
}

/** The recent-issues strip as [task id, reason] pairs, left to right. */
const strip = (page: Page): Promise<[string, string][]> =>
  page
    .getByTestId('recent-issue')
    .evaluateAll((items) => items.map((i) => [i.getAttribute('data-task-id') ?? '', i.getAttribute('data-reason') ?? ''] as [string, string]));

/** Mark the window: a full reload or navigation would wipe it. */
const markNoReload = (page: Page) => page.evaluate(() => ((window as unknown as Record<string, unknown>).__noReload = true));
const stillNoReload = (page: Page) => page.evaluate(() => (window as unknown as Record<string, unknown>).__noReload === true);

// ---------------------------------------------------------------------------
// a. Navbar
// ---------------------------------------------------------------------------

test('the navbar links only Home, Preferences and Settings, plus the palette button', async ({ deviceA }) => {
  const page = deviceA.page;
  for (const path of ['/', '/settings/', '/task/']) {
    await deviceA.goto(path);
    const nav = page.locator('#site-nav');
    await expect(nav.locator('a')).toHaveText(['Home', 'Preferences', 'Settings']);
    expect(await nav.locator('a').evaluateAll((links) => links.map((a) => a.getAttribute('href')))).toEqual([
      '/',
      '/preferences/',
      '/settings/',
    ]);
    // The header holds nothing else to navigate with: the brand and those three.
    await expect(page.locator('header.navbar a')).toHaveCount(4);
    await expect(page.locator('header.navbar a.brand')).toHaveAttribute('href', '/');
    await expect(page.getByTestId('nav-palette')).toBeVisible();
  }
  await expect(page.locator('#site-nav a[aria-current="page"]')).toHaveCount(0);
  await deviceA.goto('/settings/');
  await expect(page.locator('#site-nav a[aria-current="page"]')).toHaveText('Settings');

  // The button opens the palette.
  await page.getByTestId('nav-palette').click();
  await expect(page.getByTestId('palette')).toBeVisible();
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// b–d. FAB
// ---------------------------------------------------------------------------

test('FAB New Task on a board: prefilled project and version, description saved with Ctrl+S, card appears live, synced', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await seedProject(deviceA, {
    project: { id: 'fab-p', name: 'Fab project' },
    versions: [{ id: 'fab-v1', number: '0.1.0' }, { id: 'fab-v2', number: '0.2.0' }],
    cards: [{ task: 'fab-old', link: 'fab-old-l', title: 'Already here', status: 'todo', position: 0 }],
  });
  // A second project, so the prefill is a choice and not the only option.
  await seedProject(deviceA, { project: { id: 'fab-other', name: 'Another project' }, versions: [], cards: [] });
  await syncAll(deviceA, deviceB);
  const page = deviceA.page;
  await openBoard(deviceA, 'fab-p', 'fab-v1');
  await expectSettledCard(page, 'todo', 'fab-old-l');
  const before = await capture(deviceA, deviceB, backend);
  await markNoReload(page);

  const dialog = await openFab(page, 'task');
  const form = dialog.getByTestId('task-create-form');
  await expect(form.getByTestId('task-create-project')).toHaveValue('fab-p');
  await expect(form.getByTestId('task-create-version-fab-v1')).toBeChecked();
  await expect(form.getByTestId('task-create-version-fab-v2')).not.toBeChecked();
  await expect(form.getByTestId('task-create-title')).toBeFocused();
  await form.getByTestId('task-create-title').fill('Write the FAB docs');

  // The description, typed in the Source tab and saved with Ctrl+S inside the dialog.
  const lines = ['## Plan', '', '- [ ] draft', '- [ ] review'];
  const intended = lines.join('\n');
  const field = form.getByTestId('task-create-description');
  const source = await openSourceEditor(field, 'task-create-description');
  await expect(form.getByTestId('task-create-submit')).toBeDisabled();
  await typeSource(page, source, lines);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(field.getByTestId('task-create-description-edit')).toBeVisible();
  await expect(field.getByTestId('task-create-description-save')).toHaveCount(0);
  // Ctrl+S kept the text in the draft (nothing stored yet) and left the dialog open.
  await expect(dialog).toBeVisible();
  await expect(field.locator('[data-testid="task-create-description-preview"] h2')).toHaveText('Plan');
  expect((await deviceA.dump('task')).filter((t) => t.title === 'Write the FAB docs')).toEqual([]);

  await form.getByTestId('task-create-submit').click();
  await expect(dialog).toHaveCount(0);
  const toast = page.getByTestId('toast');
  await expect(toast).toContainText('Write the FAB docs');

  const tasks = (await deviceA.dump('task')).filter((t) => t.title === 'Write the FAB docs');
  expect(tasks).toHaveLength(1);
  const taskId = String(tasks[0]!.id);
  expect(tasks[0]).toMatchObject({
    project: 'fab-p',
    title: 'Write the FAB docs',
    task_type: 'feature',
    priority: 4,
    description: intended,
    subtasks: null,
    deleted_at: null,
  });
  const links = (await deviceA.dump('version_task')).filter((l) => l.task === taskId);
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({ version: 'fab-v1', status: 'todo', deleted_at: null });
  expect(links[0]!.position as number).toBeLessThan(0);
  const linkId = String(links[0]!.id);

  // The toast's Open is the task's deep link.
  await expect(toast.getByTestId('toast-open')).toHaveAttribute('href', boardPath('fab-p', 'fab-v1', taskId));

  // The open board shows the card at the top of TODO, without a reload.
  await expectSettledCard(page, 'todo', linkId);
  await expect.poll(() => columnIds(page, 'todo')).toEqual([linkId, 'fab-old-l']);
  expect(await stillNoReload(page)).toBe(true);

  await syncAll(deviceA, deviceB);
  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'task', taskId, 'title', 'Write the FAB docs');
  assertFieldEverywhere(legs, 'task', taskId, 'description', intended);
  assertFieldEverywhere(legs, 'task', taskId, 'project', 'fab-p');
  assertFieldEverywhere(legs, 'version_task', linkId, 'task', taskId);
  assertFieldEverywhere(legs, 'version_task', linkId, 'version', 'fab-v1');
  assertFieldEverywhere(legs, 'version_task', linkId, 'status', 'todo');
  assertIsolatedEverywhere(before, legs, [
    { store: 'task', id: taskId },
    { store: 'version_task', id: linkId },
  ]);
  assertInvariantsEverywhere(legs);

  // B's board has the card too.
  await openBoard(deviceB, 'fab-p', 'fab-v1');
  await expect.poll(() => columnIds(deviceB.page, 'todo')).toEqual([linkId, 'fab-old-l']);
});

test('FAB New Version suggests the next number and opens the new version board, synced', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await seedProject(deviceA, {
    project: { id: 'nv-p', name: 'Versions' },
    versions: [{ id: 'nv-v1', number: '0.1.0' }],
    cards: [{ task: 'nv-t', link: 'nv-l', title: 'Something', status: 'todo' }],
  });
  await syncAll(deviceA, deviceB);
  const page = deviceA.page;
  await openBoard(deviceA, 'nv-p', 'nv-v1');
  const before = await capture(deviceA, deviceB, backend);

  const dialog = await openFab(page, 'version');
  await expect(dialog.getByTestId('version-create-project')).toHaveValue('nv-p');
  await expect(dialog.getByTestId('version-create-number')).toHaveValue('0.2.0');
  await expect(dialog.getByTestId('version-create-completed')).not.toBeChecked();
  await dialog.getByTestId('version-create-submit').click();

  await page.waitForURL((url) => url.pathname === '/' && !!url.searchParams.get('version') && url.searchParams.get('version') !== 'nv-v1');
  await waitForHook(page);
  const created = (await deviceA.dump('version')).filter((v) => v.number === '0.2.0');
  expect(created).toHaveLength(1);
  const versionId = String(created[0]!.id);
  expect(created[0]).toMatchObject({ project: 'nv-p', completed: false, description: null, deleted_at: null });
  await waitForBoard(page, 'nv-p', versionId);
  expect(urlParts(page)).toEqual({ path: '/', params: { project: 'nv-p', version: versionId } });
  await expect(page.getByTestId('board-version-title')).toHaveText('Version 0.2.0');
  await expect(page.locator('[data-kanban-card]')).toHaveCount(0);

  await syncAll(deviceA, deviceB);
  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'version', versionId, 'number', '0.2.0');
  assertFieldEverywhere(legs, 'version', versionId, 'project', 'nv-p');
  assertFieldEverywhere(legs, 'version', versionId, 'completed', false);
  assertIsolatedEverywhere(before, legs, [{ store: 'version', id: versionId }]);
  assertInvariantsEverywhere(legs);
});

test('FAB New Project without a first version lands on the create-first-version board, synced', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  const page = deviceA.page;
  const before = await capture(deviceA, deviceB, backend);

  const dialog = await openFab(page, 'project');
  await dialog.getByTestId('project-create-name').fill('Bare project');
  await dialog.getByTestId('project-create-first-version').uncheck();
  await dialog.getByTestId('project-create-submit').click();

  await page.waitForURL((url) => url.pathname === '/' && !!url.searchParams.get('project'));
  await waitForHook(page);
  const projects = await deviceA.dump('project');
  expect(projects).toHaveLength(1);
  const projectId = String(projects[0]!.id);
  expect(projects[0]).toMatchObject({ name: 'Bare project', description: '', deleted_at: null });
  expect(await deviceA.dump('version')).toEqual([]);

  const root = page.getByTestId('board-root');
  await expect(root).toHaveAttribute('data-project', projectId);
  await expect(root).toHaveAttribute('data-version', '');
  await expect(page.getByTestId('board-create-first-version')).toBeVisible();
  await expect(page.getByTestId('board-project-select')).toHaveValue(projectId);
  await expect(page.locator('[data-kanban-column]')).toHaveCount(0);
  await expect.poll(() => urlParts(page)).toEqual({ path: '/', params: { project: projectId } });

  await syncAll(deviceA, deviceB);
  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'project', projectId, 'name', 'Bare project');
  assertIsolatedEverywhere(before, legs, [{ store: 'project', id: projectId }]);
  for (const leg of [legs.a, legs.b, legs.served, legs.stored]) expect(leg.version ?? []).toEqual([]);
  assertInvariantsEverywhere(legs);
});

// ---------------------------------------------------------------------------
// e–f. Command palette
// ---------------------------------------------------------------------------

test('palette: Ctrl+K from the board and from inside a Source editor, Escape closes only the palette, search opens a deep link, Recent and Pages', async ({
  deviceA,
}) => {
  await seedProject(deviceA, {
    project: { id: 'pal-a', name: 'Alpha' },
    versions: [{ id: 'pal-a-v', number: '0.1.0' }],
    cards: [{ task: 'pal-a-t', link: 'pal-a-l', title: 'Plain card', status: 'todo' }],
  });
  await seedProject(deviceA, {
    project: { id: 'pal-z', name: 'Zulu' },
    versions: [{ id: 'pal-z-v1', number: '0.1.0' }, { id: 'pal-z-v2', number: '0.2.0' }],
    cards: [
      { task: 'pal-z-other', link: 'pal-z-other-l', version: 'pal-z-v1', title: 'Other work', status: 'todo' },
      { task: 'pal-quokka', link: 'pal-quokka-l', version: 'pal-z-v2', title: 'Count the quokkas', status: 'in_progress' },
    ],
  });
  const page = deviceA.page;
  await openBoard(deviceA, 'pal-a', 'pal-a-v');

  // From the board.
  let palette = await openPalette(page);
  await expect(palette.getByTestId('palette-item').first()).toHaveAttribute('data-kind', 'action');
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);

  // From inside a MarkdownField's Source editor in the card dialog.
  const dialog = await openCardDialog(page, 'pal-a-l');
  const field = dialog.getByTestId('task-description');
  const source = await openSourceEditor(field, 'task-description');
  await typeSource(page, source, ['half a thought']);
  await expect(source).toBeFocused();
  palette = await openPalette(page);
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  // Only the palette closed: the dialog and the editor (with its text) are still there.
  await expect(dialog).toBeVisible();
  await expect(field.getByTestId('task-description-save')).toBeVisible();
  await expect(source).toHaveText('half a thought');
  await expect(source).toBeFocused();
  // Ctrl+K did not reach the editor as a keystroke.
  await page.keyboard.type(', finished');
  await expect(source).toHaveText('half a thought, finished');
  await field.getByTestId('task-description-cancel').click();
  await expect(field.getByTestId('task-description-edit')).toBeVisible();
  expect(await deviceA.get('task', 'pal-a-t')).toMatchObject({ description: null });
  await dialog.locator('.close').click();
  await expect(dialog).toHaveCount(0);

  // Search: part of a title, Enter opens its deep link — in another project and version.
  palette = await openPalette(page);
  await page.keyboard.type('quokka');
  const first = palette.getByTestId('palette-item').first();
  await expect(first).toHaveAttribute('data-kind', 'task');
  await expect(first).toHaveAttribute('data-id', 'pal-quokka');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => url.searchParams.get('task') === 'pal-quokka');
  await waitForHook(page);
  await waitForBoard(page, 'pal-z', 'pal-z-v2');
  const opened = cardDialog(page);
  await expect(opened).toBeVisible();
  await expect(opened.locator('h2')).toHaveText('Count the quokkas');
  await expectBoardUrl(page, { project: 'pal-z', version: 'pal-z-v2', task: 'pal-quokka' });

  // Empty query: Recent leads with the task just opened.
  palette = await openPalette(page);
  const recent = palette.locator('.group').filter({ has: page.locator('.group-name', { hasText: /^Recent$/ }) });
  const recentFirst = recent.getByTestId('palette-item').first();
  await expect(recentFirst).toHaveAttribute('data-kind', 'task');
  await expect(recentFirst).toHaveAttribute('data-id', 'pal-quokka');

  // Pages: Assets.
  await palette.locator('[data-testid="palette-item"][data-kind="page"][data-id="/asset/"]').click();
  await page.waitForURL((url) => url.pathname === '/asset/');
  await waitForHook(page);
  await expect(page.getByTestId('palette')).toHaveCount(0);
});

test('palette actions open the FAB create dialogs, prefilled from the board', async ({ deviceA }) => {
  await seedProject(deviceA, {
    project: { id: 'act-p', name: 'Actions' },
    versions: [{ id: 'act-v', number: '0.1.0' }],
    cards: [],
  });
  const page = deviceA.page;
  await openBoard(deviceA, 'act-p', 'act-v');
  const before = await deviceA.dumpAll();

  // Keyboard: the second action is New Version.
  let palette = await openPalette(page);
  const actions = palette.locator('[data-testid="palette-item"][data-kind="action"]');
  await expect(actions).toHaveCount(3);
  await expect(actions.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(actions.nth(1)).toHaveAttribute('data-id', 'version');
  await expect(actions.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  let create = page.getByTestId('create-dialog');
  await expect(create).toHaveAttribute('data-kind', 'version');
  await expect(create.getByTestId('version-create-project')).toHaveValue('act-p');
  await expect(create.getByTestId('version-create-number')).toHaveValue('0.2.0');
  await create.getByTestId('create-dialog-close').click();
  await expect(create).toHaveCount(0);

  // Typed: New Task.
  palette = await openPalette(page);
  await page.keyboard.type('new task');
  const first = palette.getByTestId('palette-item').first();
  await expect(first).toHaveAttribute('data-kind', 'action');
  await expect(first).toHaveAttribute('data-id', 'task');
  await page.keyboard.press('Enter');
  create = page.getByTestId('create-dialog');
  await expect(create).toHaveAttribute('data-kind', 'task');
  await expect(create.getByTestId('task-create-project')).toHaveValue('act-p');
  await expect(create.getByTestId('task-create-version-act-v')).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(create).toHaveCount(0);

  // Opening and closing wrote nothing.
  expect(await deviceA.dumpAll()).toEqual(before);
});

// ---------------------------------------------------------------------------
// g. Deep links
// ---------------------------------------------------------------------------

test('deep links: ?task= opens the card in the version it belongs to, read-only when completed; unscheduled tasks open the editor', async ({
  deviceA,
}) => {
  await seedProject(deviceA, {
    project: { id: 'dl-a', name: 'Alpha' },
    versions: [{ id: 'dl-a-v', number: '0.1.0' }],
    cards: [{ task: 'dl-a-t', link: 'dl-a-l', title: 'First project card', status: 'todo' }],
  });
  await seedProject(deviceA, {
    project: { id: 'dl-z', name: 'Zulu' },
    versions: [
      { id: 'dl-z-v1', number: '0.1.0', completed: true },
      { id: 'dl-z-v2', number: '0.2.0' },
    ],
    cards: [
      { task: 'dl-old', link: 'dl-old-l', version: 'dl-z-v1', title: 'Finished long ago', status: 'done' },
      { task: 'dl-both', link: 'dl-both-v1', version: 'dl-z-v1', title: 'Carried over', status: 'bumped' },
      { task: 'dl-both', link: 'dl-both-v2', version: 'dl-z-v2', title: 'Carried over', status: 'todo' },
      { task: 'dl-free', title: 'Someday maybe' },
    ],
  });
  const page = deviceA.page;

  // Only link in a completed version: that version's read-only board, dialog open.
  await deviceA.goto('/?task=dl-old');
  await waitForBoard(page, 'dl-z', 'dl-z-v1');
  await expect(page.getByTestId('board-root')).toHaveAttribute('data-readonly', 'true');
  let dialog = cardDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('h2')).toHaveText('Finished long ago');
  await expectBoardUrl(page, { project: 'dl-z', version: 'dl-z-v1', task: 'dl-old' });
  // Closing strips `task` from the URL.
  await dialog.locator('.close').click();
  await expect(dialog).toHaveCount(0);
  await expectBoardUrl(page, { project: 'dl-z', version: 'dl-z-v1' });

  // Linked in a completed and an open version: the open one, editable — even
  // from a URL naming a different project and version.
  await deviceA.goto(boardPath('dl-a', 'dl-a-v', 'dl-both'));
  await waitForBoard(page, 'dl-z', 'dl-z-v2');
  await expect(page.getByTestId('board-root')).toHaveAttribute('data-readonly', 'false');
  dialog = cardDialog(page);
  await expect(dialog.locator('h2')).toHaveText('Carried over');
  await expectBoardUrl(page, { project: 'dl-z', version: 'dl-z-v2', task: 'dl-both' });
  // Escape closes it too, and strips `task` the same way.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expectBoardUrl(page, { project: 'dl-z', version: 'dl-z-v2' });

  // Unscheduled: the Task page's edit form.
  await page.goto(originOf(deviceA) + '/?task=dl-free');
  await page.waitForURL((url) => url.pathname === '/task/');
  await waitForHook(page);
  expect(urlParts(page)).toEqual({ path: '/task/', params: { edit: 'dl-free' } });
  await expect(page.locator('#f-title')).toHaveValue('Someday maybe');
  await expect(page.locator('#f-project')).toHaveValue('dl-z');
  await expect(page.getByTestId('task-notice')).toHaveCount(0);

  // A task that is gone: the Task page says so.
  await deviceA.goto('/task/?edit=no-such-task');
  await expect(page.getByTestId('task-notice')).toHaveText('That task no longer exists.');
  await expect(page.locator('#f-title')).toHaveCount(0);
});

/** The backend origin a device's page is on. */
const originOf = (device: Device) => new URL(device.page.url()).origin;

// ---------------------------------------------------------------------------
// h. Recent issues
// ---------------------------------------------------------------------------

test('recent issues: newest six, views (per device), remote title edits and column moves rank; reorders do not; the synced count', async ({
  deviceA,
  deviceB,
  backend: server,
}) => {
  const ids = [1, 2, 3, 4, 5, 6, 7, 8];
  await seedProject(deviceA, {
    project: { id: 'ri-p', name: 'Recents' },
    versions: [{ id: 'ri-v', number: '0.1.0' }],
    cards: ids.map((i) => ({ task: 'ri-t' + i, link: 'ri-l' + i, title: 'Recent task ' + i, status: 'todo' as const, position: i })),
  });
  // Written an hour ago, a minute apart: task 8 is the newest. Link stamps
  // match their task's, so no card reads as moved.
  const base = Date.now() - 3600_000;
  for (const i of ids) {
    const at = new Date(base + i * 60_000).toISOString();
    await backdate(deviceA, 'task', 'ri-t' + i, at);
    await backdate(deviceA, 'version_task', 'ri-l' + i, at);
  }
  await syncAll(deviceA, deviceB);
  const a = deviceA.page;
  const b = deviceB.page;
  await openBoard(deviceA, 'ri-p', 'ri-v');
  await openBoard(deviceB, 'ri-p', 'ri-v');

  // Default: six, newest first, all added.
  await expect.poll(() => strip(a)).toEqual([8, 7, 6, 5, 4, 3].map((i) => ['ri-t' + i, 'added']));
  const item = (page: Page, taskId: string) => page.locator(`[data-testid="recent-issue"][data-task-id="${taskId}"]`);
  await expect(item(a, 'ri-t8').getByTestId('recent-issue-title')).toHaveText('Recent task 8');
  await expect(item(a, 'ri-t8').getByTestId('recent-issue-project')).toHaveText('Recents');
  await expect(item(a, 'ri-t8').getByTestId('recent-issue-version')).toHaveText('0.1.0');
  await expect(item(a, 'ri-t8').getByTestId('recent-issue-status')).toHaveAttribute('data-status', 'todo');
  await expect(item(a, 'ri-t8').getByTestId('recent-issue-type')).toHaveText('Feature');
  await expect(item(a, 'ri-t8').getByTestId('recent-issue-when')).toHaveText(/^Added /);

  // A opens task 2's card: it is first, viewed.
  const dialog = await openCardDialog(a, 'ri-l2');
  await expect.poll(() => strip(a)).toEqual([
    ['ri-t2', 'viewed'],
    ...[8, 7, 6, 5, 4].map((i): [string, string] => ['ri-t' + i, 'added']),
  ]);
  await expect(item(a, 'ri-t2').getByTestId('recent-issue-when')).toHaveText('Viewed just now');
  await dialog.locator('.close').click();
  await expect(dialog).toHaveCount(0);

  // B renames task 5 through its card's inline editor; A syncs it in.
  const cardOnB = cardIn(b, 'todo', 'ri-l5');
  await cardOnB.locator('.kb-pencil').click();
  await cardOnB.locator('form input[type="text"]').fill('Recent task 5, renamed');
  await cardOnB.locator('form button[type="submit"]').click();
  await pollRow(deviceB, 'task', 'ri-t5', (r) => r?.title === 'Recent task 5, renamed', 'B stored the rename');
  await syncAll(deviceB, deviceA);
  await expect.poll(() => strip(a)).toEqual([
    ['ri-t5', 'updated'],
    ['ri-t2', 'viewed'],
    ...[8, 7, 6, 4].map((i): [string, string] => ['ri-t' + i, 'added']),
  ]);
  await expect(item(a, 'ri-t5').getByTestId('recent-issue-title')).toHaveText('Recent task 5, renamed');

  // A drags task 7's card to In Progress: a status change is an update.
  await dragCard(a, cardIn(a, 'todo', 'ri-l7'), topOfColumn(a, 'in_progress'));
  await expectSettledCard(a, 'in_progress', 'ri-l7');
  await pollRow(deviceA, 'version_task', 'ri-l7', (r) => r?.status === 'in_progress', 'A stored the move');
  const afterMove: [string, string][] = [
    ['ri-t7', 'updated'],
    ['ri-t5', 'updated'],
    ['ri-t2', 'viewed'],
    ['ri-t8', 'added'],
    ['ri-t6', 'added'],
    ['ri-t4', 'added'],
  ];
  await expect.poll(() => strip(a)).toEqual(afterMove);
  await expect(item(a, 'ri-t7').getByTestId('recent-issue-status')).toHaveAttribute('data-status', 'in_progress');

  // A plain reorder within TODO (task 8 above its neighbour, task 6) is not an update.
  await dragCard(a, cardIn(a, 'todo', 'ri-l8'), aboveCard(cardIn(a, 'todo', 'ri-l6')));
  await expect.poll(() => columnIds(a, 'todo')).toEqual(['ri-l1', 'ri-l2', 'ri-l3', 'ri-l4', 'ri-l5', 'ri-l8', 'ri-l6']);
  const reordered = await pollRow(
    deviceA,
    'version_task',
    'ri-l8',
    (r) => typeof r?.position === 'number' && r.position > 5 && r.position < 6,
    'A stored the reorder between tasks 5 and 6'
  );
  expect(reordered.status).toBe('todo');
  await expectSettledCard(a, 'todo', 'ri-l8');
  expect(await strip(a)).toEqual(afterMove);
  // Force a re-rank with a known outcome: were task 8 now "updated", it would
  // sit right behind task 3 here instead of after the view of task 2.
  const dialog3 = await openCardDialog(a, 'ri-l3');
  await expect.poll(() => strip(a)).toEqual([['ri-t3', 'viewed'], ...afterMove.slice(0, 5)]);
  await dialog3.locator('.close').click();
  await expect(dialog3).toHaveCount(0);

  // The count is a synced preference, set on the Preferences page.
  await deviceA.goto('/preferences/');
  const count = a.getByTestId('preferences-recent-issues-count');
  await expect(count).toHaveValue('6');
  await a.locator('#f-default_task_type').selectOption('feature');
  await count.fill('2');
  await a.getByTestId('preferences-save').click();
  await expect(a.getByTestId('preferences-saved')).toBeVisible();
  await pollRow(deviceA, 'preferences', 'singleton', (r) => r?.recent_issues_count === 2, 'A stored the count');
  await deviceA.goto('/');
  await waitForBoard(a, 'ri-p', 'ri-v');
  await expect.poll(() => strip(a)).toEqual([
    ['ri-t3', 'viewed'],
    ['ri-t7', 'updated'],
  ]);

  // B — whose open Home follows the sync — shows two as well, ranked without A's views.
  await syncAll(deviceA, deviceB);
  await expect.poll(() => strip(b)).toEqual([
    ['ri-t7', 'updated'],
    ['ri-t5', 'updated'],
  ]);
  await expect(b.locator('[data-testid="recent-issue"][data-reason="viewed"]')).toHaveCount(0);

  const legs = await capture(deviceA, deviceB, server);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'preferences', 'singleton', 'recent_issues_count', 2);
  assertFieldEverywhere(legs, 'task', 'ri-t5', 'title', 'Recent task 5, renamed');
  assertFieldEverywhere(legs, 'version_task', 'ri-l7', 'status', 'in_progress');
  assertFieldEverywhere(legs, 'version_task', 'ri-l8', 'position', reordered.position);
  assertFieldEverywhere(legs, 'version_task', 'ri-l8', 'status', 'todo');
  assertInvariantsEverywhere(legs);
});

// ---------------------------------------------------------------------------
// i. MarkdownField keys inside the card dialog
// ---------------------------------------------------------------------------

test('in the card dialog, Ctrl+S saves the description and Escape cancels it (asking first), the dialog staying open', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await seedProject(deviceA, {
    project: { id: 'keys-p', name: 'Keys' },
    versions: [{ id: 'keys-v', number: '0.1.0' }],
    cards: [{ task: 'keys-t', link: 'keys-l', title: 'Press keys', status: 'todo', description: 'Before' }],
  });
  await syncAll(deviceA, deviceB);
  const page = deviceA.page;
  await openBoard(deviceA, 'keys-p', 'keys-v');
  await expectSettledCard(page, 'todo', 'keys-l');
  const before = await capture(deviceA, deviceB, backend);
  const prompts: string[] = [];

  const dialog = await openCardDialog(page, 'keys-l');
  const field = dialog.getByTestId('task-description');

  // Ctrl+S saves: stored, the editor closes, the dialog stays.
  let source = await openSourceEditor(field, 'task-description');
  await expect(source).toHaveText('Before');
  await typeSource(page, source, ['After Ctrl+S']);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(field.getByTestId('task-description-edit')).toBeVisible();
  await expect(field.getByTestId('task-description-save')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await pollRow(deviceA, 'task', 'keys-t', (r) => r?.description === 'After Ctrl+S', 'Ctrl+S stored the description');
  await expect(field.locator('[data-testid="task-description-preview"] .preview p')).toHaveText('After Ctrl+S');

  // Escape with changes asks. Declining keeps the editor — and the dialog — open.
  source = await openSourceEditor(field, 'task-description');
  await typeSource(page, source, ['Thrown away']);
  // Typing arms CodeMirror's completion (pending for its activation delay),
  // and an Escape in that window only closes the completion — the editor's own
  // key, which the field rightly leaves alone. Moving the caret settles it,
  // as a reader pausing would.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  page.once('dialog', (d) => {
    prompts.push(d.type() + ': ' + d.message());
    void d.dismiss();
  });
  await page.keyboard.press('Escape');
  await expect.poll(() => prompts).toEqual(['confirm: Discard your changes?']);
  await expect(dialog).toBeVisible();
  await expect(field.getByTestId('task-description-save')).toBeVisible();
  await expect(source).toHaveText('Thrown away');

  // Escape again, accepted: the editor closes, the dialog stays, nothing stored.
  page.once('dialog', (d) => {
    prompts.push(d.type() + ': ' + d.message());
    void d.accept();
  });
  await page.keyboard.press('Escape');
  await expect(field.getByTestId('task-description-edit')).toBeVisible();
  expect(prompts).toEqual(['confirm: Discard your changes?', 'confirm: Discard your changes?']);
  await expect(dialog).toBeVisible();
  await expect(field.locator('[data-testid="task-description-preview"] .preview p')).toHaveText('After Ctrl+S');
  expect(await deviceA.get('task', 'keys-t')).toMatchObject({ description: 'After Ctrl+S' });
  await expectBoardUrl(page, { project: 'keys-p', version: 'keys-v', task: 'keys-t' });

  // With the editor closed, Escape belongs to the dialog again.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expectBoardUrl(page, { project: 'keys-p', version: 'keys-v' });
  // The card behind it shows the saved description.
  await expect(cardIn(page, 'todo', 'keys-l')).toContainText('After Ctrl+S');
  await expect(cardIn(page, 'todo', 'keys-l')).not.toContainText('Before');

  await syncAll(deviceA, deviceB);
  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'task', 'keys-t', 'description', 'After Ctrl+S');
  assertChangedFieldsEverywhere(before, legs, 'task', 'keys-t', ['description']);
  assertIsolatedEverywhere(before, legs, [{ store: 'task', id: 'keys-t' }]);
  assertInvariantsEverywhere(legs);
});
