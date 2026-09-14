import { test, expect } from './helpers/devices';
import {
  assertConverged,
  assertFieldEverywhere,
  capture,
} from './helpers/oracle';
import {
  CONCURRENT,
  aboveCard,
  assertDragWhileRenaming,
  assertChangedFieldsEverywhere,
  assertInvariantsEverywhere,
  assertIsolatedEverywhere,
  cardIn,
  cardLocator,
  columnIds,
  columnLocator,
  dragCard,
  dragWhileRenaming,
  expectSettledCard,
  openBoard,
  openCardDialog,
  pollRow,
  seedProject,
  syncAll,
  topOfColumn,
  waitForBoard,
} from './helpers/board';

/**
 * The board, driven through its real UI: the composer, pointer drags, the card
 * dialog, bump, version completion and the unscheduled drawer — each change
 * followed from the click into IndexedDB, the outbox, the server and the
 * other device.
 *
 * Every multi-device case asserts all four legs (A, B, what the server serves,
 * what it stored), the value the UI action INTENDED, the isolation of the
 * delta and the structural invariants.
 */

test('home -> new project -> composer card -> drag TODO to In Progress, stored, queued, survives reload, synced', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  const page = deviceA.page;

  // Create the project on Home: it lands on its board, on version 0.1.0.
  await page.getByTestId('home-new-project-name').fill('Launch plan');
  await page.getByTestId('home-new-project-create').click();
  await page.waitForURL(/\/board\/\?project=/);
  await page.waitForFunction(() => Boolean((window as never)['__planee']));
  const url = new URL(page.url());
  const projectId = url.searchParams.get('project')!;
  const versionId = url.searchParams.get('version')!;
  await waitForBoard(page, projectId, versionId);
  await expect(page.getByTestId('board-version-title')).toHaveText('Version 0.1.0');
  expect(await deviceA.get('project', projectId)).toMatchObject({ name: 'Launch plan' });
  expect(await deviceA.get('version', versionId)).toMatchObject({ number: '0.1.0', project: projectId, completed: false });

  // A card through the TODO column's composer.
  await columnLocator(page, 'todo').locator('.kb-add').click();
  const composer = page.locator('.kb-composer');
  await composer.locator('input[type="text"]').fill('Draft the announcement');
  await composer.locator('button[type="submit"]').click();
  const created = columnLocator(page, 'todo').locator('[data-kanban-card]', { hasText: 'Draft the announcement' });
  await expect(created).toBeVisible();
  await expect(created).not.toHaveClass(/\boptimistic\b/);
  const linkId = (await created.getAttribute('data-id'))!;
  const link = await pollRow(deviceA, 'version_task', linkId, (r) => r?.status === 'todo', 'the composer stored a TODO link');
  expect(link).toMatchObject({ version: versionId, status: 'todo', deleted_at: null });
  const taskId = String(link.task);
  expect(await deviceA.get('task', taskId)).toMatchObject({
    project: projectId,
    title: 'Draft the announcement',
    task_type: 'feature',
    priority: 4,
    description: null,
    subtasks: null,
  });

  // Drag it into In Progress with real pointer events.
  await dragCard(page, cardIn(page, 'todo', linkId), topOfColumn(page, 'in_progress'));
  await expectSettledCard(page, 'in_progress', linkId);
  await pollRow(deviceA, 'version_task', linkId, (r) => r?.status === 'in_progress', 'the drag stored in_progress');
  const outbox = await deviceA.outbox();
  expect(outbox.map((e) => e.key)).toEqual(expect.arrayContaining(['version_task:' + linkId, 'task:' + taskId]));

  // A reload reads it back from IndexedDB, not from the board's memory.
  await deviceA.goto(`/board/?project=${projectId}&version=${versionId}`);
  await waitForBoard(page, projectId, versionId);
  await expectSettledCard(page, 'in_progress', linkId);
  await expect(cardIn(page, 'todo', linkId)).toHaveCount(0);

  // And it leaves the device.
  await syncAll(deviceA);
  expect(await deviceA.outbox()).toEqual([]);
  const served = (await backend.served()).version_task!.find((r) => r.id === linkId);
  expect(served).toMatchObject({ status: 'in_progress', task: taskId, version: versionId });
  await syncAll(deviceB);

  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'version_task', linkId, 'status', 'in_progress');
  assertFieldEverywhere(legs, 'task', taskId, 'title', 'Draft the announcement');
  assertFieldEverywhere(legs, 'project', projectId, 'name', 'Launch plan');
  assertInvariantsEverywhere(legs);
});

