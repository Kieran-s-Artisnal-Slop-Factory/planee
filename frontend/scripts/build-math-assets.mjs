/**
 * Vendors MathLive's stylesheets and KaTeX web fonts into public/math/.
 *
 * Ported from notey tools/build-math-assets.mjs (paths and wording only).
 *
 * Maths is written and drawn by MathLive — the `<math-field>` in the formula
 * editor and `convertLatexToMarkup` for markdown that is only being read —
 * and MathLive draws out of twenty KaTeX faces. Those faces have to be served
 * from this origin: planee is offline-first (D11), and the service worker
 * precaches every file this script writes (public/sw.js FONT_ASSETS).
 *
 * `mathlive-fonts.css` is copied VERBATIM, not rewritten. Its `url(fonts/…)`
 * are relative and resolve correctly once the file sits beside a `fonts/`
 * directory — and its trailing `:root{--ML__static-fonts:true}` is the line
 * that tells MathLive's own font loader to stand down, so the library never
 * constructs a `FontFace` or probes for a fonts directory of its own.
 *
 * `mathlive-static.css` is copied with every `@font-face` block REMOVED. It
 * declares the same twenty faces `mathlive-fonts.css` does, and two
 * declarations of one family is one too many; what remains is ~9 KB of
 * layout rules. Those rules are what turn `convertLatexToMarkup`'s output
 * into a typeset formula, so they are needed wherever markdown is READ —
 * the preview, the table cells and the editor canvas. (An open
 * `<math-field>` injects its own copy; a page with no editor on it gets
 * nothing unless this file is there.)
 *
 * NOT vendored, deliberately:
 *  - the five `.wav` keypress sounds (227 KB). `soundsDirectory = null`
 *    switches them off; tests/sync/editor-ui.spec.ts asserts none is ever
 *    requested.
 *  - `@cortex-js/compute-engine` (2.5 MB). It is what MathLive would use to
 *    EVALUATE a formula; planee only ever reads LaTeX back out, so nothing
 *    imports it and Vite never sees it.
 *
 * The output is COMMITTED. This script exists so the provenance is
 * reproducible, not so anything is fetched at run time.
 *
 *   npm run copy:math-assets -- [--force]   (node scripts/build-math-assets.mjs)
 *
 * Licences: MathLive is MIT (Copyright (c) 2017 Arno Gourdol). The faces are
 * KaTeX's, MIT (Copyright (c) 2013-2020 Khan Academy and contributors).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC_DIR = resolve(ROOT, 'node_modules/mathlive');
const SRC_FONTS = join(SRC_DIR, 'fonts');
const OUT_DIR = resolve(ROOT, 'public/math');
const OUT_FONTS = join(OUT_DIR, 'fonts');
const CSS_NAME = 'mathlive-fonts.css';
const STATIC_CSS_NAME = 'mathlive-static.css';

/** The face count is the invariant: a partial copy renders half the glyphs. */
const EXPECTED_FONTS = 20;

const force = process.argv.includes('--force');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

if (!existsSync(SRC_FONTS)) {
  throw new Error('mathlive is not installed — run npm install first.');
}

const faces = readdirSync(SRC_FONTS)
  .filter((name) => name.endsWith('.woff2'))
  .sort();

if (faces.length !== EXPECTED_FONTS) {
  throw new Error(
    `expected ${EXPECTED_FONTS} faces in ${SRC_FONTS}, found ${faces.length} — refusing to write.`
  );
}

for (const name of [CSS_NAME, STATIC_CSS_NAME]) {
  if (!existsSync(join(SRC_DIR, name))) {
    throw new Error(`${name} is missing from the mathlive package — refusing to write.`);
  }
}

mkdirSync(OUT_FONTS, { recursive: true });

const copied = [];
let skipped = 0;
for (const name of [...faces.map((f) => join('fonts', f)), CSS_NAME]) {
  const from = join(SRC_DIR, name);
  const to = join(OUT_DIR, name);
  if (existsSync(to) && !force) {
    skipped++;
  } else {
    copyFileSync(from, to);
    copied.push(name);
  }
}

/**
 * mathlive-static.css minus its twenty `@font-face` blocks. The blocks are
 * minified onto one line with no nested braces, so a non-greedy brace match
 * is exact; the count is asserted so a MathLive release that changes shape
 * fails loudly instead of shipping a stylesheet that quietly re-declares the
 * faces over `url(fonts/…)` paths that are wrong for where this file sits.
 */
const staticFull = readFileSync(join(SRC_DIR, STATIC_CSS_NAME), 'utf8');
const faceBlocks = staticFull.match(/@font-face\{[^{}]*\}/g) ?? [];
if (faceBlocks.length !== EXPECTED_FONTS) {
  throw new Error(
    `expected ${EXPECTED_FONTS} @font-face blocks in ${STATIC_CSS_NAME}, found ` +
      `${faceBlocks.length} — refusing to write.`
  );
}
const staticLayout = staticFull.replace(/@font-face\{[^{}]*\}/g, '').trim() + '\n';
if (/@font-face|url\(/.test(staticLayout)) {
  throw new Error(`${STATIC_CSS_NAME} still references a font or URL after stripping — refusing`);
}
{
  const to = join(OUT_DIR, STATIC_CSS_NAME);
  if (existsSync(to) && !force) {
    skipped++;
  } else {
    writeFileSync(to, staticLayout, 'utf8');
    copied.push(STATIC_CSS_NAME);
  }
}

const version = JSON.parse(readFileSync(join(SRC_DIR, 'package.json'), 'utf8')).version;
const entries = [
  ...faces.map((f) => join('fonts', f).replaceAll('\\', '/')),
  CSS_NAME,
  STATIC_CSS_NAME,
].map((name) => {
  const path = join(OUT_DIR, name);
  return { name, bytes: statSync(path).size, hash: sha256(path) };
});
const total = entries.reduce((sum, e) => sum + e.bytes, 0);

writeFileSync(
  join(OUT_DIR, 'PROVENANCE.txt'),
  [
    'MathLive stylesheets and KaTeX web fonts, vendored for offline use.',
    '',
    `source:      node_modules/mathlive @ ${version}`,
    `             (${STATIC_CSS_NAME} has its 20 @font-face blocks removed;`,
    `             ${CSS_NAME} declares the same families over the same faces)`,
    'licence:     MIT (MathLive, (c) 2017 Arno Gourdol)',
    '             MIT (the KaTeX faces, (c) 2013-2020 Khan Academy and',
    '             contributors)',
    'regenerate:  node scripts/build-math-assets.mjs --force',
    '',
    'Not vendored: the five .wav keypress sounds (soundsDirectory = null switches',
    'them off) and @cortex-js/compute-engine, which evaluates formulas — planee',
    'only reads LaTeX back out, so nothing imports it.',
    '',
    `${entries.length} files, ${total} bytes total`,
    '',
    ...entries.map((e) => `${String(e.bytes).padStart(7)}  ${e.hash}  ${e.name}`),
    '',
  ].join('\n'),
  'utf8'
);

console.log(
  `${copied.length} copied, ${skipped} already present — ${entries.length} files, ${total} bytes.`
);
if (skipped > 0 && copied.length === 0) console.log('Pass --force to overwrite.');
