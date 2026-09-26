import { expect, type Locator, type Page } from '@playwright/test';
import type { Device } from './devices';
import { cardLocator, expectSettledCard, openBoard, seedProject, syncAll } from './board';

/**
 * Helpers for the markdown editor through the real UI (editor-ui.spec.ts,
 * 10c-E): the board card dialog's task description, the editor's tools and
 * their dialogs. The editor's hooks are `md-*` test ids (MarkdownEditor,
 * MathDialog, DiagramDialog, DrawingDialog, FootnoteDialog).
 */

export const PROJECT = 'ed-p';
export const VERSION = 'ed-v';
export const TASK = 'ed-t';
export const LINK = 'ed-l';
export const FIELD = 'task-description';

/** One project, one version, one card whose task has `description`; synced to B. */
export async function seedEditorCard(a: Device, b: Device, description: string | null): Promise<void> {
  await seedProject(a, {
    project: { id: PROJECT, name: 'Editor' },
    versions: [{ id: VERSION, number: '0.1.0' }],
    cards: [{ task: TASK, link: LINK, title: 'Write it up', status: 'todo', description }],
  });
  await syncAll(a, b);
}

/**
 * The card dialog, told apart from the editor's own tool dialogs (which
 * nest inside it and also have role=dialog and a close button) by the
 * description field it holds.
 */
export const cardDialogOf = (page: Page): Locator =>
  page.locator('[role="dialog"]').filter({ has: page.getByTestId(FIELD) });

/** Open the board and the card's dialog. */
export async function openEditorCard(device: Device): Promise<Locator> {
  await openBoard(device, PROJECT, VERSION);
  await expectSettledCard(device.page, 'todo', LINK);
  await cardLocator(device.page, LINK).locator('.kb-title-btn').click();
  const dialog = cardDialogOf(device.page);
  await expect(dialog).toBeVisible();
  return dialog;
}

export interface OpenEditor {
  field: Locator;
  editor: Locator;
  /** The ProseMirror contenteditable. */
  canvas: Locator;
}

/** Press the description's Edit and wait for the WYSIWYG canvas to be live. */
export async function openDescriptionEditor(dialog: Locator): Promise<OpenEditor> {
  const field = dialog.getByTestId(FIELD);
  await field.getByTestId(FIELD + '-edit').click();
  await expect(field.getByTestId(FIELD + '-save')).toBeEnabled({ timeout: 15_000 });
  const editor = field.getByTestId('md-editor');
  const canvas = editor.locator('[data-testid="md-canvas"] .ProseMirror');
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  return { field, editor, canvas };
}

/** Put the caret at the very end of the canvas's text. */
export async function caretAtEnd(page: Page, canvas: Locator): Promise<void> {
  await canvas.click();
  await page.keyboard.press('ControlOrMeta+End');
}

/** The formula dialog, once MathLive's field has the keyboard. */
export async function mathDialogReady(page: Page): Promise<Locator> {
  const dialog = page.getByTestId('md-math-dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('md-math-loading')).toHaveCount(0, { timeout: 60_000 });
  return dialog;
}

/** What the mathfield holds, as LaTeX. */
export const mathFieldValue = (page: Page): Promise<string> =>
  page.getByTestId('md-math-field').evaluate((el) => (el as HTMLElement & { value: string }).value);

/** The rendered description (MarkdownPreview) at rest, once it has finished drawing. */
export async function renderedDescription(dialog: Locator): Promise<Locator> {
  const preview = dialog.locator(`[data-testid="${FIELD}-preview"] .preview`);
  await expect(preview).toHaveAttribute('data-rendered', 'true', { timeout: 30_000 });
  return preview;
}

/**
 * Every attribute on every element inside the math under `scope` (preview
 * `.math` placeholders or canvas `.math-node`s), as `tag name=value`.
 */
export const mathMarkupAttributes = (scope: Locator, selector: string): Promise<string[]> =>
  scope.locator(selector).evaluateAll((nodes) =>
    nodes.flatMap((node) =>
      [...node.querySelectorAll('*')].flatMap((el) =>
        [...el.attributes].map((a) => `${el.localName} ${a.name}=${a.value}`)
      )
    )
  );

/** Record every request `page` makes that leaves the app's origin or asks for a sound file. */
export function watchForeignRequests(page: Page, origin: string): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    // The theme's Google Fonts are a known, pre-existing exception (Layout.astro).
    if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) return;
    if (!url.startsWith(origin) || /\.wav(?:$|\?)/.test(url)) seen.push(url);
  });
  return seen;
}
