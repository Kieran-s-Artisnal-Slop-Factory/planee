/**
 * Attach a third-party stylesheet only when the code that needs it runs.
 *
 * Astro hoists the CSS of every module a `client:only` island can reach —
 * dynamic imports included — into `<link>`s on the page. For the editor that
 * meant every page with a MarkdownField blocked on ~90 KB of Crepe CSS and
 * ~140 KB of Excalidraw CSS it would only need after someone pressed Edit (and
 * Excalidraw's unprefixed class names, `.popover`, `.dropdown-menu`…, sat in the
 * page's cascade all along). Importing those sheets with `?inline` keeps them
 * inside the lazy JS chunk as strings; this puts one into the document the
 * first time it is asked for. Vite still processes them (PostCSS, `@import`
 * inlining, url() → fingerprinted assets), so fonts behave as before.
 */
const attached = new Set<string>();

export function attachStyle(key: string, css: string): void {
  if (attached.has(key) || typeof document === 'undefined') return;
  attached.add(key);
  const style = document.createElement('style');
  style.dataset.planeeStyle = key;
  style.textContent = css;
  document.head.appendChild(style);
}
