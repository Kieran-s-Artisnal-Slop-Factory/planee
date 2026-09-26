/**
 * Whether any MarkdownField inside `root` is open in its editor.
 *
 * Read from the DOM: a MarkdownField renders its Save/Cancel row
 * (`.md-field-actions`) only while editing. The create forms disable their
 * submit meanwhile (submitting would drop the unsaved text), and the FAB's
 * dialog refuses to close over it.
 */
export const MARKDOWN_EDITING_SELECTOR = '.md-field-actions';

export function isMarkdownEditing(root: ParentNode | null | undefined): boolean {
  return !!root?.querySelector(MARKDOWN_EDITING_SELECTOR);
}

/** Report editing state changes under `root`; returns the cleanup (for a Svelte $effect). */
export function watchMarkdownEditing(root: HTMLElement | null, report: (editing: boolean) => void): (() => void) | void {
  if (!root) {
    report(false);
    return;
  }
  const check = () => report(isMarkdownEditing(root));
  const observer = new MutationObserver(check);
  observer.observe(root, { childList: true, subtree: true });
  check();
  return () => observer.disconnect();
}
