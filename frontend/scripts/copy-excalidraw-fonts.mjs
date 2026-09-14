// Copy the self-hosted Excalidraw fonts (D14) out of node_modules into
// public/excalidraw/fonts/, keeping the <Family>/<file>.woff2 layout Excalidraw
// resolves against window.EXCALIDRAW_ASSET_PATH (see src/lib/excalidraw.ts).
//
// Only the three families planee uses are hosted: Excalifont (the default
// hand-drawn font), Nunito (the "normal" font) and Cascadia (code). The rest —
// notably Xiaolai, the 13 MB CJK fallback — would bloat the offline precache.
//
// The copies are committed; rerun `npm run copy:excalidraw-fonts` after
// upgrading @excalidraw/excalidraw (the file names carry content hashes).
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAMILIES = ['Excalifont', 'Nunito', 'Cascadia'];
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts');
const to = join(root, 'public', 'excalidraw', 'fonts');

if (!existsSync(from)) {
  console.error(`Not found: ${from} — run npm install first.`);
  process.exit(1);
}

rmSync(to, { recursive: true, force: true });
let files = 0;
let bytes = 0;
for (const family of FAMILIES) {
  const source = join(from, family);
  for (const name of readdirSync(source)) {
    if (!name.endsWith('.woff2')) continue;
    cpSync(join(source, name), join(to, family, name));
    files++;
    bytes += statSync(join(source, name)).size;
  }
}
console.log(`Copied ${files} woff2 files (${(bytes / 1024).toFixed(0)} KB) to public/excalidraw/fonts/`);
