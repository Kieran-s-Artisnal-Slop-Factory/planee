import type { Locator, Page } from '@playwright/test';
import { test, expect } from './helpers/devices';
import type { Device } from './helpers/devices';
import { assertConverged, assertFieldEverywhere, capture } from './helpers/oracle';
import {
  assertChangedFieldsEverywhere,
  assertInvariantsEverywhere,
  assertIsolatedEverywhere,
  expectSettledCard,
  openBoard,
  openCardDialog,
  pollRow,
  seedProject,
  syncAll,
} from './helpers/board';

/**
 * Markdown fields through the real UI (D7, D10): the card dialog's task
 * description, edited in the editor's Source tab, saved explicitly, rendered
 * sanitised on the other device; the overwrite warning when the field changed
 * elsewhere mid-edit; and a synced image asset resolving on the other device.
 */

const PROJECT = 'md-p';
const VERSION = 'md-v';
const TASK = 'md-t';
const LINK = 'md-l';

async function seedCard(a: Device, b: Device, description: string | null): Promise<void> {
  await seedProject(a, {
    project: { id: PROJECT, name: 'Markdown' },
    versions: [{ id: VERSION, number: '0.1.0' }],
    cards: [{ task: TASK, link: LINK, title: 'Document it', status: 'todo', description }],
  });
  await syncAll(a, b);
}

/** Open the card dialog and the description editor, switched to its Source tab. */
async function editDescriptionSource(page: Page): Promise<{ dialog: Locator; source: Locator }> {
  const dialog = await openCardDialog(page, LINK);
  const field = dialog.getByTestId('task-description');
  await field.getByTestId('task-description-edit').click();
  await expect(field.getByTestId('task-description-save')).toBeEnabled({ timeout: 15_000 });
  await field.getByRole('button', { name: 'Source', exact: true }).click();
  const source = field.locator('.cm-content');
  await expect(source).toBeVisible();
  return { dialog, source };
}

/**
 * Type `lines` into CodeMirror as a person would, one line per Enter. The
 * markdown keymap continues list markup on Enter ("- [ ] "), so each new line
 * first selects whatever the editor put at its start and types over it: the
 * stored text is then exactly `lines`, whatever the continuation rules are.
 */
async function typeSource(page: Page, source: Locator, lines: string[]): Promise<void> {
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

/** The rendered description preview in a dialog, once it has finished drawing. */
async function renderedPreview(dialog: Locator): Promise<Locator> {
  const preview = dialog.locator('[data-testid="task-description-preview"] .preview');
  await expect(preview).toHaveAttribute('data-rendered', 'true', { timeout: 15_000 });
  return preview;
}

/** Nothing on the page may carry an inline event handler, and no script dialog may have fired. */
async function expectSanitised(page: Page, preview: Locator, dialogs: string[]): Promise<void> {
  await expect(preview.locator('h1')).toHaveText('Hello');
  const boxes = preview.locator('input[type="checkbox"]');
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).not.toBeChecked();
  await expect(preview.locator('li')).toHaveText(['done', 'todo']);
  await expect(preview.locator('img')).toHaveCount(0);
  const handlers = await page.evaluate(() =>
    [...document.querySelectorAll('*')].flatMap((el) =>
      [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => el.tagName + ' ' + a.name)
    )
  );
  expect(handlers, 'an inline event handler reached the DOM').toEqual([]);
  expect(dialogs, 'a script dialog fired').toEqual([]);
}

test('a task description typed in the Source tab is stored exactly and renders sanitised on both devices', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await seedCard(deviceA, deviceB, null);
  const page = deviceA.page;
  const dialogs: string[] = [];
  for (const device of [deviceA, deviceB]) {
    device.page.on('dialog', (d) => {
      dialogs.push(device.name + ' ' + d.type() + ': ' + d.message());
      void d.dismiss();
    });
  }
  await openBoard(deviceA, PROJECT, VERSION);
  await expectSettledCard(page, 'todo', LINK);
  const before = await capture(deviceA, deviceB, backend);

  const lines = ['# Hello', '', '- [x] done', '- [ ] todo', '', '<img src=x onerror=alert(1)>'];
  const intended = lines.join('\n');
  const { dialog, source } = await editDescriptionSource(page);
  await typeSource(page, source, lines);
  await dialog.getByTestId('task-description-save').click();
  await expect(dialog.getByTestId('task-description-edit')).toBeVisible();

  await pollRow(deviceA, 'task', TASK, (r) => r?.description === intended, 'the description was stored exactly as typed');
  await expectSanitised(page, await renderedPreview(dialog), dialogs);

  await syncAll(deviceA, deviceB);
  await openBoard(deviceB, PROJECT, VERSION);
  const dialogB = await openCardDialog(deviceB.page, LINK);
  await expectSanitised(deviceB.page, await renderedPreview(dialogB), dialogs);

  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'task', TASK, 'description', intended);
  assertChangedFieldsEverywhere(before, legs, 'task', TASK, ['description']);
  assertIsolatedEverywhere(before, legs, [{ store: 'task', id: TASK }]);
  assertInvariantsEverywhere(legs);
});