test('A drags a card to Done while B renames it: both edits survive on all four legs', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  const c = CONCURRENT;
  assertDragWhileRenaming(await dragWhileRenaming(deviceA, deviceB, backend));

  // Both boards show the merged card after their syncs, without a reload.
  for (const device of [deviceA, deviceB]) {
    const card = cardIn(device.page, 'done', c.link);
    await expect(card).toBeVisible();
    await expect(card.locator('.kb-title-btn')).toHaveText(c.renamed);
  }
});

test("change feed: B's open board follows A's move after B syncs, without a reload", async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await seedProject(deviceA, {
    project: { id: 'feed-p', name: 'Feed' },
    versions: [{ id: 'feed-v', number: '0.1.0' }],
    cards: [{ task: 'feed-t', link: 'feed-l', title: 'Watch me move', status: 'todo' }],
  });
  await syncAll(deviceA, deviceB);
  await openBoard(deviceA, 'feed-p', 'feed-v');
  await openBoard(deviceB, 'feed-p', 'feed-v');
  await expectSettledCard(deviceB.page, 'todo', 'feed-l');
  const before = await capture(deviceA, deviceB, backend);
  // A marker on B's window: a reload would wipe it.
  await deviceB.page.evaluate(() => ((window as unknown as Record<string, unknown>).__noReload = true));

  await dragCard(deviceA.page, cardIn(deviceA.page, 'todo', 'feed-l'), topOfColumn(deviceA.page, 'in_progress'));
  await pollRow(deviceA, 'version_task', 'feed-l', (r) => r?.status === 'in_progress', 'A stored the move');
  await syncAll(deviceA);

  const pulled = await deviceB.sync();
  expect(pulled.ok, pulled.error).toBe(true);
  expect(pulled.pulled).toBeGreaterThan(0);
  await expect(cardIn(deviceB.page, 'in_progress', 'feed-l')).toBeVisible({ timeout: 5_000 });
  await expect(cardIn(deviceB.page, 'todo', 'feed-l')).toHaveCount(0);
  expect(await deviceB.page.evaluate(() => (window as unknown as Record<string, unknown>).__noReload)).toBe(true);

  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'version_task', 'feed-l', 'status', 'in_progress');
  assertChangedFieldsEverywhere(before, legs, 'version_task', 'feed-l', ['status']);
  assertIsolatedEverywhere(before, legs, [{ store: 'version_task', id: 'feed-l' }]);
  assertInvariantsEverywhere(legs);
});

