/**
 * Guards for public/sw.js, which is plain JS served as-is (no bundler, no
 * types), so drift between it and the files it names only shows up offline.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MATH_ASSETS } from './math/fonts';

const publicDir = new URL('../../public/', import.meta.url);
const sw = readFileSync(new URL('sw.js', publicDir), 'utf8');

/** Every file under public/<dir>/, as `<dir>/…/<file>` paths. */
function filesUnder(dir: string): string[] {
  return readdirSync(new URL(dir + '/', publicDir), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => {
      const parent = (d.parentPath ?? '').replace(/\\/g, '/');
      const rel = parent.slice(parent.lastIndexOf('/public/') + '/public/'.length);
      return `${rel}/${d.name}`.replace(/\/{2,}/g, '/').replace(/^\/+/, '');
    })
    .sort();
}

const listed = () => {
  const block = sw.match(/const FONT_ASSETS = \[([\s\S]*?)\]/);
  expect(block, 'FONT_ASSETS missing from sw.js').not.toBeNull();
  return [...block![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
};

describe('service worker', () => {
  it('seeds every self-hosted Excalidraw font and math file into the warm crawl, and nothing else', () => {
    const onDisk = [
      ...filesUnder('excalidraw/fonts'),
      // PROVENANCE.txt documents the vendoring; the app never requests it.
      ...filesUnder('math').filter((f) => f !== 'math/PROVENANCE.txt'),
    ].sort();
    expect(listed()).toEqual(onDisk);
  });

  it('precaches exactly the math files lib/math/fonts.ts links (D11, D21)', () => {
    const math = listed().filter((p) => p.startsWith('math/'));
    expect(math).toEqual(MATH_ASSETS.map((p) => p.replace(/^\//, '')).sort());
    expect(math).toContain('math/mathlive-fonts.css');
    expect(math).toContain('math/mathlive-static.css');
    expect(math.filter((p) => p.endsWith('.woff2'))).toHaveLength(20);
  });
});
