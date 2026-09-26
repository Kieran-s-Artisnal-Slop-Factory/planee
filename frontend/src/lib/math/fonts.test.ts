// Ported from notey src/lib/math/fonts.test.ts (paths are planee's).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MATH_ASSETS, MATH_FONT_CSS, MATH_FONT_FILES, MATH_STATIC_CSS } from './fonts';

const publicDir = new URL('../../../public/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path.replace(/^\//, ''), publicDir), 'utf8');
const provenance = read('/math/PROVENANCE.txt');

describe('the vendored maths bundle', () => {
  it('lists the twenty faces the vendoring script insists on', () => {
    expect(MATH_FONT_FILES).toHaveLength(20);
    expect([...MATH_FONT_FILES]).toEqual([...MATH_FONT_FILES].sort());
  });

  it('has every listed file on disk', () => {
    expect(MATH_ASSETS).toHaveLength(22);
    for (const path of MATH_ASSETS) {
      expect(existsSync(new URL(path.replace(/^\//, ''), publicDir)), path).toBe(true);
    }
  });

  it('ships the layout rules without any @font-face of its own', () => {
    // mathlive-fonts.css declares the same twenty families, and its
    // `--ML__static-fonts` rule is what stops MathLive loading fonts its own
    // way. Two declarations of one family would undo that.
    const css = read(MATH_STATIC_CSS);
    expect(css).not.toContain('@font-face');
    expect(css).not.toContain('url(');
    expect(css).toContain('.ML__latex');
  });

  it('tells MathLive to leave the fonts to the stylesheet, and only names local files', () => {
    const css = read(MATH_FONT_CSS);
    expect(css).toContain('--ML__static-fonts:true');
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]!.replace(/["']/g, ''));
    expect(urls.length).toBeGreaterThan(0);
    // Relative to the stylesheet: never a CDN, never an absolute path that
    // would miss the GitHub Pages base.
    for (const url of urls) expect(url).toMatch(/^fonts\/KaTeX_[\w-]+\.woff2$/);
    expect(new Set(urls.map((u) => u.slice('fonts/'.length)))).toEqual(new Set(MATH_FONT_FILES));
  });

  it('agrees with what is actually on disk', () => {
    // The provenance file is written by the vendoring script from the real
    // file sizes, so this fails if someone re-vendors a different build.
    for (const name of MATH_FONT_FILES) expect(provenance).toContain(name);
    expect(provenance).toContain('mathlive-static.css');
    expect(provenance).toContain('mathlive-fonts.css');
    expect(/(\d+) bytes total/.exec(provenance), 'PROVENANCE.txt has no byte total').not.toBeNull();
  });

  it('records what was left behind on purpose', () => {
    // 227 KB of keypress .wav files and 2.5 MB of computer algebra nobody
    // asked for. If a future vendoring silently starts copying them, these
    // lines go and the test says so.
    expect(provenance).toContain('soundsDirectory = null');
    expect(provenance).toContain('compute-engine');
    expect(provenance).not.toContain('.wav"');
  });
});
