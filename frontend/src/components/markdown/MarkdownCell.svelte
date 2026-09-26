<script lang="ts">
  /**
   * A read-only, height-clamped markdown preview for table cells (D7).
   *
   * The CRUD tables show description and subtasks fields rendered, but a long
   * document or a mermaid diagram must not blow a row up: the preview is
   * clipped to `maxHeight` (and to the cell's width), with a fade at the bottom
   * only when something was actually cut off. Empty markdown shows a muted
   * "—". Editing happens in the row's edit form, not here.
   */
  import MarkdownPreview from './MarkdownPreview.svelte';

  let {
    markdown,
    maxHeight = '6em',
    class: className = '',
    testid = undefined,
  }: {
    markdown: string | null | undefined;
    maxHeight?: string;
    class?: string;
    testid?: string;
  } = $props();

  const empty = $derived((markdown ?? '').trim() === '');

  let box = $state<HTMLDivElement | undefined>();
  let clipped = $state(false);

  // Re-measure whenever the rendered content changes: a render finishing
  // (async, and mermaid draws after it) shows up as a DOM mutation; images
  // loading or the column resizing show up as a size change.
  $effect(() => {
    const el = box;
    if (!el) return;
    const measure = () => (clipped = el.scrollHeight > el.clientHeight + 1);
    const resized = new ResizeObserver(measure);
    resized.observe(el);
    const inner = el.firstElementChild;
    if (inner) resized.observe(inner);
    const mutated = new MutationObserver(measure);
    mutated.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-rendered'] });
    measure();
    return () => {
      resized.disconnect();
      mutated.disconnect();
    };
  });
</script>

{#if empty}
  <span class="md-cell-empty" data-testid={testid}>—</span>
{:else}
  <div
    class="md-cell {className}"
    class:clipped
    style:max-height={maxHeight}
    data-testid={testid}
    bind:this={box}
    title={clipped ? 'Cut short. Edit the row to see all of it.' : undefined}
  >
    <MarkdownPreview markdown={markdown ?? ''} debounce={0} />
  </div>
{/if}

<style>
  .md-cell {
    position: relative;
    overflow: hidden;
    max-width: 40ch;
    min-width: 20ch;
  }

  .md-cell.clipped {
    -webkit-mask-image: linear-gradient(to bottom, #000 60%, transparent);
    mask-image: linear-gradient(to bottom, #000 60%, transparent);
  }

  .md-cell-empty {
    color: var(--text-muted-color);
  }

  /* Compact prose: a cell is not a page. */
  .md-cell :global(.prose) {
    font-size: inherit;
    line-height: 1.4;
  }

  .md-cell :global(.prose > * + *) {
    margin-top: var(--space-1);
  }

  .md-cell :global(:is(h1, h2, h3, h4, h5, h6)) {
    margin: 0;
    padding: 0;
    border: 0;
    font-size: 1em;
    font-weight: 600;
  }

  .md-cell :global(:is(p, ul, ol, pre, blockquote, table)) {
    margin-block: 0;
  }

  .md-cell :global(:is(img, svg, pre, table)) {
    max-width: 100%;
  }

  .md-cell :global(pre) {
    overflow: hidden;
  }
</style>