test("resolution: Won't fix set in the dialog survives a reorder within Done", async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await seedProject(deviceA, {
    project: { id: 'res-p', name: 'Resolutions' },
    versions: [{ id: 'res-v', number: '0.1.0' }],
    cards: [
      { task: 'res-t1', link: 'res-top', title: 'Shipped', status: 'done', position: 0 },
      { task: 'res-t2', link: 'res-moved', title: 'Not happening', status: 'done', position: 1 },
    ],
  });
  await syncAll(deviceA, deviceB);
  const page = deviceA.page;
  await openBoard(deviceA, 'res-p', 'res-v');
  await expectSettledCard(page, 'done', 'res-moved');
  expect(await columnIds(page, 'done')).toEqual(['res-top', 'res-moved']);
  const before = await capture(deviceA, deviceB, backend);

  const dialog = await openCardDialog(page, 'res-moved');
  await dialog.getByTestId('card-resolution-select').selectOption('wontfix');
  await pollRow(deviceA, 'version_task', 'res-moved', (r) => r?.status === 'wontfix', "the dialog stored wontfix");
  await expect(dialog.getByTestId('card-resolution')).toHaveAttribute('data-status', 'wontfix');
  await dialog.locator('.close').click();
  await expect(dialog).toHaveCount(0);
  const badge = cardIn(page, 'done', 'res-moved').getByTestId('card-resolution');
  await expect(badge).toHaveAttribute('data-status', 'wontfix');

  // Reorder inside Done: above the other Done card.
  await dragCard(page, cardIn(page, 'done', 'res-moved'), aboveCard(cardIn(page, 'done', 'res-top')));
  await expect.poll(() => columnIds(page, 'done')).toEqual(['res-moved', 'res-top']);
  const moved = await pollRow(
    deviceA,
    'version_task',
    'res-moved',
    (r) => typeof r?.position === 'number' && r.position < 0,
    'the reorder stored a position above the other card'
  );
  expect(moved.status, 'reordering within Done rewrote the resolution').toBe('wontfix');
  await expectSettledCard(page, 'done', 'res-moved');
  await expect(cardIn(page, 'done', 'res-moved').getByTestId('card-resolution')).toHaveAttribute('data-status', 'wontfix');

  await syncAll(deviceA, deviceB);
  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'version_task', 'res-moved', 'status', 'wontfix');
  assertFieldEverywhere(legs, 'version_task', 'res-moved', 'position', moved.position);
  assertFieldEverywhere(legs, 'version_task', 'res-top', 'status', 'done');
  assertChangedFieldsEverywhere(before, legs, 'version_task', 'res-moved', ['status', 'position']);
  assertIsolatedEverywhere(before, legs, [{ store: 'version_task', id: 'res-moved' }]);
  assertInvariantsEverywhere(legs);

  // B's board draws the same order and badge.
  await openBoard(deviceB, 'res-p', 'res-v');
  await expect.poll(() => columnIds(deviceB.page, 'done')).toEqual(['res-moved', 'res-top']);
  await expect(cardIn(deviceB.page, 'done', 'res-moved').getByTestId('card-resolution')).toHaveAttribute(
    'data-status',
    'wontfix'
  );
});

test('bump from the card dialog creates 0.2.0 and schedules the task there as TODO', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await seedProject(deviceA, {
    project: { id: 'bump-p', name: 'Bumps' },
    versions: [{ id: 'bump-v1', number: '0.1.0' }],
    cards: [{ task: 'bump-t', link: 'bump-l', title: 'Next time', status: 'todo' }],
  });
  await syncAll(deviceA, deviceB);
  const page = deviceA.page;
  await openBoard(deviceA, 'bump-p', 'bump-v1');
  await expectSettledCard(page, 'todo', 'bump-l');
  const before = await capture(deviceA, deviceB, backend);

  const dialog = await openCardDialog(page, 'bump-l');
  const prompts: { type: string; message: string; suggested: string }[] = [];
  page.once('dialog', (d) => {
    prompts.push({ type: d.type(), message: d.message(), suggested: d.defaultValue() });
    void d.accept(d.defaultValue());
  });
  await dialog.getByTestId('card-bump').click();
  await expect(dialog).toHaveCount(0);
  expect(prompts).toEqual([
    { type: 'prompt', message: expect.stringContaining('no later open version') as unknown as string, suggested: '0.2.0' },
  ]);

  // The old link is history, in Done; the board stays on 0.1.0 (still current).
  await expectSettledCard(page, 'done', 'bump-l');
  await expect(cardIn(page, 'done', 'bump-l').getByTestId('card-resolution')).toHaveAttribute('data-status', 'bumped');
  await pollRow(deviceA, 'version_task', 'bump-l', (r) => r?.status === 'bumped', 'the old link is bumped');
  const versions = await deviceA.dump('version');
  const next = versions.find((v) => v.number === '0.2.0' && !v.deleted_at);
  expect(next, 'no 0.2.0 was created').toBeTruthy();
  expect(next).toMatchObject({ project: 'bump-p', completed: false, description: null });
  const newLinks = (await deviceA.dump('version_task')).filter((l) => l.version === next!.id);
  expect(newLinks).toHaveLength(1);
  expect(newLinks[0]).toMatchObject({ task: 'bump-t', status: 'todo', deleted_at: null });
  const newLink = String(newLinks[0]!.id);

  // The new version's board has it in TODO.
  await page.getByTestId('board-version-option').filter({ hasText: '0.2.0' }).click();
  await expect(page.getByTestId('board-root')).toHaveAttribute('data-version', String(next!.id));
  await expectSettledCard(page, 'todo', newLink);

  await syncAll(deviceA, deviceB, deviceA);
  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'version_task', 'bump-l', 'status', 'bumped');
  assertFieldEverywhere(legs, 'version', String(next!.id), 'number', '0.2.0');
  assertFieldEverywhere(legs, 'version', String(next!.id), 'completed', false);
  assertFieldEverywhere(legs, 'version_task', newLink, 'status', 'todo');
  assertFieldEverywhere(legs, 'version_task', newLink, 'task', 'bump-t');
  assertChangedFieldsEverywhere(before, legs, 'version_task', 'bump-l', ['status']);
  assertIsolatedEverywhere(before, legs, [
    { store: 'version_task', id: 'bump-l' },
    { store: 'version_task', id: newLink },
    { store: 'version', id: String(next!.id) },
  ]);
  assertInvariantsEverywhere(legs);
});

