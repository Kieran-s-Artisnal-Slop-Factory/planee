import type { Locator, Page } from '@playwright/test';
import { test, expect } from './helpers/devices';
import { assertConverged, assertFieldEverywhere, capture } from './helpers/oracle';
import {
  assertChangedFieldsEverywhere,
  assertInvariantsEverywhere,
  assertIsolatedEverywhere,
  cardDialog,
  cardIn,
  columnIds,
  columnLocator,
  expectFocusedCard,
  expectSettledCard,
  holdCtrl,
  openBoard,
  openSourceEditor,
  pollRow,
  seedProject,
  syncAll,
  typeSource,
  urlParts,
  waitForHook,
  type Column,
} from './helpers/board';

/**
 * Phase 10c-K: the app's keybinds (D23–D28), pressed through the real UI —
 * the global create keys, the board's column/project/version keys, the
 * focusable cards with keyboard navigation and moves, the Edit version modal,
 * and the Ctrl-hold overlay.
 *
 * Every case that changes data syncs both devices and asserts all four legs,
 * the intended values, the isolation of the delta and the invariants. A
 * keyboard move must go through the same commit as a drag (planDrop →
 * onUpdate → patch), so it is checked the same way a drag is.
 */

/** Nothing in the create dialog opened (after giving a wrong handler time to act). */
async function expectNoDialog(page: Page, testid = 'create-dialog'): Promise<void> {
  await page.waitForTimeout(150);
  await expect(page.getByTestId(testid)).toHaveCount(0);
}

/** The board's rows on a device: what a key that must not write would have changed. */
async function boardRows(device: { dump(store: string): Promise<Record<string, unknown>[]> }) {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const store of ['project', 'version', 'task', 'version_task']) out[store] = await device.dump(store);
  return out;
}

