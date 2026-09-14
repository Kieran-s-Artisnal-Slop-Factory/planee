<!-- Ported from retoken (af25bc6) -->
<script lang="ts" module>
  /**
   * Loaded on demand, and once per page: a dynamic import is what actually
   * keeps remark, rehype and shiki out of the bundle of a board that passes
   * `markdown={false}`. A static import would put them in whether or not they
   * ever run.
   */
  let previewModule: Promise<typeof import('../markdown/MarkdownPreview.svelte').default> | null =
    null;

  export const loadPreview = () =>
    (previewModule ??= import('../markdown/MarkdownPreview.svelte').then(
      (module) => module.default
    ));
</script>

<script lang="ts">
  /**
   * A card's description, rendered the one way. Both the card and the popped
   * out view show the same thing — clamped on the card, whole in the dialog —
   * so there is one place that decides what a description looks like.
   */
  let {
    text = '',
    markdown = true,
    resolveImage = undefined,
    nonce = 0,
    class: className = 'kb-md',
  }: {
    text?: string;
    /** `false` renders it as plain text, and never loads the pipeline. */
    markdown?: boolean;
    /** Handed to MarkdownPreview: maps an image `src` (e.g. `assets/…`) to a URL. */
    resolveImage?: ((src: string) => string | undefined) | undefined;
    /** Handed to MarkdownPreview: bump it to re-render, e.g. once images resolve. */
    nonce?: number;
    /** Class handed to MarkdownPreview's own element, for the size rules. */
    class?: string;
  } = $props();
</script>

{#if markdown}
  {#await loadPreview() then Preview}
    <Preview markdown={text} class={className} debounce={0} {resolveImage} {nonce} />
  {/await}
{:else}
  <p class="kb-plain">{text}</p>
{/if}

<style>
  .kb-plain {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }

  /* MarkdownPreview owns its element, so its own class is what can be reached
     from here — its 8rem minimum and reading measure are for a full-page
     preview, not for a card or a dialog. */
  :global(.kb-md.prose) {
    min-height: 0;
    max-width: none;
  }

  :global(.kb-md.prose > :first-child) {
    margin-top: 0;
  }

  :global(.kb-md.prose > :last-child) {
    margin-bottom: 0;
  }
</style>