test('complete with open tasks bumps them, locks the completed board, and Reopen unlocks it', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await seedProject(deviceA, {
    project: { id: 'done-p', name: 'Completion' },
    versions: [{ id: 'done-v1', number: '0.1.0' }],
    cards: [
      { task: 'done-open', link: 'done-open-l', title: 'Still open', status: 'todo' },
      { task: 'done-closed', link: 'done-closed-l', title: 'Finished', status: 'done' },
    ],
  });
  await syncAll(deviceA, deviceB);
  const page = deviceA.page;
  await openBoard(deviceA, 'done-p', 'done-v1');
  await expectSettledCard(page, 'todo', 'done-open-l');
  const before = await capture(deviceA, deviceB, backend);

  await page.getByTestId('board-mark-complete').click();
  const complete = page.getByTestId('complete-dialog');
  await expect(complete).toBeVisible();
  await expect(complete).toContainText('1 task is still open');
  await expect(complete.getByTestId('complete-dialog-number')).toHaveValue('0.2.0');
  await complete.getByTestId('complete-dialog-bump').click();
  await expect(complete).toHaveCount(0);

  const v1 = await pollRow(deviceA, 'version', 'done-v1', (r) => r?.completed === true, '0.1.0 is completed');
  expect(typeof v1.completed).toBe('boolean');
  const v2 = (await deviceA.dump('version')).find((v) => v.number === '0.2.0')!;
  expect(v2, 'no 0.2.0 was created').toBeTruthy();
  const v2Id = String(v2.id);
  // The board follows the work to the new current version.
  await expect(page.getByTestId('board-root')).toHaveAttribute('data-version', v2Id);
  await expect(page.getByTestId('board-version-title')).toHaveText('Version 0.2.0');
  const moved = (await deviceA.dump('version_task')).filter((l) => l.version === v2Id);
  expect(moved).toHaveLength(1);
  expect(moved[0]).toMatchObject({ task: 'done-open', status: 'todo' });
  const movedId = String(moved[0]!.id);
  await expectSettledCard(page, 'todo', movedId);
  expect(await deviceA.get('version_task', 'done-open-l')).toMatchObject({ status: 'bumped' });
  expect(await deviceA.get('version_task', 'done-closed-l')).toMatchObject({ status: 'done' });

  await syncAll(deviceA, deviceB, deviceA);
  const completed = await capture(deviceA, deviceB, backend);
  assertConverged(completed);
  assertFieldEverywhere(completed, 'version', 'done-v1', 'completed', true);
  assertFieldEverywhere(completed, 'version', v2Id, 'completed', false);
  assertFieldEverywhere(completed, 'version_task', 'done-open-l', 'status', 'bumped');
  assertFieldEverywhere(completed, 'version_task', movedId, 'status', 'todo');
  assertFieldEverywhere(completed, 'version_task', 'done-closed-l', 'status', 'done');
  assertChangedFieldsEverywhere(before, completed, 'version', 'done-v1', ['completed']);
  assertChangedFieldsEverywhere(before, completed, 'version_task', 'done-open-l', ['status']);
  assertIsolatedEverywhere(before, completed, [
    { store: 'version', id: 'done-v1' },
    { store: 'version', id: v2Id },
    { store: 'version_task', id: 'done-open-l' },
    { store: 'version_task', id: movedId },
  ]);
  assertInvariantsEverywhere(completed);

  // Back to 0.1.0 through the completed-versions switcher: read-only.
  await page.getByTestId('board-completed-toggle').click();
  await page.locator('[data-testid="board-completed-version"][data-version-id="done-v1"]').click();
  const root = page.getByTestId('board-root');
  await expect(root).toHaveAttribute('data-version', 'done-v1');
  await expect(root).toHaveAttribute('data-readonly', 'true');
  await expect(page.getByTestId('board-completed-badge')).toBeVisible();
  await expect(page.getByTestId('board-reopen')).toBeVisible();
  await expectSettledCard(page, 'done', 'done-closed-l');
  await expect(page.locator('.kb-add')).toHaveCount(0);
  await expect(page.locator('.kb-pencil')).toHaveCount(0);
  await expect(page.locator('.kb-grip')).toHaveCount(0);

  // A drag attempt starts nothing and writes nothing.
  await dragCard(page, cardIn(page, 'done', 'done-closed-l'), topOfColumn(page, 'todo'), { expectGhost: false });
  await expect(cardIn(page, 'done', 'done-closed-l')).toBeVisible();
  expect(await deviceA.get('version_task', 'done-closed-l')).toMatchObject({ status: 'done' });
  expect(await deviceA.outbox()).toEqual([]);
  assertConverged(await capture(deviceA, deviceB, backend));

  // Reopen: editable again.
  await page.getByTestId('board-reopen').click();
  await expect(root).toHaveAttribute('data-readonly', 'false');
  await expect(page.locator('.kb-add')).toHaveCount(3);
  await expect(page.getByTestId('board-mark-complete')).toBeVisible();
  await pollRow(deviceA, 'version', 'done-v1', (r) => r?.completed === false, '0.1.0 reopened');
  // ...and a drag works again.
  await dragCard(page, cardIn(page, 'done', 'done-closed-l'), topOfColumn(page, 'in_progress'));
  await expectSettledCard(page, 'in_progress', 'done-closed-l');
  await pollRow(deviceA, 'version_task', 'done-closed-l', (r) => r?.status === 'in_progress', 'the reopened board stored the drag');

  await syncAll(deviceA, deviceB, deviceA);
  const reopened = await capture(deviceA, deviceB, backend);
  assertConverged(reopened);
  assertFieldEverywhere(reopened, 'version', 'done-v1', 'completed', false);
  assertFieldEverywhere(reopened, 'version_task', 'done-closed-l', 'status', 'in_progress');
  assertIsolatedEverywhere(completed, reopened, [
    { store: 'version', id: 'done-v1' },
    { store: 'version_task', id: 'done-closed-l' },
  ]);
  assertInvariantsEverywhere(reopened);
});

