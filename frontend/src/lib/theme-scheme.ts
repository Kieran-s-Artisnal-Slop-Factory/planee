/**
 * The colour scheme in effect, for the few things `light-dark()` cannot
 * switch: mermaid's theme and the Excalidraw canvas.
 *
 * Ported from retoken (af25bc6) `src/lib/theme.ts` — just `isDarkScheme`.
 * planee uses retoken's scheme model (Layout.astro pins
 * `document.documentElement.style.colorScheme` from
 * localStorage['retoken-scheme'], or leaves it empty to follow the OS), so the
 * function is unchanged.
 */

/** The scheme actually in effect right now — an explicit pin, else the OS. */
export function isDarkScheme(): boolean {
  if (typeof document === 'undefined') return false;
  const pinned = document.documentElement.style.colorScheme;
  if (pinned === 'dark') return true;
  if (pinned === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
