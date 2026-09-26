import type { Locator } from '@playwright/test';
import { test, expect } from './helpers/devices';
import { assertConverged, assertFieldEverywhere, capture } from './helpers/oracle';
import {
  assertChangedFieldsEverywhere,
  assertInvariantsEverywhere,
  assertIsolatedEverywhere,
  pollRow,
  syncAll,
} from './helpers/board';
import {
  FIELD,
  TASK,
  caretAtEnd,
  mathDialogReady,
  mathFieldValue,
  mathMarkupAttributes,
  openDescriptionEditor,
  openEditorCard,
  renderedDescription,
  seedEditorCard,
  watchForeignRequests,
} from './helpers/editor';

/**
 * notey's markdown editor, ported (10c-E, D21/D22), through the real UI: the
 * board card dialog's task description.
 *
 *  - The formula dialog (MathLive) opens on its key without typing into the
 *    text, writes `$…$` / `$$…$$` markdown, and the preview draws it with
 *    MathLive (never KaTeX) — on the other device too, after sync.
 *  - Canvas formulas are edited in place by double-click; prices stay prose.
 *  - Every tool opens on its key; Escape in a tool closes only that tool.
 *  - MathLive's attribute commands (\style, \cssId, \href, \htmlData) never
 *    reach the page as attributes.
 *  - The keys are rebindable per device in Settings, refusing app keybinds
 *    and Ctrl+S; the palette offers the tools only while an editor is open.
 */

test('a formula written in the formula dialog is stored as markdown and renders with MathLive on both devices', async ({
  deviceA,
  deviceB,
  backend,
}) => {
  await seedEditorCard(deviceA, deviceB, 'The area is');
  const page = deviceA.page;
  const foreign = watchForeignRequests(page, backend.url);
  const dialog = await openEditorCard(deviceA);
  const before = await capture(deviceA, deviceB, backend);

  const { field, canvas } = await openDescriptionEditor(dialog);
  await caretAtEnd(page, canvas);
  await page.keyboard.type(' ');
  // The key, and NOT an "f" in the text: it is claimed on the editor's
  // capture phase, before either editor sees it.
  await page.keyboard.press('Alt+KeyF');
  await mathDialogReady(page);
  await expect(canvas).toHaveText('The area is ');

  // Typing "pi" produces π, not the letters: MathLive's inline shortcuts.
  await page.keyboard.type('pi');
  await expect.poll(() => mathFieldValue(page)).toBe(String.raw`\pi`);
  await expect(page.getByTestId('md-math-latex')).toHaveValue(String.raw`\pi`);
  await page.getByTestId('md-math-save').click();
  await expect(page.getByTestId('md-math-dialog')).toHaveCount(0);

  const node = canvas.locator('.math-node');
  await expect(node).toHaveAttribute('data-value', String.raw`\pi`, { timeout: 10_000 });
  await expect(node.locator('.ML__latex')).toBeVisible();

  await field.getByTestId(FIELD + '-save').click();
  await expect(field.getByTestId(FIELD + '-edit')).toBeVisible();
  await pollRow(
    deviceA,
    'task',
    TASK,
    (r) => String(r?.description ?? '').trim() === String.raw`The area is $\pi$`,
    'the formula was stored as $…$ markdown'
  );
  const description = (await deviceA.get('task', TASK))!.description as string;

  const expectMathLive = async (preview: Locator) => {
    const math = preview.locator('span.math.math-inline[data-math]');
    await expect(math).toHaveCount(1);
    await expect(math).toHaveAttribute('data-math', String.raw`\pi`);
    await expect(math.locator('.ML__latex')).toBeVisible();
    await expect(preview.locator('.katex')).toHaveCount(0);
  };
  await expectMathLive(await renderedDescription(dialog));

  // Device B draws the same formula from the synced markdown.
  await syncAll(deviceA, deviceB);
  const dialogB = await openEditorCard(deviceB);
  await expectMathLive(await renderedDescription(dialogB));

  // Everything MathLive needed came from this origin: fonts, stylesheets,
  // the engine — no CDN, and no keypress sounds.
  expect(foreign, 'requests that left the app').toEqual([]);

  const legs = await capture(deviceA, deviceB, backend);
  assertConverged(legs);
  assertFieldEverywhere(legs, 'task', TASK, 'description', description);
  assertChangedFieldsEverywhere(before, legs, 'task', TASK, ['description']);
  assertIsolatedEverywhere(before, legs, [{ store: 'task', id: TASK }]);
  assertInvariantsEverywhere(legs);
});