test('an unscheduled task shows in the drawer and "Add to this version" links it as TODO', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await seedProject(deviceA, {
    project: { id: 'uns-p', name: 'Unscheduled' },
    versions: [{ id: 'uns-v', number: '0.1.0' }],
    cards: [
      { task: 'uns-linked', link: 'uns-linked-l', title: 'Already planned', status: 'todo', position: 0 },
      { task: 'uns-free', title: 'Someday' },
    ],
  });
  await syncAll(deviceA, deviceB);
  const page = deviceA.page;
  await openBoard(deviceA, 'uns-p', 'uns-v');
  await expectSettledCard(page, 'todo', 'uns-linked-l');
  const before = await capture(deviceA, deviceB, backend);

  const drawer = page.getByTestId('unscheduled');
  await drawer.locator('summary').click();
  const entry = drawer.locator('[data-testid="unscheduled-task"][data-task-id="uns-free"]');
  await expect(entry).toBeVisible();
  await expect(drawer.getByTestId('unscheduled-task')).toHaveCount(1);
  await entry.getByTestId('unscheduled-add').click();
  await expect(entry).toHaveCount(0);

  let links: Record<string, unknown>[] = [];
  await expect
    .poll(async () => {
      links = (await deviceA.dump('version_task')).filter((l) => l.task === 'uns-free');
      return links.length;
    })
    .toBe(1);
  expect(links[0]).toMatchObject({ version: 'uns-v', status: 'todo', deleted_at: null });
  const linkId = String(links[0]!.id);
  // At the top of TODO, above the card that was there.
  expect(links[0]!.position as number).toBeLessThan(0);
  await expectSettledCard(page, 'todo', linkId);
  await expect.poll(() => columnIds(page, 'todo')).toEqual([linkId, 'uns-linked-l']);

  await syncAll(deviceA, deviceB, deviceA);
  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'version_task', linkId, 'status', 'todo');
  assertFieldEverywhere(legs, 'version_task', linkId, 'version', 'uns-v');
  assertFieldEverywhere(legs, 'version_task', linkId, 'task', 'uns-free');
  assertIsolatedEverywhere(before, legs, [{ store: 'version_task', id: linkId }]);
  assertInvariantsEverywhere(legs);
});

