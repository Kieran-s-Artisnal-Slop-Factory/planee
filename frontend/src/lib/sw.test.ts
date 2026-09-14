/**
 * Guards for public/sw.js, which is plain JS served as-is (no bundler, no
 * types), so drift between it and the files it names only shows up offline.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const publicDir = new URL('../../public/', import.meta.url);
const sw = readFileSync(new URL('sw.js', publicDir), 'utf8');

describe('service worker', () => {
  it('seeds every self-hosted Excalidraw font into the warm crawl, and nothing else', () => {
    const block = sw.match(/const FONT_ASSETS = \[([\s\S]*?)\]/);
    expect(block, 'FONT_ASSETS missing from sw.js').not.toBeNull();
    const listed = [...block![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

    const fontsDir = new URL('excalidraw/fonts/', publicDir);
    const onDisk = readdirSync(fontsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => readdirSync(new URL(d.name + '/', fontsDir)).map((f) => `excalidraw/fonts/${d.name}/${f}`))
      .sort();

    expect(listed).toEqual(onDisk);
  });
});
