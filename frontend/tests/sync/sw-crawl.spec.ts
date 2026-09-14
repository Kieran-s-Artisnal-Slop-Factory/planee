import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DIST_DIR } from './helpers/paths';

/**
 * Offline coverage of the production build. The service worker precaches the
 * app by crawling the built HTML/JS/CSS for asset references (public/sw.js
 * warmAssetCache), capped at WARM_MAX_ASSETS fetches. Two silent failures are
 * possible, and neither shows up online:
 *
 *  - a chunk the crawl can't discover (a new import shape) is never cached,
 *    so the page that needs it breaks offline;
 *  - the bundle outgrows the cap, so the crawl stops early and the tail of
 *    the asset graph is never cached.
 *
 * This replays the crawl against dist/ (base '/') using the patterns and
 * lists read out of sw.js itself, so it cannot drift from the real worker.
 * Node-only: no browser, no server.
 */

const sw = readFileSync(join(DIST_DIR, 'sw.js'), 'utf8');

function constArray(name: string): string[] {
  const block = sw.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`));
  if (!block) throw new Error(`${name} not found in sw.js`);
  return [...block[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

function crawlPatterns(): RegExp[] {
  // Every `text.matchAll(/.../g)` in warmAssetCache, in order.
  const found = [...sw.matchAll(/text\.matchAll\(\/(.+?)\/g\)/g)].map((m) => new RegExp(m[1]!, 'g'));
  if (found.length !== 2) throw new Error(`expected 2 crawl patterns in sw.js, found ${found.length}`);
  return found;
}

test('the service worker crawl reaches every built asset within its cap', () => {
  const cap = Number(sw.match(/const WARM_MAX_ASSETS = (\d+);/)?.[1]);
  expect(cap, 'WARM_MAX_ASSETS not found').toBeGreaterThan(0);

  const BASE = '/';
  const ASSET_PREFIX = BASE + '_astro/';
  const [astroRef, relativeRef] = crawlPatterns();
  const start = [...constArray('SHELL'), ...constArray('FONT_ASSETS')].map((p) => BASE + p);

  const fileFor = (url: string) => {
    let p = url.slice(BASE.length);
    if (p === '' || p.endsWith('/')) p += 'index.html';
    return join(DIST_DIR, p);
  };

  const seen = new Set(start);
  const queue = [...start];
  const missing: string[] = [];
  let fetched = 0;
  while (queue.length > 0) {
    const url = queue.shift()!;
    fetched++;
    const file = fileFor(url);
    if (!existsSync(file)) {
      missing.push(url);
      continue;
    }
    if (!/\.(html|js|css)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    const enqueue = (path: string) => {
      if (path.startsWith(ASSET_PREFIX) && !seen.has(path)) {
        seen.add(path);
        queue.push(path);
      }
    };
    for (const m of text.matchAll(astroRef!)) enqueue(BASE + m[0]);
    const from = new URL(url, 'http://planee.test');
    for (const m of text.matchAll(relativeRef!)) {
      try {
        enqueue(new URL(m[1]!, from).pathname);
      } catch {
        // not a resolvable path
      }
    }
  }

  const unreached = readdirSync(join(DIST_DIR, '_astro'))
    .map((f) => ASSET_PREFIX + f)
    .filter((u) => !seen.has(u));

  // Every fetch the crawl spends on a path that doesn't exist is a paced 404
  // counted against the cap — a false positive in the patterns.
  expect(missing, 'crawl fetches paths that do not exist in the build').toEqual([]);
  expect(unreached, 'built assets the crawl never discovers (broken offline)').toEqual([]);
  expect(fetched, `crawl needs ${fetched} fetches but WARM_MAX_ASSETS is ${cap}`).toBeLessThanOrEqual(cap);
});
