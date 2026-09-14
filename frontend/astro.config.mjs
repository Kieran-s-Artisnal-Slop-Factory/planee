// @ts-check
import { defineConfig } from 'astro/config';

import svelte from '@astrojs/svelte';

// https://astro.build/config
export default defineConfig({
  // Serving under a sub-path (e.g. GitHub Pages at https://you.github.io/planee/)?
  // Uncomment and set the base — every in-app link, the service worker, and the
  // manifest already resolve through it (src/lib/paths.ts). Leave it off when
  // serving at the domain root (the default, and how the backend serves it).
  // base: '/planee',
  integrations: [svelte()]
});
