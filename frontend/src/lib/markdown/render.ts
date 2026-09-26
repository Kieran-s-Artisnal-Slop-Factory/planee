/**
 * RUNTIME markdown → HTML, for showing content the user wrote.
 *
 * Ported from retoken (af25bc6) src/lib/markdown/render.ts. The shape is the
 * same — remark-parse + GFM + math → rehype → HTML, dual-theme Shiki, mermaid
 * fences left for the client-side renderer, image refs rewritten through a
 * caller-supplied resolver — but planee renders content that SYNCS between
 * devices, so the output is sanitised (D8) and the heavy parts are trimmed
 * (D11). Changes:
 *
 *  - **No raw HTML.** `allowDangerousHtml` is gone from remark-rehype and
 *    rehype-stringify, so HTML written into the markdown is dropped rather
 *    than passed through.
 *  - **rehype-sanitize** runs straight after remark-rehype with GitHub's
 *    schema, extended only for what this pipeline itself produces (see
 *    `SCHEMA`). The math placeholders and Shiki run AFTER it: their markup is
 *    generated from already-sanitised text and would otherwise need a far
 *    looser schema.
 *  - **Math (D21)** is no longer KaTeX. `$…$`, `$$…$$` and ```math fences
 *    become `span.math.math-inline[data-math]` /
 *    `div.math.math-display[data-math][data-display]` holding the LaTeX as
 *    plain TEXT (`rehypeMathPlaceholders`), and MarkdownPreview typesets them
 *    with MathLive afterwards (lib/math/typeset.ts, which filters both the
 *    LaTeX and MathLive's markup — lib/math/sanitize.ts). notey's money rule
 *    runs straight after remark-math (lib/math/remark-strict.ts), so
 *    `$5 and $10` stays prose here exactly as it does in the editor canvas.
 *  - **Footnotes keep working.** remark-rehype is told not to prefix ids, so
 *    the sanitiser's `user-content-` clobbering happens exactly once, and
 *    `rehypeLinkIds` then points each `#fn-…` link at its prefixed target
 *    (what GitHub does in JS). It also applies a per-render `idPrefix` so two
 *    previews on one page don't share footnote ids.
 *  - **Mermaid** fences become a real hast element
 *    (`<pre class="mermaid" data-mermaid-source="…">`) via a remark-rehype
 *    handler, not a raw-HTML string.
 *  - **Shiki** is the fine-grained core with the JavaScript regex engine
 *    (no WASM), two themes, and a shortlist of grammars loaded on demand
 *    (`SHIKI_LANGS`); anything else falls back to plain text. Nothing Shiki
 *    loads until a document actually contains a code block.
 *  - **Images:** `data:` srcs must be images; an `assets/<uuid>.<ext>` ref the
 *    resolver can't find (deleted, or not synced yet) shows a small
 *    placeholder instead of a broken request.
 */
import { unified, type Plugin, type Processor } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype, { defaultHandlers } from 'remark-rehype';
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkStrictMath from '../math/remark-strict';
import type { HighlighterCore, LanguageRegistration, ShikiTransformer } from 'shiki/core';
import type { Element, ElementContent, Root } from 'hast';
import type { Code } from 'mdast';

export interface RenderOptions {
  /**
   * Maps a src as written in the markdown (`assets/<uuid>.png`) to a
   * displayable URL (typically a `blob:` URL). Return undefined to leave the
   * src untouched. Absolute URLs are never passed through it.
   */
  resolveImage?: (src: string) => string | undefined;
  /**
   * Inserted into every generated id (`user-content-<idPrefix>fn-1`) so
   * several rendered documents on one page keep their footnote links apart.
   */
  idPrefix?: string;
}

/* ── Sanitising ─────────────────────────────────────────────────────── */

/**
 * GitHub's schema (hast-util-sanitize's default) plus exactly what this
 * pipeline emits before the sanitiser runs:
 *
 *  - `code.math-inline` / `code.math-display` — remark-math's markers, which
 *    `rehypeMathPlaceholders` (after sanitising) turns into the `data-math`
 *    placeholders MathLive typesets. `language-math` is already allowed by
 *    the default `language-*` rule.
 *  - `pre.mermaid[data-mermaid-source]` — the diagram placeholder.
 *  - `data:` image srcs (checked to really be images in `rehypeResolveImages`).
 *
 * Everything else the default already covers: GFM tables and task-list
 * checkboxes, footnote sections/links/`data-footnote-*`, `language-*` classes
 * for Shiki, relative `src`/`href`. Ids and `aria-describedby` are still
 * clobbered with `user-content-` — see `rehypeLinkIds`.
 */
const SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    pre: [...(defaultSchema.attributes?.['pre'] ?? []), ['className', 'mermaid'], 'dataMermaidSource'],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.['src'] ?? []), 'data'],
  },
};

const CLOBBER = 'user-content-';

/**
 * Point in-document links at the sanitiser's prefixed ids, and give this
 * render's ids their own namespace.
 *
 * remark-rehype runs with `clobberPrefix: ''`, so a footnote reference is
 * `<a href="#fn-1">` and its note `<li id="fn-1">`; the sanitiser then makes
 * the id `user-content-fn-1` (it prefixes ids so user content can't clobber
 * the page's own). Without this pass every footnote link would dangle.
 */
const rehypeLinkIds: Plugin<[], Root> = () => (tree, file) => {
  const { idPrefix = '' } = file.data as { idPrefix?: string };
  const renamed = new Map<string, string>();
  const elements: Element[] = [];
  const collect = (node: Root | Element): void => {
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      elements.push(child);
      const id = child.properties.id;
      if (typeof id === 'string' && id.startsWith(CLOBBER)) {
        const bare = id.slice(CLOBBER.length);
        const next = CLOBBER + idPrefix + bare;
        renamed.set(bare, next);
        child.properties.id = next;
      }
      collect(child);
    }
  };
  collect(tree);
  if (renamed.size === 0) return;
  for (const element of elements) {
    const href = element.properties.href;
    if (element.tagName === 'a' && typeof href === 'string' && href.startsWith('#')) {
      let bare = href.slice(1);
      try {
        bare = decodeURIComponent(bare);
      } catch {
        // keep as written
      }
      const target = renamed.get(bare);
      if (target) element.properties.href = '#' + target;
    }
    const described = element.properties.ariaDescribedBy;
    if (Array.isArray(described)) {
      element.properties.ariaDescribedBy = described.map((value) => {
        const text = String(value);
        return text.startsWith(CLOBBER) ? renamed.get(text.slice(CLOBBER.length)) ?? text : text;
      });
    }
  }
};

/* ── Mermaid ────────────────────────────────────────────────────────── */

/**
 * ```mermaid fences → `<pre class="mermaid" data-mermaid-source="…">` with
 * the source as text, so it survives sanitising and Shiki (which only touches
 * `pre > code`) and the preview's post-render pass can hand it to mermaid.
 * Everything else goes through the stock handler.
 */
function codeHandler(
  state: Parameters<typeof defaultHandlers.code>[0],
  node: Code
): ReturnType<typeof defaultHandlers.code> {
  if (node.lang?.trim().toLowerCase() !== 'mermaid') return defaultHandlers.code(state, node);
  const source = node.value ?? '';
  const result: Element = {
    type: 'element',
    tagName: 'pre',
    properties: { className: ['mermaid'], dataMermaidSource: source },
    children: [{ type: 'text', value: source }],
  };
  state.patch(node, result);
  return result;
}

/* ── Math ───────────────────────────────────────────────────────────── */

/** The plain text under a hast node. */
function textOf(node: Element | ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(textOf).join('');
  return '';
}

const classesOf = (element: Element): string[] =>
  Array.isArray(element.properties.className) ? element.properties.className.map(String) : [];

/**
 * remark-math's output → placeholders for the MathLive pass (D21).
 *
 *  - `code.math-inline` (`$…$`, and `$$…$$` inside a sentence) →
 *    `<span class="math math-inline" data-math="…">…</span>`
 *  - `pre > code.math-display` (a `$$` block) and `pre > code.language-math`
 *    (a ```math fence) →
 *    `<div class="math math-display" data-math="…" data-display="">…</div>`
 *
 * The LaTeX is the element's TEXT and the attribute value, never markup, so
 * it is exactly as inert as any other text the sanitiser let through. It
 * runs before Shiki, which would otherwise highlight a ```math fence as code.
 */
