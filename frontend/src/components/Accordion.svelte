<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    summary,
    open = $bindable(false),
    children,
  }: {
    summary: string;
    open?: boolean;
    children: Snippet;
  } = $props();

  const contentId = `accordion-${Math.random().toString(36).slice(2, 9)}`;
</script>

<div class="accordion" class:open>
  <button
    type="button"
    class="summary"
    aria-expanded={open}
    aria-controls={contentId}
    onclick={() => (open = !open)}
  >
    <span>{summary}</span>
    <span class="chevron" aria-hidden="true">▾</span>
  </button>
  {#if open}
    <div class="content" id={contentId}>
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .accordion {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
  }

  .summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    width: 100%;
    background: none;
    border: none;
    padding: var(--space-3) var(--space-4);
    cursor: pointer;
    font-weight: 600;
    text-align: left;
  }

  .chevron {
    transition: transform 0.15s ease;
    color: var(--text-muted-color);
  }

  .open .chevron {
    transform: rotate(180deg);
  }

  .content {
    padding: var(--space-1) var(--space-4) var(--space-4);
  }
</style>