const overlay = (page: Page): Locator => page.getByTestId('keybind-overlay');
const badge = (page: Page, id: string): Locator => page.locator(`[data-testid="keybind-badge"][data-keybind-id="${id}"]`);
const sheetRow = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="keybind-sheet-row"][data-keybind-id="${id}"]`);

// ---------------------------------------------------------------------------
// Board: new task per column (D26)
// ---------------------------------------------------------------------------

test('Ctrl+1/2/3 open New Task with the status preset and the board prefilled; each task lands on top of its column, synced', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await seedProject(deviceA, {
    project: { id: 'kn-p', name: 'Keyed project' },
    versions: [
      { id: 'kn-v1', number: '0.1.0' },
      { id: 'kn-v2', number: '0.2.0' },
    ],
    cards: [
      { task: 'kn-t', link: 'kn-tl', title: 'Old todo', status: 'todo', position: 0 },
      { task: 'kn-i', link: 'kn-il', title: 'Old progress', status: 'in_progress', position: 0 },
      { task: 'kn-d', link: 'kn-dl', title: 'Old done', status: 'wontfix', position: 0 },
    ],
  });
  await seedProject(deviceA, { project: { id: 'kn-other', name: 'Another project' }, versions: [], cards: [] });
  await syncAll(deviceA, deviceB);
  const page = deviceA.page;
  await openBoard(deviceA, 'kn-p', 'kn-v1');
  await expectSettledCard(page, 'todo', 'kn-tl');
  const before = await capture(deviceA, deviceB, backend);

  const cases: { key: string; status: string; column: Column; title: string; old: string }[] = [
    { key: 'Control+1', status: 'todo', column: 'todo', title: 'Keyed todo', old: 'kn-tl' },
    { key: 'Control+2', status: 'in_progress', column: 'in_progress', title: 'Keyed progress', old: 'kn-il' },
    { key: 'Control+3', status: 'done', column: 'done', title: 'Keyed done', old: 'kn-dl' },
  ];
  const created: { task: string; link: string; status: string; title: string; column: Column; old: string }[] = [];
  for (const c of cases) {
    await page.keyboard.press(c.key);
    const dialog = page.getByTestId('create-dialog');
    await expect(dialog).toHaveAttribute('data-kind', 'task');
    const form = dialog.getByTestId('task-create-form');
    await expect(form.getByTestId('task-create-status')).toHaveValue(c.status);
    await expect(form.getByTestId('task-create-project')).toHaveValue('kn-p');
    await expect(form.getByTestId('task-create-version-kn-v1')).toBeChecked();
    await expect(form.getByTestId('task-create-version-kn-v2')).not.toBeChecked();
    await expect(form.getByTestId('task-create-title')).toBeFocused();
    await form.getByTestId('task-create-title').fill(c.title);
    await form.getByTestId('task-create-submit').click();
    await expect(dialog).toHaveCount(0);

    const tasks = (await deviceA.dump('task')).filter((t) => t.title === c.title);
    expect(tasks).toHaveLength(1);
    const taskId = String(tasks[0]!.id);
    const links = (await deviceA.dump('version_task')).filter((l) => l.task === taskId);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ version: 'kn-v1', status: c.status, deleted_at: null });
    expect(links[0]!.position as number).toBeLessThan(0);
    const linkId = String(links[0]!.id);
    // On the open board, at the top of its column, without a reload.
    await expectSettledCard(page, c.column, linkId);
    await expect.poll(() => columnIds(page, c.column)).toEqual([linkId, c.old]);
    created.push({ task: taskId, link: linkId, status: c.status, title: c.title, column: c.column, old: c.old });
  }

  await syncAll(deviceA, deviceB);
  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  for (const c of created) {
    assertFieldEverywhere(legs, 'task', c.task, 'title', c.title);
    assertFieldEverywhere(legs, 'task', c.task, 'project', 'kn-p');
    assertFieldEverywhere(legs, 'version_task', c.link, 'status', c.status);
    assertFieldEverywhere(legs, 'version_task', c.link, 'version', 'kn-v1');
    assertFieldEverywhere(legs, 'version_task', c.link, 'task', c.task);
  }
  assertIsolatedEverywhere(
    before,
    legs,
    created.flatMap((c) => [
      { store: 'task', id: c.task },
      { store: 'version_task', id: c.link },
    ])
  );
  assertInvariantsEverywhere(legs);

  await openBoard(deviceB, 'kn-p', 'kn-v1');
  for (const c of created) await expect.poll(() => columnIds(deviceB.page, c.column)).toEqual([c.link, c.old]);
});

// ---------------------------------------------------------------------------
// Board: focusable cards (D23)
// ---------------------------------------------------------------------------

test('Ctrl+Shift+1/2/3 focus a column’s first card; Tab/PageDown and Shift+Tab/PageUp walk the cards across columns; the ends fall through; Enter opens', async ({
  deviceA,
}) => {
  await seedProject(deviceA, {
    project: { id: 'kf-p', name: 'Focus' },
    versions: [{ id: 'kf-v1', number: '0.1.0' }],
    cards: [
      { task: 'kf-a', link: 'kf-al', title: 'Alpha', status: 'todo', position: 0 },
      { task: 'kf-b', link: 'kf-bl', title: 'Bravo', status: 'todo', position: 1 },
      { task: 'kf-c', link: 'kf-cl', title: 'Charlie', status: 'done', position: 0 },
    ],
  });
  const page = deviceA.page;
  await openBoard(deviceA, 'kf-p', 'kf-v1');
  await expectSettledCard(page, 'done', 'kf-cl');
  const before = await boardRows(deviceA);

  await page.keyboard.press('Control+Shift+1');
  await expectFocusedCard(page, 'kf-al');
  await expect(cardIn(page, 'todo', 'kf-al')).toBeFocused();
  // Focused from the keyboard: the ring shows.
  await expect(cardIn(page, 'todo', 'kf-al')).toHaveCSS('outline-style', 'solid');

  // Down the column, then on past the empty In Progress into Done.
  await page.keyboard.press('Tab');
  await expectFocusedCard(page, 'kf-bl');
  await page.keyboard.press('PageDown');
  await expectFocusedCard(page, 'kf-cl');
  // And back.
  await page.keyboard.press('Shift+Tab');
  await expectFocusedCard(page, 'kf-bl');
  await page.keyboard.press('PageUp');
  await expectFocusedCard(page, 'kf-al');

  // Before the first card Shift+Tab is ordinary focus movement: the column's own + button.
  await page.keyboard.press('Shift+Tab');
  await expectFocusedCard(page, null);
  await expect(columnLocator(page, 'todo').locator('.kb-add')).toBeFocused();

  // An empty column has no first card: it flashes and focus stays put.
  await page.keyboard.press('Control+Shift+2');
  await expect(columnLocator(page, 'in_progress')).toHaveClass(/\bflash\b/);
  await expect(columnLocator(page, 'todo').locator('.kb-add')).toBeFocused();

  await page.keyboard.press('Control+Shift+3');
  await expectFocusedCard(page, 'kf-cl');
  // After the last card Tab is ordinary focus movement too: into the card's own controls.
  await page.keyboard.press('Tab');
  await expectFocusedCard(page, null);
  await expect(cardIn(page, 'done', 'kf-cl').locator('.kb-grip')).toBeFocused();

  // Enter on a focused card opens it; closing puts focus back on the card.
  await page.keyboard.press('Control+Shift+1');
  await expectFocusedCard(page, 'kf-al');
  await page.keyboard.press('Enter');
  const dialog = cardDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('h2')).toHaveText('Alpha');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expectFocusedCard(page, 'kf-al');

  // A click focuses a card quietly; a double-click still edits it inline, title focused.
  const bravo = cardIn(page, 'todo', 'kf-bl');
  await bravo.locator('.kb-badges').dblclick();
  const inline = bravo.locator('form input[type="text"]');
  await expect(inline).toBeFocused();
  await expect(inline).toHaveValue('Bravo');
  await page.keyboard.press('Escape');
  await expect(inline).toHaveCount(0);

  // Looking around writes nothing.
  expect(await boardRows(deviceA)).toEqual(before);
});

test('keyboard moves: Ctrl+↓/↑ reorder, Ctrl+→/← change column (Done → In Progress whatever the resolution), focus follows the card, edges are no-ops; converges on B', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await seedProject(deviceA, {
    project: { id: 'km-p', name: 'Moves' },
    versions: [{ id: 'km-v1', number: '0.1.0' }],
    cards: [
      { task: 'km-1', link: 'km-1l', title: 'One', status: 'todo', position: 10 },
      { task: 'km-2', link: 'km-2l', title: 'Two', status: 'todo', position: 11 },
      { task: 'km-3', link: 'km-3l', title: 'Three', status: 'todo', position: 12 },
      { task: 'km-d', link: 'km-dl', title: 'Resolved', status: 'wontfix', position: 5 },
    ],
  });
  await syncAll(deviceA, deviceB);
  const page = deviceA.page;
  await openBoard(deviceA, 'km-p', 'km-v1');
  await openBoard(deviceB, 'km-p', 'km-v1');
  await expectSettledCard(page, 'done', 'km-dl');
  const before = await capture(deviceA, deviceB, backend);

  const link = (id: string) => pollRow(deviceA, 'version_task', id, () => true, id);
  const expectLink = (id: string, status: string, position: number) =>
    pollRow(deviceA, 'version_task', id, (r) => r?.status === status && r?.position === position, `${id} is ${status} @ ${position}`);

  await page.keyboard.press('Control+Shift+1');
  await expectFocusedCard(page, 'km-1l');

  // Down, down, up: between its neighbours, through the same planDrop keys a drag writes.
  await page.keyboard.press('Control+ArrowDown');
  await expect.poll(() => columnIds(page, 'todo')).toEqual(['km-2l', 'km-1l', 'km-3l']);
  await expectFocusedCard(page, 'km-1l');
  await expectLink('km-1l', 'todo', 11.5);
  await page.keyboard.press('Control+ArrowDown');
  await expect.poll(() => columnIds(page, 'todo')).toEqual(['km-2l', 'km-3l', 'km-1l']);
  await expectFocusedCard(page, 'km-1l');
  await expectLink('km-1l', 'todo', 13);
  // The bottom of the column: nothing to do.
  await page.keyboard.press('Control+ArrowDown');
  await page.keyboard.press('Control+ArrowUp');
  await expect.poll(() => columnIds(page, 'todo')).toEqual(['km-2l', 'km-1l', 'km-3l']);
  await expectFocusedCard(page, 'km-1l');
  await expectLink('km-1l', 'todo', 11.5);

  // Right, right, left: to the top of each column, status changing with it.
  await page.keyboard.press('Control+ArrowRight');
  await expectSettledCard(page, 'in_progress', 'km-1l');
  await expectFocusedCard(page, 'km-1l');
  await expectLink('km-1l', 'in_progress', 0);
  await page.keyboard.press('Control+ArrowRight');
  await expect.poll(() => columnIds(page, 'done')).toEqual(['km-1l', 'km-dl']);
  await expectFocusedCard(page, 'km-1l');
  await expectLink('km-1l', 'done', 4);
  await page.keyboard.press('Control+ArrowLeft');
  await expectSettledCard(page, 'in_progress', 'km-1l');
  await expectFocusedCard(page, 'km-1l');
  await expectLink('km-1l', 'in_progress', 0);

  // A wontfix card in Done: right is the board's edge; left is In Progress.
  await page.keyboard.press('Control+Shift+3');
  await expectFocusedCard(page, 'km-dl');
  await page.keyboard.press('Control+ArrowRight');
  await page.waitForTimeout(150);
  await expect.poll(() => columnIds(page, 'done')).toEqual(['km-dl']);
  expect(await link('km-dl')).toMatchObject({ status: 'wontfix', position: 5 });
  await page.keyboard.press('Control+ArrowLeft');
  await expect.poll(() => columnIds(page, 'in_progress')).toEqual(['km-dl', 'km-1l']);
  await expectFocusedCard(page, 'km-dl');
  await expectLink('km-dl', 'in_progress', -1);

  // TODO's top card: up and left are both edges.
  await page.keyboard.press('Control+Shift+1');
  await expectFocusedCard(page, 'km-2l');
  await page.keyboard.press('Control+ArrowUp');
  await page.keyboard.press('Control+ArrowLeft');
  await page.waitForTimeout(150);
  await expect.poll(() => columnIds(page, 'todo')).toEqual(['km-2l', 'km-3l']);
  await expectFocusedCard(page, 'km-2l');

  // The moves were queued like any board write, then B's open board follows the sync.
  const outbox = (await deviceA.outbox()).map((e) => e.key);
  expect(outbox).toEqual(expect.arrayContaining(['version_task:km-1l', 'version_task:km-dl']));
  await syncAll(deviceA, deviceB);
  await expect.poll(() => columnIds(deviceB.page, 'in_progress')).toEqual(['km-dl', 'km-1l']);
  await expect.poll(() => columnIds(deviceB.page, 'todo')).toEqual(['km-2l', 'km-3l']);
  await expect.poll(() => columnIds(deviceB.page, 'done')).toEqual([]);

  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'version_task', 'km-1l', 'status', 'in_progress');
  assertFieldEverywhere(legs, 'version_task', 'km-1l', 'position', 0);
  assertFieldEverywhere(legs, 'version_task', 'km-dl', 'status', 'in_progress');
  assertFieldEverywhere(legs, 'version_task', 'km-dl', 'position', -1);
  assertChangedFieldsEverywhere(before, legs, 'version_task', 'km-1l', ['position', 'status']);
  assertChangedFieldsEverywhere(before, legs, 'version_task', 'km-dl', ['position', 'status']);
  // Only the two moved links: not their tasks, not the cards they passed.
  assertIsolatedEverywhere(before, legs, [
    { store: 'version_task', id: 'km-1l' },
    { store: 'version_task', id: 'km-dl' },
  ]);
  assertInvariantsEverywhere(legs);
});

test('the grip’s own keyboard drag (Space, arrows, Space) still moves a card through the shared commit, synced', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await seedProject(deviceA, {
    project: { id: 'kd-p', name: 'Grip' },
    versions: [{ id: 'kd-v1', number: '0.1.0' }],
    cards: [
      { task: 'kd-a', link: 'kd-al', title: 'Lift me', status: 'todo', position: 3 },
      { task: 'kd-b', link: 'kd-bl', title: 'Stay', status: 'in_progress', position: 0 },
    ],
  });
  await syncAll(deviceA, deviceB);
  const page = deviceA.page;
  await openBoard(deviceA, 'kd-p', 'kd-v1');
  await expectSettledCard(page, 'todo', 'kd-al');
  const before = await capture(deviceA, deviceB, backend);

  const grip = cardIn(page, 'todo', 'kd-al').locator('.kb-grip');
  await grip.focus();
  await page.keyboard.press('Space');
  await expect(cardIn(page, 'todo', 'kd-al')).toHaveClass(/\blifted\b/);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expectSettledCard(page, 'in_progress', 'kd-al');
  await expect.poll(() => columnIds(page, 'in_progress')).toEqual(['kd-bl', 'kd-al']);
  // Focus stays with the card's grip, as before.
  await expect(cardIn(page, 'in_progress', 'kd-al').locator('.kb-grip')).toBeFocused();
  await pollRow(deviceA, 'version_task', 'kd-al', (r) => r?.status === 'in_progress' && r?.position === 1, 'stored below Stay');

  await syncAll(deviceA, deviceB);
  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'version_task', 'kd-al', 'status', 'in_progress');
  assertFieldEverywhere(legs, 'version_task', 'kd-al', 'position', 1);
  assertChangedFieldsEverywhere(before, legs, 'version_task', 'kd-al', ['position', 'status']);
  assertIsolatedEverywhere(before, legs, [{ store: 'version_task', id: 'kd-al' }]);
  assertInvariantsEverywhere(legs);
});

test('Ctrl+E opens the focused card’s dialog with its editor; Ctrl+4 focuses the project picker; Ctrl+Shift+C starts Mark complete; keys stand down under a dialog', async ({
  deviceA,
}) => {
  await seedProject(deviceA, {
    project: { id: 'ke-p', name: 'Edit keys' },
    versions: [{ id: 'ke-v1', number: '0.1.0' }],
    cards: [
      { task: 'ke-a', link: 'ke-al', title: 'Edit me', status: 'todo', position: 0 },
      { task: 'ke-b', link: 'ke-bl', title: 'Started', status: 'in_progress', position: 0 },
    ],
  });
  const page = deviceA.page;
  await openBoard(deviceA, 'ke-p', 'ke-v1');
  await expectSettledCard(page, 'todo', 'ke-al');

  await page.keyboard.press('Control+Shift+1');
  await expectFocusedCard(page, 'ke-al');
  await page.keyboard.press('Control+e');
  const dialog = cardDialog(page);
  await expect(dialog).toBeVisible();
  const title = dialog.locator('form input[type="text"]');
  await expect(title).toHaveValue('Edit me');
  expect(urlParts(page).params).toMatchObject({ task: 'ke-a' });
  // Card keys are off while the dialog owns the keyboard.
  await page.keyboard.press('Control+2');
  await expectNoDialog(page);
  // Escape leaves the editor, a second one the dialog; focus returns to the card.
  await page.keyboard.press('Escape');
  await expect(title).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expectFocusedCard(page, 'ke-al');

  await page.keyboard.press('Control+4');
  await expect(page.getByTestId('board-project-select')).toBeFocused();
  // Close a picker the browser may have opened, and step out of the field.
  await page.keyboard.press('Escape');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await page.keyboard.press('Control+Shift+c');
  const complete = page.getByTestId('complete-dialog');
  await expect(complete).toBeVisible();
  await expect(complete).toContainText('2 tasks are still open (1 TODO, 1 in progress)');
  // The board's keys stand down under it too.
  await page.keyboard.press('Control+Shift+e');
  await expectNoDialog(page, 'edit-version-dialog');
  await complete.getByTestId('complete-dialog-cancel').click();
  await expect(complete).toHaveCount(0);
  expect(await deviceA.get('version', 'ke-v1')).toMatchObject({ completed: false });
});

// ---------------------------------------------------------------------------
// Board: Edit version (D27)
// ---------------------------------------------------------------------------

test('Ctrl+Shift+E edits the version: duplicate number warned, number + notes saved as one patch of the changed fields, converges on B', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await seedProject(deviceA, {
    project: { id: 'kv-p', name: 'Versions' },
    versions: [
      { id: 'kv-v1', number: '0.1.0', description: 'Old notes' },
      { id: 'kv-v2', number: '0.2.0' },
    ],
    cards: [{ task: 'kv-a', link: 'kv-al', title: 'Something', status: 'todo', position: 0 }],
  });
  await syncAll(deviceA, deviceB);
  const page = deviceA.page;
  await openBoard(deviceA, 'kv-p', 'kv-v1');
  await openBoard(deviceB, 'kv-p', 'kv-v1');
  await expectSettledCard(page, 'todo', 'kv-al');
  const before = await capture(deviceA, deviceB, backend);

  // The header button opens the same dialog; Cancel leaves everything as it was.
  await page.getByTestId('board-edit-version').click();
  const dialog = page.getByTestId('edit-version-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('edit-version-cancel').click();
  await expect(dialog).toHaveCount(0);

  await page.keyboard.press('Control+Shift+e');
  await expect(dialog).toBeVisible();
  const number = dialog.getByTestId('edit-version-number');
  await expect(number).toBeFocused();
  await expect(number).toHaveValue('0.1.0');
  await number.fill('0.2.0');
  await expect(dialog.getByTestId('edit-version-duplicate')).toBeVisible();
  await number.fill('');
  await expect(dialog.getByTestId('edit-version-save')).toBeDisabled();
  await number.fill('0.1.5');
  await expect(dialog.getByTestId('edit-version-duplicate')).toHaveCount(0);

  // The notes: a MarkdownField kept in the draft, saved (Ctrl+S) before the dialog saves.
  const lines = ['## Scope', '', 'Keys everywhere'];
  const notes = lines.join('\n');
  const field = dialog.getByTestId('edit-version-description');
  const source = await openSourceEditor(field, 'edit-version-description');
  await expect(dialog.getByTestId('edit-version-save')).toBeDisabled();
  await typeSource(page, source, lines);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(field.getByTestId('edit-version-description-save')).toHaveCount(0);
  // Still only a draft.
  expect(await deviceA.get('version', 'kv-v1')).toMatchObject({ number: '0.1.0', description: 'Old notes' });

  await dialog.getByTestId('edit-version-save').click();
  await expect(dialog).toHaveCount(0);
  await pollRow(
    deviceA,
    'version',
    'kv-v1',
    (r) => r?.number === '0.1.5' && r?.description === notes,
    'the edit stored number and notes'
  );
  await expect(page.getByTestId('board-version-title')).toHaveText('Version 0.1.5');

  await syncAll(deviceA, deviceB);
  await expect(deviceB.page.getByTestId('board-version-title')).toHaveText('Version 0.1.5');
  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'version', 'kv-v1', 'number', '0.1.5');
  assertFieldEverywhere(legs, 'version', 'kv-v1', 'description', notes);
  assertChangedFieldsEverywhere(before, legs, 'version', 'kv-v1', ['number', 'description']);
  assertIsolatedEverywhere(before, legs, [{ store: 'version', id: 'kv-v1' }]);
  assertInvariantsEverywhere(legs);
});

// ---------------------------------------------------------------------------
// Board: read-only (D6)
// ---------------------------------------------------------------------------

test('a completed version ignores the writing keys (swallowed), still lets focus move, and the overlay dims them', async ({
  deviceA,
}) => {
  await seedProject(deviceA, {
    project: { id: 'kr-p', name: 'Read only' },
    versions: [{ id: 'kr-v1', number: '0.1.0', completed: true }],
    cards: [
      { task: 'kr-a', link: 'kr-al', title: 'Was todo', status: 'todo', position: 0 },
      { task: 'kr-b', link: 'kr-bl', title: 'Was done', status: 'done', position: 0 },
    ],
  });
  const page = deviceA.page;
  await openBoard(deviceA, 'kr-p', 'kr-v1');
  await expect(page.getByTestId('board-root')).toHaveAttribute('data-readonly', 'true');
  await expect(page.getByTestId('board-edit-version')).toHaveCount(0);
  const before = await boardRows(deviceA);

  await page.keyboard.press('Control+1');
  await expectNoDialog(page);
  await page.keyboard.press('Control+Shift+e');
  await expectNoDialog(page, 'edit-version-dialog');
  await page.keyboard.press('Control+Shift+c');
  await expectNoDialog(page, 'complete-dialog');

  await page.keyboard.press('Control+Shift+1');
  await expectFocusedCard(page, 'kr-al');
  await page.keyboard.press('Tab');
  await expectFocusedCard(page, 'kr-bl');
  await page.keyboard.press('Control+ArrowLeft');
  await page.keyboard.press('Control+e');
  await expectNoDialog(page);
  await expect(cardDialog(page)).toHaveCount(0);
  await expect.poll(() => columnIds(page, 'done')).toEqual(['kr-bl']);
  await expectFocusedCard(page, 'kr-bl');

  // The overlay says so: the writing keys dimmed, navigation available.
  await holdCtrl(page);
  await expect(overlay(page)).toBeVisible();
  await expect(sheetRow(page, 'column.todo.new')).toHaveAttribute('data-available', 'false');
  await expect(sheetRow(page, 'version.edit')).toHaveAttribute('data-available', 'false');
  await expect(sheetRow(page, 'card.left')).toHaveAttribute('data-available', 'false');
  await expect(sheetRow(page, 'card.next')).toHaveAttribute('data-available', 'true');
  await expect(sheetRow(page, 'column.todo.focus')).toHaveAttribute('data-available', 'true');
  await page.keyboard.up('Control');
  await expect(overlay(page)).toHaveCount(0);

  expect(await boardRows(deviceA)).toEqual(before);
});

// ---------------------------------------------------------------------------
// Global keys
// ---------------------------------------------------------------------------

test('global keys: Ctrl+Enter opens the + menu; Alt+N / Ctrl+N New Task; Alt+Shift+P / Ctrl+Shift+P New Project; Ctrl+Shift+V New Version, but paste-as-plain-text in a field; none on onboarding', async ({
  deviceA,
  backend,
}) => {
  await seedProject(deviceA, {
    project: { id: 'kg-p', name: 'Global' },
    versions: [{ id: 'kg-v1', number: '0.1.0' }],
    cards: [{ task: 'kg-a', link: 'kg-al', title: 'Any', status: 'todo', position: 0 }],
  });
  const page = deviceA.page;
  await openBoard(deviceA, 'kg-p', 'kg-v1');
  await expectSettledCard(page, 'todo', 'kg-al');
  const before = await boardRows(deviceA);

  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('fab-menu')).toBeVisible();
  await expect(page.getByTestId('fab-new-task')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('fab-menu')).toHaveCount(0);

  const dialog = page.getByTestId('create-dialog');
  const opens = async (key: string, kind: string) => {
    await page.keyboard.press(key);
    await expect(dialog, key).toHaveAttribute('data-kind', kind);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  };
  await opens('Alt+n', 'task');
  // Chromium hands a page Ctrl+N when the input comes from DevTools (as here) or an installed app window.
  await opens('Control+n', 'task');
  await opens('Alt+Shift+P', 'project');
  await opens('Control+Shift+P', 'project');
  await opens('Control+Shift+V', 'version');
  // New Task from the key is prefilled from the board like the FAB's.
  await page.keyboard.press('Alt+n');
  await expect(dialog.getByTestId('task-create-project')).toHaveValue('kg-p');
  await expect(dialog.getByTestId('task-create-version-kg-v1')).toBeChecked();
  await expect(dialog.getByTestId('task-create-status')).toHaveValue('todo');
  // A dialog owns the keyboard: another create key does nothing to it.
  await page.keyboard.press('Control+Shift+V');
  await expect(dialog).toHaveAttribute('data-kind', 'task');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // D24: in a text field Ctrl+Shift+V is the browser's paste-as-plain-text.
  await deviceA.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: backend.url });
  await page.evaluate(() => navigator.clipboard.writeText('pasted plain'));
  const search = page.locator('.kb-search input');
  await search.click();
  await page.keyboard.press('Control+Shift+V');
  await expectNoDialog(page);
  await expect(search).toHaveValue('pasted plain');
  await search.fill('');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // Another page: the global keys work, the board's don't exist.
  await deviceA.goto('/preferences/');
  await page.keyboard.press('Control+1');
  await expectNoDialog(page);
  await page.keyboard.press('Control+Shift+V');
  await expect(dialog).toHaveAttribute('data-kind', 'version');
  await page.keyboard.press('Escape');

  // Onboarding has no FAB, so no create keys.
  await page.goto(backend.url + '/onboarding/');
  await waitForHook(page);
  await expect(page.getByTestId('fab')).toHaveCount(0);
  await page.keyboard.press('Alt+n');
  await page.keyboard.press('Control+Enter');
  await expectNoDialog(page);
  await expect(page.getByTestId('fab-menu')).toHaveCount(0);

  expect(await boardRows(deviceA)).toEqual(before);
});

// ---------------------------------------------------------------------------
// The Ctrl-hold overlay (D28)
// ---------------------------------------------------------------------------

test('holding Ctrl shows badges on the visible controls and the cheat sheet; any other key, a release or a click hides it; a quick Ctrl+K never flashes it', async ({
  deviceA,
}) => {
  await seedProject(deviceA, {
    project: { id: 'ko-p', name: 'Overlay' },
    versions: [{ id: 'ko-v1', number: '0.1.0' }],
    cards: [
      { task: 'ko-a', link: 'ko-al', title: 'First', status: 'todo', position: 0 },
      { task: 'ko-b', link: 'ko-bl', title: 'Second', status: 'todo', position: 1 },
    ],
  });
  const page = deviceA.page;
  await openBoard(deviceA, 'ko-p', 'ko-v1');
  await expectSettledCard(page, 'todo', 'ko-bl');

  await holdCtrl(page);
  await expect(overlay(page)).toBeVisible();
  for (const id of [
    'palette.open',
    'fab.open',
    'board.project',
    'version.complete',
    'version.edit',
    'column.todo.new',
    'column.todo.focus',
    'column.in_progress.new',
    'column.done.focus',
  ]) {
    await expect(badge(page, id), id).toHaveCount(1);
  }
  await expect(badge(page, 'version.edit')).toHaveText('Ctrl+Shift+E');
  // No card has focus: no card badges, and the card keys are listed dimmed.
  await expect(page.locator('[data-testid="keybind-badge"][data-keybind-id^="card."]')).toHaveCount(0);
  const sheet = page.getByTestId('keybind-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Global');
  await expect(sheet).toContainText('This page');
  await expect(sheet).toContainText('Focused card');
  await expect(sheetRow(page, 'card.up')).toHaveAttribute('data-available', 'false');
  // D25: a browser tab shows the fallback.
  await expect(sheetRow(page, 'create.task')).toContainText('Alt+N');
  await expect(sheetRow(page, 'create.task')).not.toContainText('Ctrl+N');
  await expect(sheetRow(page, 'palette.open')).toContainText('Ctrl+K');
  // The sheet stays clear of the FAB and never takes focus.
  const [sheetBox, fabBox] = [(await sheet.boundingBox())!, (await page.getByTestId('fab').boundingBox())!];
  expect(sheetBox.x + sheetBox.width <= fabBox.x || sheetBox.y + sheetBox.height <= fabBox.y).toBe(true);
  await expect(overlay(page)).toHaveCSS('pointer-events', 'none');

  // Any other key hides it.
  await page.keyboard.down('Shift');
  await expect(overlay(page)).toHaveCount(0);
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');

  // Releasing Ctrl hides it.
  await holdCtrl(page);
  await expect(overlay(page)).toBeVisible();
  await page.keyboard.up('Control');
  await expect(overlay(page)).toHaveCount(0);

  // A pointer press hides it.
  await holdCtrl(page);
  await expect(overlay(page)).toBeVisible();
  await page.mouse.move(5, 300);
  await page.mouse.down();
  await expect(overlay(page)).toHaveCount(0);
  await page.mouse.up();
  await page.keyboard.up('Control');

  // With a card focused: its move/edit badges, on that card only.
  await page.keyboard.press('Control+Shift+1');
  await expectFocusedCard(page, 'ko-al');
  await holdCtrl(page);
  await expect(overlay(page)).toBeVisible();
  for (const id of ['card.edit', 'card.up', 'card.down', 'card.left', 'card.right']) {
    await expect(badge(page, id), id).toHaveCount(1);
  }
  await expect(badge(page, 'card.down')).toHaveText('Ctrl+↓');
  await expect(sheetRow(page, 'card.up')).toHaveAttribute('data-available', 'true');
  // The overlay took nothing: the card still has focus.
  await expectFocusedCard(page, 'ko-al');
  await page.keyboard.up('Control');
  await expect(overlay(page)).toHaveCount(0);

  // A quick chord never flashes it.
  await page.evaluate(() => {
    const w = window as unknown as { __overlaySeen: boolean };
    w.__overlaySeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="keybind-overlay"]')) w.__overlaySeen = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.keyboard.down('Control');
  await page.keyboard.press('k');
  await expect(page.getByTestId('palette')).toBeVisible();
  await page.waitForTimeout(600);
  await page.keyboard.up('Control');
  expect(await page.evaluate(() => (window as unknown as { __overlaySeen: boolean }).__overlaySeen)).toBe(false);
  // Nor while a modal owns the keyboard.
  await holdCtrl(page);
  await expect(overlay(page)).toHaveCount(0);
  await page.keyboard.up('Control');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette')).toHaveCount(0);
});