test('saving over a description changed on another device mid-edit asks first; No keeps editing, Yes overwrites', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await seedCard(deviceA, deviceB, 'Original notes');
  const page = deviceA.page;
  await openBoard(deviceA, PROJECT, VERSION);
  await expectSettledCard(page, 'todo', LINK);
  const before = await capture(deviceA, deviceB, backend);

  // A starts editing...
  const { dialog, source } = await editDescriptionSource(page);
  await expect(source).toHaveText('Original notes');
  await typeSource(page, source, ['Notes from A']);

  // ...while B changes the same field and it reaches A.
  await deviceB.call('repoPatch', 'task', TASK, { description: 'Notes from B' });
  await syncAll(deviceB, deviceA);
  await pollRow(deviceA, 'task', TASK, (r) => r?.description === 'Notes from B', "B's edit reached A");

  // Save: warned. Declining keeps the editor open and stores nothing.
  const save = dialog.getByTestId('task-description-save');
  const [declined] = await Promise.all([
    page.waitForEvent('dialog').then(async (d) => {
      const seen = { type: d.type(), message: d.message() };
      await d.dismiss();
      return seen;
    }),
    save.click(),
  ]);
  expect(declined.type).toBe('confirm');
  expect(declined.message).toContain('another device');
  await expect(save).toBeEnabled();
  await expect(dialog.getByTestId('task-description-cancel')).toBeVisible();
  await expect(source).toHaveText('Notes from A');
  expect(await deviceA.get('task', TASK)).toMatchObject({ description: 'Notes from B' });

  // Save again and accept: A's text wins.
  const [accepted] = await Promise.all([
    page.waitForEvent('dialog').then(async (d) => {
      const message = d.message();
      await d.accept();
      return message;
    }),
    save.click(),
  ]);
  expect(accepted).toContain('another device');
  await expect(dialog.getByTestId('task-description-edit')).toBeVisible();
  await pollRow(deviceA, 'task', TASK, (r) => r?.description === 'Notes from A', "A's overwrite was stored");
  await expect((await renderedPreview(dialog)).locator('p')).toHaveText('Notes from A');

  await syncAll(deviceA, deviceB, deviceA);
  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'task', TASK, 'description', 'Notes from A');
  assertChangedFieldsEverywhere(before, legs, 'task', TASK, ['description']);
  assertIsolatedEverywhere(before, legs, [{ store: 'task', id: TASK }]);
  assertInvariantsEverywhere(legs);
});

// A valid 2x2 RGB PNG (red, green / blue, white).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAAMIM/////w8AH+4F+7C4l8kAAAAASUVORK5CYII=';

test('an image saved through the asset store syncs with its description and resolves on device B', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await seedCard(deviceA, deviceB, null);
  const page = deviceA.page;
  await openBoard(deviceA, PROJECT, VERSION);
  await expectSettledCard(page, 'todo', LINK);
  const before = await capture(deviceA, deviceB, backend);

  const ref = await deviceA.call<string>('saveAsset', PNG_BASE64, 'dot.png', 'image/png');
  const match = /^assets\/([0-9a-f-]{36})\.png$/.exec(ref);
  expect(match, 'unexpected asset ref ' + ref).toBeTruthy();
  const assetId = match![1]!;
  const bytes = Buffer.from(PNG_BASE64, 'base64');

  const markdown = `![dot](${ref})`;
  const { dialog, source } = await editDescriptionSource(page);
  await typeSource(page, source, [markdown]);
  await dialog.getByTestId('task-description-save').click();
  await expect(dialog.getByTestId('task-description-edit')).toBeVisible();
  await pollRow(deviceA, 'task', TASK, (r) => r?.description === markdown, 'the description references the asset');

  const expectResolvedImage = async (preview: Locator) => {
    const img = preview.locator('img');
    await expect(img).toHaveCount(1);
    await expect(preview.locator('img.asset-missing')).toHaveCount(0);
    await expect(img).toHaveAttribute('src', /^blob:/);
    await expect(img).toHaveAttribute('alt', 'dot');
    // The blob URL really holds the image: it decoded to 2x2.
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && `${el.naturalWidth}x${el.naturalHeight}`))
      .toBe('2x2');
  };
  await expectResolvedImage(await renderedPreview(dialog));

  await syncAll(deviceA, deviceB);
  await openBoard(deviceB, PROJECT, VERSION);
  const dialogB = await openCardDialog(deviceB.page, LINK);
  await expectResolvedImage(await renderedPreview(dialogB));

  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'task', TASK, 'description', markdown);
  for (const [field, value] of Object.entries({
    name: 'dot.png',
    mime: 'image/png',
    size: bytes.length,
    data: PNG_BASE64,
    deleted_at: null,
  })) {
    assertFieldEverywhere(legs, 'asset', assetId, field, value);
  }
  assertIsolatedEverywhere(before, legs, [
    { store: 'task', id: TASK },
    { store: 'asset', id: assetId },
  ]);
  assertInvariantsEverywhere(legs);
});