test('the matrix picker inserts a matrix of the chosen size, and "on its own line" stores $$…$$', async ({
  deviceA,
  deviceB,
}) => {
  await seedEditorCard(deviceA, deviceB, 'Rotation:');
  const page = deviceA.page;
  const dialog = await openEditorCard(deviceA);
  const { field, canvas } = await openDescriptionEditor(dialog);
  await caretAtEnd(page, canvas);
  await page.keyboard.press('Alt+KeyF');
  await mathDialogReady(page);

  // Nothing is inserted on the first click: it asks.
  await page.getByTestId('md-math-matrix').click();
  await expect(page.getByTestId('md-math-matrix-size')).toBeVisible();
  await expect(page.getByTestId('md-math-latex')).toHaveValue('');

  // Escape backs out of the question, not out of the dialog — nor the card.
  await page.getByTestId('md-math-matrix-rows').press('Escape');
  await expect(page.getByTestId('md-math-matrix-size')).toHaveCount(0);
  await expect(page.getByTestId('md-math-dialog')).toBeVisible();
  await expect(dialog).toBeVisible();

  await page.getByTestId('md-math-matrix').click();
  await page.getByTestId('md-math-matrix-rows').fill('3');
  await page.getByTestId('md-math-matrix-cols').fill('2');
  await expect(page.getByTestId('md-math-matrix-insert')).toHaveText('Insert 3 × 2 matrix');
  await page.getByTestId('md-math-matrix-cols').press('Enter');
  await expect(page.getByTestId('md-math-matrix-size')).toHaveCount(0);

  // Three rows of two, straight into the formula; the caret is in the first
  // cell, so typing fills it.
  await page.keyboard.type('1');
  const matrixBody = async () =>
    /\\begin\{pmatrix\}([\s\S]*)\\end\{pmatrix\}/.exec(await page.getByTestId('md-math-latex').inputValue())?.[1] ?? '';
  await expect.poll(async () => (await matrixBody()).trim().startsWith('1')).toBe(true);
  expect((await matrixBody()).split('\\\\').map((row) => row.split('&').length)).toEqual([2, 2, 2]);

  await page.getByTestId('md-math-display').check();
  await page.getByTestId('md-math-save').click();
  await expect(page.getByTestId('md-math-dialog')).toHaveCount(0);
  await expect(canvas.locator('.math-node.math-node-display .ML__latex')).toBeVisible({ timeout: 10_000 });

  await field.getByTestId(FIELD + '-save').click();
  await expect(field.getByTestId(FIELD + '-edit')).toBeVisible();
  const row = await pollRow(
    deviceA,
    'task',
    TASK,
    (r) => /\$\$\n\\begin\{pmatrix\}1[\s\S]*\\end\{pmatrix\}\n\$\$/.test(String(r?.description ?? '')),
    'the matrix was stored as a $$ block'
  );
  expect(String(row.description)).toMatch(/^Rotation:/);
  const preview = await renderedDescription(dialog);
  await expect(preview.locator('div.math.math-display[data-display] .ML__latex')).toBeVisible();
});