const rehypeMathPlaceholders: Plugin<[], Root> = () => (tree) => {
  const walk = (node: Root | Element): void => {
    node.children.forEach((child, index) => {
      if (child.type !== 'element') return;
      if (child.tagName === 'code' && classesOf(child).includes('math-inline')) {
        const latex = textOf(child);
        node.children[index] = {
          type: 'element',
          tagName: 'span',
          properties: { className: ['math', 'math-inline'], dataMath: latex },
          children: [{ type: 'text', value: latex }],
        };
        return;
      }
      const code = child.children[0];
      if (
        child.tagName === 'pre' &&
        code?.type === 'element' &&
        code.tagName === 'code' &&
        classesOf(code).some((c) => c === 'math-display' || c === 'language-math')
      ) {
        const latex = textOf(code).replace(/\n$/, '');
        node.children[index] = {
          type: 'element',
          tagName: 'div',
          properties: { className: ['math', 'math-display'], dataMath: latex, dataDisplay: '' },
          children: [{ type: 'text', value: latex }],
        };
        return;
      }
      walk(child);
    });
  };
  walk(tree);
};

/* ── Code highlighting ──────────────────────────────────────────────── */

type LangModule = { default: LanguageRegistration[] };

/**
 * The grammars a preview can highlight (D11). Each is its own lazy chunk; a
 * grammar that embeds others (svelte, astro, html, …) pulls those in with it.
 */
export const SHIKI_LANGS: Record<string, () => Promise<LangModule>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  javascript: () => import('@shikijs/langs/javascript'),
  tsx: () => import('@shikijs/langs/tsx'),
  jsx: () => import('@shikijs/langs/jsx'),
  svelte: () => import('@shikijs/langs/svelte'),
  astro: () => import('@shikijs/langs/astro'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  markdown: () => import('@shikijs/langs/markdown'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  powershell: () => import('@shikijs/langs/powershell'),
  go: () => import('@shikijs/langs/go'),
  sql: () => import('@shikijs/langs/sql'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  ini: () => import('@shikijs/langs/ini'),
  xml: () => import('@shikijs/langs/xml'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  java: () => import('@shikijs/langs/java'),
};

/**
 * Other names a fence may use for the same grammars — Shiki's own aliases,
 * plus the CodeMirror names Crepe writes when a language is picked there
 * (`shell`, `properties files` → `properties`, `c++`).
 */
const SHIKI_ALIASES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  ecmascript: 'javascript',
  json5: 'json',
  yml: 'yaml',
  md: 'markdown',
  bash: 'shellscript',
  sh: 'shellscript',
  shell: 'shellscript',
  zsh: 'shellscript',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  golang: 'go',
  py: 'python',
  rs: 'rust',
  patch: 'diff',
  docker: 'dockerfile',
  properties: 'ini',
  'c++': 'cpp',
  xhtml: 'html',
};

/** The shortlisted grammar a fence language names, or null. */
export function shikiLanguage(name: string): string | null {
  const lower = name.trim().toLowerCase();
  if (lower in SHIKI_LANGS) return lower;
  return SHIKI_ALIASES[lower] ?? null;
}

interface Shiki {
  highlighter: HighlighterCore;
  /** @shikijs/rehype's core transformer factory. */
  rehypeShiki: typeof import('@shikijs/rehype/core').default;
}

let shikiPromise: Promise<Shiki> | null = null;

/** Shiki core, its JS regex engine, both themes and the rehype adapter — on first use. */
function getShiki(): Promise<Shiki> {
  shikiPromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, rehype] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('@shikijs/rehype/core'),
    ]);
    const highlighter = await createHighlighterCore({
      themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark')],
      langs: [],
      // `forgiving`: skip the odd pattern the JS engine can't express rather
      // than failing the whole grammar.
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
    return { highlighter, rehypeShiki: rehype.default };
  })();
  shikiPromise.catch(() => {
    shikiPromise = null; // let a later render retry (e.g. a chunk failed offline)
  });
  return shikiPromise;
}

const astroCodeClass: ShikiTransformer = {
  // global.css keys the dual-theme colours off Astro's `astro-code` class.
  pre(node) {
    this.addClassToHast(node, 'astro-code');
  },
};

/** The `pre > code` blocks in a tree. */
function codeBlocks(tree: Root): Element[] {
  const found: Element[] = [];
  const walk = (node: Root | Element): void => {
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      const head = child.children[0];
      if (child.tagName === 'pre' && head?.type === 'element' && head.tagName === 'code') {
        found.push(head);
      } else {
        walk(child);
      }
    }
  };
  walk(tree);
  return found;
}

/**
 * Shiki, loaded only when there is code to highlight: normalise each block's
 * language to a shortlisted grammar id, load the grammars that are missing,
 * then run @shikijs/rehype's core transformer over the tree.
 */