test('deleting a card whose task has no other link tombstones the link and the task everywhere', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await seedProject(deviceA, {
    project: { id: 'del-p', name: 'Deletes' },
    versions: [{ id: 'del-v', number: '0.1.0' }],
    cards: [
      { task: 'del-t', link: 'del-l', title: 'Throw away', status: 'todo', position: 0 },
      { task: 'del-keep', link: 'del-keep-l', title: 'Keep me', status: 'todo', position: 1 },
    ],
  });
  await syncAll(deviceA, deviceB);
  const page = deviceA.page;
  await openBoard(deviceA, 'del-p', 'del-v');
  await openBoard(deviceB, 'del-p', 'del-v');
  await expectSettledCard(page, 'todo', 'del-l');
  const before = await capture(deviceA, deviceB, backend);

  const dialog = await openCardDialog(page, 'del-l');
  const confirms: string[] = [];
  page.once('dialog', (d) => {
    confirms.push(d.type() + ': ' + d.message());
    void d.accept();
  });
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(dialog).toHaveCount(0);
  expect(confirms).toEqual(['confirm: Delete "Throw away"?']);
  await expect(cardLocator(page, 'del-l')).toHaveCount(0);

  const link = await pollRow(deviceA, 'version_task', 'del-l', (r) => typeof r?.deleted_at === 'string', 'the link is tombstoned');
  const task = await pollRow(deviceA, 'task', 'del-t', (r) => typeof r?.deleted_at === 'string', 'the task is tombstoned');
  expect(await deviceA.get('task', 'del-keep')).toMatchObject({ deleted_at: null });

  await syncAll(deviceA, deviceB, deviceA);
  // B's open board drops the card on its sync.
  await expect(cardLocator(deviceB.page, 'del-l')).toHaveCount(0);
  await expect(cardIn(deviceB.page, 'todo', 'del-keep-l')).toBeVisible();

  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'version_task', 'del-l', 'deleted_at', link.deleted_at);
  assertFieldEverywhere(legs, 'task', 'del-t', 'deleted_at', task.deleted_at);
  assertFieldEverywhere(legs, 'task', 'del-keep', 'deleted_at', null);
  assertChangedFieldsEverywhere(before, legs, 'version_task', 'del-l', ['deleted_at']);
  assertChangedFieldsEverywhere(before, legs, 'task', 'del-t', ['deleted_at']);
  assertIsolatedEverywhere(before, legs, [
    { store: 'version_task', id: 'del-l' },
    { store: 'task', id: 'del-t' },
  ]);
  assertInvariantsEverywhere(legs);
});