test('double-clicking a formula in the canvas edits that formula, in place', async ({ deviceA, deviceB }) => {
  await seedEditorCard(deviceA, deviceB, 'The identity $e^{i x} = 1$ is famous.');
  const page = deviceA.page;
  const dialog = await openEditorCard(deviceA);
  const { field, canvas } = await openDescriptionEditor(dialog);
  const node = canvas.locator('.math-node');
  await expect(node).toHaveCount(1, { timeout: 30_000 });
  await expect(node.locator('.ML__latex')).toBeVisible();

  await node.dblclick();
  await mathDialogReady(page);
  // It opens ON the formula, rather than on a blank one beside it.
  await expect(page.getByTestId('md-math-latex')).toHaveValue(String.raw`e^{i x} = 1`);
  await page.getByTestId('md-math-latex').fill('x = 1');
  await page.getByTestId('md-math-save').click();
  await expect(page.getByTestId('md-math-dialog')).toHaveCount(0);

  // ONE formula, changed — not a second one appended at the end.
  await expect(node).toHaveCount(1);
  await expect(node).toHaveAttribute('data-value', 'x = 1', { timeout: 10_000 });

  await field.getByTestId(FIELD + '-save').click();
  await expect(field.getByTestId(FIELD + '-edit')).toBeVisible();
  await pollRow(
    deviceA,
    'task',
    TASK,
    (r) => String(r?.description ?? '').trim() === 'The identity $x = 1$ is famous.',
    'the formula was replaced where it stood'
  );
});

test('money is not maths: prices stay prose in the preview and the canvas, and survive a round trip', async ({
  deviceA,
  deviceB,
}) => {
  const text = 'It cost $5 and $10 today.';
  await seedEditorCard(deviceA, deviceB, text);
  const page = deviceA.page;
  const dialog = await openEditorCard(deviceA);

  const preview = await renderedDescription(dialog);
  await expect(preview.locator('[data-math], .ML__latex')).toHaveCount(0);
  await expect(preview).toContainText(text);

  const { field, canvas } = await openDescriptionEditor(dialog);
  await expect(canvas).toContainText(text);
  await expect(canvas.locator('.math-node')).toHaveCount(0);

  // Through the canvas and back out: remark-stringify escapes every `$` once
  // maths is on; the editor puts them back.
  await caretAtEnd(page, canvas);
  await page.keyboard.type(' Really.');
  await field.getByTestId(FIELD + '-save').click();
  await expect(field.getByTestId(FIELD + '-edit')).toBeVisible();
  await pollRow(
    deviceA,
    'task',
    TASK,
    (r) => String(r?.description ?? '').trim() === 'It cost $5 and $10 today. Really.',
    'the prices were stored as written, with no \\$'
  );
});