const rehypeHighlight: Plugin<[], Root> = () => async (tree) => {
  const blocks = codeBlocks(tree);
  if (blocks.length === 0) return;
  const { highlighter, rehypeShiki } = await getShiki();

  const wanted = new Set<string>();
  for (const code of blocks) {
    const classes = code.properties.className;
    if (!Array.isArray(classes)) continue;
    const index = classes.findIndex((c) => typeof c === 'string' && c.startsWith('language-'));
    if (index === -1) continue;
    const lang = shikiLanguage(String(classes[index]).slice('language-'.length));
    if (!lang) continue;
    classes[index] = `language-${lang}`;
    wanted.add(lang);
  }
  const loaded = highlighter.getLoadedLanguages();
  await Promise.all(
    [...wanted]
      .filter((lang) => !loaded.includes(lang))
      .map((lang) =>
        highlighter.loadLanguage(SHIKI_LANGS[lang]!()).catch(() => {
          // A grammar that fails to load just renders as plain text.
        })
      )
  );

  const highlight = rehypeShiki(highlighter, {
    themes: { light: 'github-light', dark: 'github-dark' },
    // Emit both themes as CSS variables; global.css picks the pair that
    // matches the active colour scheme.
    defaultColor: false,
    fallbackLanguage: 'text',
    transformers: [astroCodeClass],
  }) as (tree: Root) => void | Promise<void>;
  await highlight(tree);
};

/* ── Images ─────────────────────────────────────────────────────────── */

/** `data:` srcs that are images — anything else loses its src. */
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i;

/** An `assets/<uuid>.<ext>` ref (as written in markdown). */
const ASSET_SRC = /^(?:\.\/)?assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[a-z0-9]+)+$/i;

/** Shown in place of an asset this device doesn't have (deleted / not synced). */
export const MISSING_IMAGE_SRC =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/><path d="M3 3l18 18"/></svg>'
  );

/**
 * Rewrite relative `<img src>` through the per-render resolver (carried on
 * the vfile so concurrent renders can't cross wires); absolute URLs and
 * root-relative paths are left alone.
 */
const rehypeResolveImages: Plugin<[], Root> = () => (tree, file) => {
  const { resolveImage: resolve } = file.data as {
    resolveImage?: RenderOptions['resolveImage'];
  };
  const walk = (node: Root | Element): void => {
    if (node.type === 'element' && node.tagName === 'img') {
      const src = node.properties.src;
      if (typeof src === 'string') {
        if (/^data:/i.test(src)) {
          if (!DATA_IMAGE.test(src)) delete node.properties.src;
        } else if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src) && !src.startsWith('/')) {
          const resolved = resolve?.(src);
          if (resolved) {
            node.properties.src = resolved;
          } else if (ASSET_SRC.test(src)) {
            node.properties.src = MISSING_IMAGE_SRC;
            node.properties.className = ['asset-missing'];
            node.properties.title = 'This image is not available on this device';
          }
        }
      }
    }
    const children: ElementContent[] | Root['children'] = node.children;
    for (const child of children) {
      if (child.type === 'element') walk(child);
    }
  };
  walk(tree);
};

/* ── The processor ──────────────────────────────────────────────────── */

let processor: Processor | null = null;

function buildProcessor(): Processor {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    // $inline$ / $$block$$ math → data-math placeholders (see
    // rehypeMathPlaceholders); MarkdownPreview typesets them with MathLive.
    .use(remarkMath)
    // Money is not maths: `$5 and $10` goes back to being text.
    .use(remarkStrictMath)
    .use(remarkRehype, {
      // Ids are prefixed once, by the sanitiser — see rehypeLinkIds.
      clobberPrefix: '',
      handlers: { code: codeHandler },
    })
    .use(rehypeSanitize, SCHEMA)
    .use(rehypeLinkIds)
    .use(rehypeMathPlaceholders)
    .use(rehypeHighlight)
    .use(rehypeResolveImages)
    .use(rehypeStringify) as unknown as Processor;
}

/** Render a markdown document (or fragment) to sanitised HTML. */
export async function renderMarkdown(
  markdown: string,
  options: RenderOptions = {}
): Promise<string> {
  processor ??= buildProcessor();
  const file = await processor.process({
    value: markdown,
    data: { resolveImage: options.resolveImage, idPrefix: options.idPrefix },
  });
  return String(file);
}
