// @ts-check
import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';

import svelte from '@astrojs/svelte';

// No KaTeX stylesheet is bundled any more (D21: MathLive draws every formula,
// from the woff2 faces vendored in public/math/, and the editor skips Crepe's
// latex.css), so the PostCSS step that stripped KaTeX's woff/ttf sources (D11)
// is gone: with nothing left to strip, the build was byte-identical without it.

/**
 * Excalidraw lazy-loads its UI translations from 55 locale chunks. planee's
 * UI is English, so every locale but `en` is replaced with an empty module at
 * build time (D11): picking another language in the canvas menu just keeps
 * English (Excalidraw falls back to its bundled strings). Build-only — the dev
 * server pre-bundles Excalidraw and keeps them, which is harmless.
 *
 * @returns {import('vite').Plugin}
 */
function excalidrawEnglishOnly() {
  const LOCALE_IMPORT =
    /(["'])\.\/locales\/([\w-]+)\.json\1\s*:\s*\(\)\s*=>\s*import\(\s*(["'])\.\/locales\/[^"']+\3\s*\)/g;
  return {
    name: 'planee-excalidraw-english-only',
    apply: 'build',
    transform(code, id) {
      if (!/@excalidraw[\\/]excalidraw[\\/]dist[\\/](?:prod|dev)[\\/]index\.js$/.test(id)) return null;
      let dropped = 0;
      const out = code.replace(LOCALE_IMPORT, (match, quote, locale) => {
        if (locale === 'en') return match;
        dropped++;
        return `${quote}./locales/${locale}.json${quote}:()=>Promise.resolve({default:{}})`;
      });
      if (dropped === 0) {
        this.warn('Excalidraw locale imports not found — the locale trim no longer matches this version.');
        return null;
      }
      return { code: out, map: null };
    },
  };
}

// https://astro.build/config
export default defineConfig({
  // Serving under a sub-path (e.g. GitHub Pages at https://you.github.io/planee/)?
  // Uncomment and set the base — every in-app link, the service worker, and the
  // manifest already resolve through it (src/lib/paths.ts). Leave it off when
  // serving at the domain root (the default, and how the backend serves it).
  // base: '/planee',
  integrations: [svelte()],
  vite: {
    resolve: {
      alias: [
        {
          // Crepe imports CodeMirror's full ~150-language list as its default;
          // point it (and everything else) at planee's shortlist (D11).
          find: /^@codemirror\/language-data$/,
          replacement: fileURLToPath(new URL('./src/lib/markdown/codemirror-language-data.ts', import.meta.url)),
        },
      ],
    },
    plugins: [excalidrawEnglishOnly()],
  },
});
