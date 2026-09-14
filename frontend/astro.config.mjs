// @ts-check
import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';

import svelte from '@astrojs/svelte';

/**
 * KaTeX ships every font as woff2 + woff + ttf, and its stylesheet lists all
 * three in each @font-face. Every browser planee supports takes woff2, so the
 * other two only bloat the build and the offline precache (D11). This PostCSS
 * step runs after Vite inlines @imports (so it also sees the copy Crepe's
 * latex.css pulls in) and before Vite resolves url()s, so the dropped files
 * are never emitted at all.
 *
 * @type {import('postcss').PluginCreator<void>}
 */
const woff2OnlyFonts = () => ({
  postcssPlugin: 'planee-woff2-only-fonts',
  AtRule: {
    'font-face'(rule) {
      rule.walkDecls('src', (decl) => {
        const sources = decl.value.split(/,(?![^(]*\))/).map((s) => s.trim());
        const woff2 = sources.filter((s) => /format\(["']?woff2["']?\)|\.woff2["')]/.test(s));
        if (woff2.length > 0 && woff2.length < sources.length) decl.value = woff2.join(', ');
      });
    },
  },
});
woff2OnlyFonts.postcss = true;

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
    css: {
      postcss: { plugins: [woff2OnlyFonts()] },
    },
    plugins: [excalidrawEnglishOnly()],
  },
});
