<script lang="ts">
  /**
   * Rendered markdown, the way a published page would show it: GFM, math,
   * dual-theme code highlighting, and mermaid fences drawn as diagrams.
   *
   * Usable on its own wherever you have a markdown string to display.
   * Re-renders are debounced so it can sit next to a keystroke source.
   *
   * Ported from retoken (af25bc6) src/components/MarkdownPreview.svelte.
   * Changes:
   *  - The output is sanitised (lib/markdown/render.ts).
   *  - The render pipeline, the asset store and mermaid are all imported
   *    lazily inside the render, so importing this component executes nothing
   *    heavy and touches no DOM.
   *  - Before each render, `preload(markdown)` (default: `preloadAssets`, the
   *    synced asset table) fills the cache the default `resolveImage`
   *    (`resolveAsset`) reads synchronously. Missing assets show a placeholder.
   *  - `data-rendered="true"` is set on the root once a render — mermaid
   *    diagrams included — has finished, and cleared the moment the input
   *    changes: tests can wait for `[data-rendered="true"]`.
   *  - Footnote ids are namespaced per instance, so two previews on one page
   *    don't jump into each other's notes.
   */
  import { tick } from 'svelte';
  import 'katex/dist/katex.min.css';

  let {
    markdown = '',
    /**
     * Maps a relative image src to something displayable. Defaults to the
     * synced asset table's resolver.
     */
    resolveImage = undefined,
    /**
     * Awaited before each render so `resolveImage` can answer synchronously.
     * Defaults to preloading `assets/<uuid>.<ext>` refs from the asset table.
     */
    preload = undefined,
    debounce = 250,
    /**
     * Bump to force a re-render when the markdown did not change but what it
     * points at did — an edited drawing re-saved under the same ref.
     */
    nonce = 0,
    class: className = '',
  }: {
    markdown?: string;
    resolveImage?: ((src: string) => string | undefined) | undefined;
    preload?: ((markdown: string) => Promise<void>) | undefined;
    debounce?: number;
    nonce?: number;
    class?: string;
  } = $props();

  /** Per-instance footnote id namespace. */
  const idPrefix = `p${Math.random().toString(36).slice(2, 8)}-`;

  let html = $state('');
  let rendered = $state(false);
  let container = $state<HTMLDivElement | undefined>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renderSeq = 0;
  let firstPaint = true;

  /**
   * Draw the `<pre class="mermaid">` blocks the pipeline left behind. Lazy —
   * the ~1 MB mermaid chunk loads only when there is a diagram. A broken one
   * reports itself in place, keeping its source visible.
   */
  async function renderMermaid(seq: number) {
    const nodes = container?.querySelectorAll<HTMLElement>('pre.mermaid');
    if (!nodes || nodes.length === 0) return;
    try {
      const { getMermaid, renderInto } = await import('../../lib/markdown/mermaid');
      // Bail if a newer render replaced the DOM while mermaid was loading.
      await getMermaid();
      if (seq !== renderSeq) return;
      await renderInto([...nodes]);
    } catch {
      // renderInto reports per-diagram failures in place; nothing to add.
    }
  }

  async function render(md: string) {
    const seq = ++renderSeq;
    try {
      const [{ renderMarkdown }, assets] = await Promise.all([
        import('../../lib/markdown/render'),
        import('../../lib/assets'),
      ]);
      await (preload ?? assets.preloadAssets)(md);
      if (seq !== renderSeq) return;
      const out = await renderMarkdown(md, {
        resolveImage: resolveImage ?? assets.resolveAsset,
        idPrefix,
      });
      if (seq !== renderSeq) return;
      html = out;
      await tick();
      await renderMermaid(seq);
    } catch (err) {
      if (seq !== renderSeq) return;
      console.error('Markdown preview failed to render', err);
    }
    if (seq === renderSeq) rendered = true;
  }

  $effect(() => {
    const md = markdown;
    nonce; // tracked: re-render when the bytes behind a stable ref change
    rendered = false;
    clearTimeout(timer);
    // First paint is immediate; later ones wait for typing to settle.
    const wait = firstPaint ? 0 : debounce;
    firstPaint = false;
    timer = setTimeout(() => void render(md), wait);
    return () => clearTimeout(timer);
  });
</script>

<div class="prose preview {className}" data-rendered={rendered ? 'true' : 'false'} bind:this={container}>
  <!-- Sanitised by lib/markdown/render.ts (rehype-sanitize, no raw HTML). -->
  {@html html}
</div>

<style>
  .preview {
    /* Fill the pane: .prose's reading measure is for published pages, not
       for a box that would leave the content floating. */
    max-width: none;
  }
</style>
