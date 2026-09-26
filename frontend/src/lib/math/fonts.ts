/**
 * The vendored MathLive stylesheets, and the KaTeX faces it draws with.
 *
 * Ported from notey src/lib/math/fonts.ts. Changed: the paths are exported so
 * the service-worker test can hold the precache list to them (D11), and the
 * links resolve through `href()`, so the GitHub Pages build (base `/planee/`)
 * finds them too.
 *
 * `mathlive-fonts.css` is the whole font mechanism. Its last rule is
 * `:root{--ML__static-fonts:true}`, which tells MathLive's own font loader to
 * stand down — so the library constructs no `FontFace`, probes for no fonts
 * directory, and never asks a CDN for anything. The browser pulls each face
 * on demand through `font-display: swap` (typically two for a formula), and
 * public/sw.js precaches all twenty so formulas render offline too.
 *
 * `mathlive-static.css` is the layout half — what turns the markup
 * `convertLatexToMarkup` returns into a typeset formula. An open
 * `<math-field>` injects its own copy of those rules, so this file is what a
 * page with no editor on it (a description at rest, a table cell) needs.
 *
 * Regenerate both with `npm run copy:math-assets -- --force`
 * (scripts/build-math-assets.mjs).
 */
import { href } from '../paths';

/** The twenty faces, as `public/math/PROVENANCE.txt` records them. */
export const MATH_FONT_FILES: readonly string[] = [
  'KaTeX_AMS-Regular.woff2',
  'KaTeX_Caligraphic-Bold.woff2',
  'KaTeX_Caligraphic-Regular.woff2',
  'KaTeX_Fraktur-Bold.woff2',
  'KaTeX_Fraktur-Regular.woff2',
  'KaTeX_Main-Bold.woff2',
  'KaTeX_Main-BoldItalic.woff2',
  'KaTeX_Main-Italic.woff2',
  'KaTeX_Main-Regular.woff2',
  'KaTeX_Math-BoldItalic.woff2',
  'KaTeX_Math-Italic.woff2',
  'KaTeX_SansSerif-Bold.woff2',
  'KaTeX_SansSerif-Italic.woff2',
  'KaTeX_SansSerif-Regular.woff2',
  'KaTeX_Script-Regular.woff2',
  'KaTeX_Size1-Regular.woff2',
  'KaTeX_Size2-Regular.woff2',
  'KaTeX_Size3-Regular.woff2',
  'KaTeX_Size4-Regular.woff2',
  'KaTeX_Typewriter-Regular.woff2',
];

/** App paths (before `href()`) of the two stylesheets. */
export const MATH_FONT_CSS = '/math/mathlive-fonts.css';
export const MATH_STATIC_CSS = '/math/mathlive-static.css';

/** Every vendored file, as an app path — what the service worker precaches. */
export const MATH_ASSETS: readonly string[] = [
  MATH_FONT_CSS,
  MATH_STATIC_CSS,
  ...MATH_FONT_FILES.map((name) => `/math/fonts/${name}`),
];

const FONT_LINK_ID = 'planee-math-fonts';
const STATIC_LINK_ID = 'planee-math-static';

/**
 * Put the font stylesheet in the document, once.
 *
 * Called from the formula dialog's mount, never at module scope — a page
 * that never shows a formula should not carry the request.
 */
export function ensureFontCss(): void {
  appendStylesheet(FONT_LINK_ID, MATH_FONT_CSS);
}

/**
 * Put both stylesheets in the document, once — the layout rules need the
 * faces, and neither declares the other's half.
 */
export function ensureMathCss(): void {
  ensureFontCss();
  appendStylesheet(STATIC_LINK_ID, MATH_STATIC_CSS);
}

function appendStylesheet(id: string, path: string): void {
  if (typeof document === 'undefined' || document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href(path);
  document.head.append(link);
}