test('every tool opens on its key without typing, and Escape in a tool closes only that tool', async ({
  deviceA,
  deviceB,
}) => {
  await seedEditorCard(deviceA, deviceB, 'Before.');
  const page = deviceA.page;
  const dialog = await openEditorCard(deviceA);
  const { field, editor, canvas } = await openDescriptionEditor(dialog);

  // The toolbar wears the keys.
  await expect(editor.getByTestId('md-key-formula')).toHaveText('Alt+F');
  await expect(editor.getByTestId('md-key-diagram')).toHaveText('Alt+M');
  await expect(editor.getByTestId('md-key-drawing')).toHaveText('Alt+E');
  await expect(editor.getByTestId('md-key-footnotes')).toHaveText('Alt+0');

  /** The card dialog and the open editor are still there. */
  const stillEditing = async () => {
    await expect(dialog).toBeVisible();
    await expect(field.getByTestId(FIELD + '-save')).toBeVisible();
    await expect(canvas).toContainText('Before.');
  };

  // Formula: Escape from outside the mathfield closes the formula dialog only.
  await caretAtEnd(page, canvas);
  await page.keyboard.press('Alt+KeyF');
  await mathDialogReady(page);
  await page.getByTestId('md-math-latex').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('md-math-dialog')).toHaveCount(0);
  await stillEditing();

  // Inside the mathfield Escape is MathLive's (it starts a \command): the
  // dialog stays, and so does everything around it.
  await caretAtEnd(page, canvas);
  await page.keyboard.press('Alt+KeyF');
  await mathDialogReady(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('md-math-dialog')).toBeVisible();
  await stillEditing();
  await page.getByTestId('md-math-cancel').click();
  await expect(page.getByTestId('md-math-dialog')).toHaveCount(0);

  // Diagram.
  await caretAtEnd(page, canvas);
  await page.keyboard.press('Alt+KeyM');
  await expect(page.getByTestId('md-diagram-dialog')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('md-diagram-dialog')).toHaveCount(0);
  await stillEditing();

  // Drawing: Escape belongs to Excalidraw — the dialog stays; Cancel closes.
  await caretAtEnd(page, canvas);
  await page.keyboard.press('Alt+KeyE');
  await expect(page.getByTestId('md-drawing-dialog')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('md-drawing-loading')).toHaveCount(0, { timeout: 60_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('md-drawing-dialog')).toBeVisible();
  await stillEditing();
  await page.getByTestId('md-drawing-cancel').click();
  await expect(page.getByTestId('md-drawing-dialog')).toHaveCount(0);

  // Footnotes: the key cites and opens; the same key closes; Escape closes.
  await caretAtEnd(page, canvas);
  await page.keyboard.press('Alt+Digit0');
  await expect(page.getByTestId('md-footnote-dialog')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Alt+Digit0');
  await expect(page.getByTestId('md-footnote-dialog')).toHaveCount(0);
  await caretAtEnd(page, canvas);
  await page.getByTestId('md-tool-footnotes').click();
  await expect(page.getByTestId('md-footnote-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('md-footnote-dialog')).toHaveCount(0);
  await stillEditing();

  // None of those keys typed anything.
  await expect(canvas).not.toContainText(/Before\.[fme0]/i);

  // The field's own Escape still cancels the edit (asking first: the
  // footnote key left a citation), and only then does Escape close the card.
  // From Source: in the rich canvas ProseMirror claims Escape for itself (it
  // selects the enclosing block), as it always has.
  await field.getByRole('button', { name: 'Source', exact: true }).click();
  const source = field.locator('.cm-content');
  await expect(source).toContainText('Before.[^1]');
  await source.click();
  const [confirm] = await Promise.all([
    page.waitForEvent('dialog').then(async (d) => {
      const message = d.message();
      await d.accept();
      return message;
    }),
    page.keyboard.press('Escape'),
  ]);
  expect(confirm).toContain('Discard');
  await expect(field.getByTestId(FIELD + '-edit')).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(await deviceA.get('task', TASK)).toMatchObject({ description: 'Before.' });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('each tool writes its markdown: a footnote, a mermaid fence, and a drawing stored as a synced asset', async ({
  deviceA,
  deviceB,
}) => {
  await seedEditorCard(deviceA, deviceB, 'A claim worth citing.');
  const page = deviceA.page;
  const dialog = await openEditorCard(deviceA);
  const { field, canvas } = await openDescriptionEditor(dialog);

  // Footnote: the key cites at the caret and opens the note, ready to write.
  await caretAtEnd(page, canvas);
  await page.keyboard.press('Alt+Digit0');
  const note = page.getByTestId('md-footnote-text');
  await expect(note).toBeFocused({ timeout: 15_000 });
  await page.keyboard.type('The source of the claim.');
  await page.getByTestId('md-footnote-save').click();
  await expect(page.getByTestId('md-footnote-dialog')).toHaveCount(0);

  // Diagram: a template, inserted as a fence.
  await caretAtEnd(page, canvas);
  await page.keyboard.press('Alt+KeyM');
  await expect(page.getByTestId('md-diagram-dialog')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('md-diagram-template-flowchart').click();
  await page.getByTestId('md-diagram-save').click();
  await expect(page.getByTestId('md-diagram-dialog')).toHaveCount(0);

  // Drawing: a rectangle, saved as a PNG with the scene inside.
  await caretAtEnd(page, canvas);
  await page.keyboard.press('Alt+KeyE');
  await expect(page.getByTestId('md-drawing-dialog')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('md-drawing-loading')).toHaveCount(0, { timeout: 60_000 });
  await page.keyboard.press('r');
  const box = (await page.getByTestId('md-drawing-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 6 });
  await page.mouse.up();
  await page.getByTestId('md-drawing-save').click();
  await expect(page.getByTestId('md-drawing-dialog')).toHaveCount(0, { timeout: 30_000 });
  await expect(canvas.locator('.milkdown-image-block')).toHaveCount(1, { timeout: 10_000 });
  // Crepe shows the stored image, and it wears the ✏ that reopens it.
  await expect(canvas.locator('.milkdown-image-block img').first()).toHaveAttribute('src', /^blob:/);
  await expect(canvas.getByTestId('md-drawing-edit')).toHaveCount(1);

  // Ctrl/Cmd+S saves from the canvas. (Not the Save button: with a diagram
  // and a drawing in it the card dialog outgrows the viewport and its foot is
  // off-screen — CardDialog's grid overflow, reported to 10c-K.)
  await canvas.click();
  await page.keyboard.press('ControlOrMeta+KeyS');
  await expect(field.getByTestId(FIELD + '-edit')).toBeVisible();
  const row = await pollRow(
    deviceA,
    'task',
    TASK,
    (r) => /\]\(assets\/[0-9a-f-]{36}\.excalidraw\.png\)/.test(String(r?.description ?? '')),
    'the drawing ref was stored'
  );
  const md = String(row.description);
  expect(md).toContain('A claim worth citing.[^1]');
  expect(md).toContain('[^1]: The source of the claim.');
  expect(md).toMatch(/```mermaid\nflowchart/);
  const assetId = /assets\/([0-9a-f-]{36})\.excalidraw\.png/.exec(md)![1]!;
  expect(await deviceA.get('asset', assetId)).toMatchObject({ mime: 'image/png', deleted_at: null });

  // The preview shows all three: the note, the diagram as a picture, the image.
  const preview = await renderedDescription(dialog);
  await expect(preview.locator('section[data-footnotes] li')).toContainText('The source of the claim.');
  await expect(preview.locator('pre.mermaid-rendered svg')).toBeVisible();
  await expect(preview.locator('img')).toHaveAttribute('src', /^blob:/);
});

test('the drawing canvas has the keyboard, and Escape finishes a line instead of closing anything', async ({
  deviceA,
  deviceB,
}) => {
  await seedEditorCard(deviceA, deviceB, 'Before the drawing.');
  const page = deviceA.page;
  const dialog = await openEditorCard(deviceA);
  const { field, canvas } = await openDescriptionEditor(dialog);
  await caretAtEnd(page, canvas);
  await page.keyboard.press('Alt+KeyE');
  const drawing = page.getByTestId('md-drawing-dialog');
  await expect(drawing).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('md-drawing-loading')).toHaveCount(0, { timeout: 60_000 });
  await page.waitForFunction(() => (window as never)['__planeeDrawing'] !== undefined, undefined, { timeout: 30_000 });

  const inText = () => page.evaluate(() => !!document.activeElement?.closest('[data-testid="md-canvas"]'));
  const tool = () =>
    page.evaluate(
      () => (window as unknown as { __planeeDrawing: { getAppState(): { activeTool: { type: string } } } }).__planeeDrawing.getAppState().activeTool.type
    );
  const lineInProgress = () =>
    page.evaluate(
      () =>
        (window as unknown as { __planeeDrawing: { getAppState(): { multiElement: unknown } } }).__planeeDrawing.getAppState()
          .multiElement !== null
    );
  expect(await inText()).toBe(false);

  await page.keyboard.press('5'); // the arrow tool
  await expect.poll(tool).toBe('arrow');
  await page.keyboard.press('l'); // the line tool
  await expect.poll(tool).toBe('line');

  const box = (await page.getByTestId('md-drawing-canvas').boundingBox())!;
  const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;
  await page.mouse.click(...at(0.3, 0.5));
  await page.mouse.click(...at(0.5, 0.4));
  await page.mouse.click(...at(0.7, 0.6));
  await expect.poll(lineInProgress).toBe(true);

  await page.keyboard.press('Escape');
  await expect.poll(lineInProgress).toBe(false);
  await expect(drawing).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(field.getByTestId(FIELD + '-save')).toBeVisible();

  await page.getByTestId('md-drawing-cancel').click();
  await expect(drawing).toHaveCount(0);
  await expect(canvas).toHaveText('Before the drawing.');
});

test('MathLive attribute commands never reach the page as attributes', async ({ deviceA, deviceB }) => {
  const evil = [
    String.raw`$\style{position:fixed;top:0;left:0;width:100vw;height:100vh;background:red}{x}$`,
    String.raw`$\cssId{app}{y}$`,
    String.raw`$\href{https://evil.test}{z}$`,
    String.raw`$\htmlData{a=b,href=https://evil.test}{w}$`,
    String.raw`$\class{btn}{v}$`,
    String.raw`$\color{;position:fixed}{u}$`,
  ].join(' and ');
  await seedEditorCard(deviceA, deviceB, evil);
  const page = deviceA.page;
  const dialog = await openEditorCard(deviceA);

  const check = (attributes: string[]) => {
    const all = attributes.join('\n');
    expect(all, 'a user-controlled id').not.toMatch(/ id=/);
    expect(all, 'a user-controlled href').not.toMatch(/ href=/);
    expect(all, 'a user-controlled data attribute').not.toMatch(/ data-(?!math|display)[\w-]+=/);
    expect(all, 'a user-controlled style').not.toMatch(/fixed|100vw|100vh|background:red/);
    expect(all, 'a user-controlled class').not.toMatch(/class=[^\n]*\bbtn\b/);
  };

  const preview = await renderedDescription(dialog);
  await expect(preview.locator('.math .ML__latex')).toHaveCount(6);
  check(await mathMarkupAttributes(preview, '.math'));
  expect(await page.evaluate(() => document.getElementById('app'))).toBeNull();

  const { canvas } = await openDescriptionEditor(dialog);
  await expect(canvas.locator('.math-node .ML__latex')).toHaveCount(6, { timeout: 30_000 });
  check(await mathMarkupAttributes(canvas, '.math-node'));

  // The formula dialog refuses them too, and says so.
  await canvas.locator('.math-node').first().dblclick();
  await mathDialogReady(page);
  await expect(page.getByTestId('md-math-filtered')).toContainText(String.raw`\style`);
  await expect(page.getByTestId('md-math-latex')).toHaveValue('{x}');
  expect(await mathFieldValue(page)).not.toContain('style');
});

test('Settings rebinds the formula key on this device, refusing app keys and Ctrl+S', async ({ deviceA, deviceB }) => {
  await seedEditorCard(deviceA, deviceB, 'Keys.');
  const page = deviceA.page;
  await deviceA.goto('/settings/');
  const formula = page.getByTestId('shortcut-formula');
  const note = page.getByTestId('shortcut-note');
  await expect(formula).toHaveText('Alt+F');

  await page.getByTestId('shortcut-change-formula').click();
  await expect(page.getByTestId('shortcut-change-formula')).toHaveText('Press keys…');
  // An app keybind's browser-safe fallback (New task) and the field's Save.
  await page.keyboard.press('Alt+KeyN');
  await expect(note).toHaveText('Alt+N is taken by New task.');
  await page.keyboard.press('ControlOrMeta+KeyS');
  await expect(note).toHaveText(/^(Ctrl|Cmd)\+S is taken by Save\.$/);
  // Another tool's key.
  await page.keyboard.press('Alt+KeyM');
  await expect(note).toHaveText('Alt+M already opens diagram.');
  await expect(formula).toHaveText('Alt+F');
  // A free one.
  await page.keyboard.press('Alt+KeyQ');
  await expect(formula).toHaveText('Alt+Q');
  await expect(note).toContainText('Alt+Q');
  await expect(page.getByTestId('shortcut-change-formula')).toHaveText('Change');
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('planee-editor-shortcuts'))) ?? '{}')).toMatchObject({
    formula: 'Alt+Q',
  });

  // The editor follows the device's setting: the toolbar says so, the old key
  // is nobody's, and the new one opens the formula dialog.
  const dialog = await openEditorCard(deviceA);
  const { editor, canvas } = await openDescriptionEditor(dialog);
  await expect(editor.getByTestId('md-key-formula')).toHaveText('Alt+Q');
  await caretAtEnd(page, canvas);
  await page.keyboard.press('Alt+KeyF');
  await page.waitForTimeout(300);
  await expect(page.getByTestId('md-math-dialog')).toHaveCount(0);
  await page.keyboard.press('Alt+KeyQ');
  await mathDialogReady(page);
  await page.getByTestId('md-math-cancel').click();

  // It is per device: B still has the default.
  const dialogB = await openEditorCard(deviceB);
  const editorB = await openDescriptionEditor(dialogB);
  await expect(editorB.editor.getByTestId('md-key-formula')).toHaveText('Alt+F');

  // Reset puts the defaults back.
  await deviceA.goto('/settings/');
  await page.getByTestId('shortcuts-reset').click();
  await expect(formula).toHaveText('Alt+F');
});

test('the palette offers the editor tools only while an editor is open, with their keys, and opens them', async ({
  deviceA,
  deviceB,
}) => {
  await seedEditorCard(deviceA, deviceB, 'Palette.');
  const page = deviceA.page;
  const dialog = await openEditorCard(deviceA);
  const palette = page.getByTestId('palette');
  const item = (label: string) => page.getByTestId('palette-item').filter({ hasText: label });

  // Not editing: no tools, but the create actions show their keys (the
  // browser-safe fallbacks — this is not an installed app).
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(palette).toBeVisible();
  await expect(page.locator('[data-testid="palette-item"][data-kind="tool"]')).toHaveCount(0);
  await expect(item('New Task').getByTestId('palette-item-keys')).toHaveText('Alt+N');
  await expect(item('New Project').getByTestId('palette-item-keys')).toHaveText('Alt+Shift+P');
  await expect(item('New Version').getByTestId('palette-item-keys')).toHaveText('Ctrl+Shift+V');
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await expect(dialog).toBeVisible();

  const { canvas } = await openDescriptionEditor(dialog);
  await caretAtEnd(page, canvas);
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(palette).toBeVisible();
  const tools = page.locator('[data-testid="palette-item"][data-kind="tool"]');
  await expect(tools).toHaveCount(4);
  await expect(tools.nth(0)).toContainText('Insert a formula');
  await expect(item('Insert a formula').getByTestId('palette-item-keys')).toHaveText('Alt+F');
  await expect(item('Insert a diagram').getByTestId('palette-item-keys')).toHaveText('Alt+M');
  await expect(item('Insert a drawing').getByTestId('palette-item-keys')).toHaveText('Alt+E');
  await expect(item('Insert a footnote').getByTestId('palette-item-keys')).toHaveText('Alt+0');

  // The palette closes first, then the formula dialog opens in the editor.
  await item('Insert a formula').click();
  await expect(palette).toHaveCount(0);
  await mathDialogReady(page);
  await page.getByTestId('md-math-latex').fill('a+b');
  await page.getByTestId('md-math-save').click();
  await expect(canvas.locator('.math-node')).toHaveAttribute('data-value', 'a+b', { timeout: 10_000 });

  // Typing into the palette filters to the tool too.
  await caretAtEnd(page, canvas);
  await page.keyboard.press('ControlOrMeta+KeyK');
  await page.getByTestId('palette-input').fill('diagram');
  await expect(page.locator('[data-testid="palette-item"]').first()).toHaveAttribute('data-kind', 'tool');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId('md-diagram-dialog')).toBeVisible({ timeout: 30_000 });
});
