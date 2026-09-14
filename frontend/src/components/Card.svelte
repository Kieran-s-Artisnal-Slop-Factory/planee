<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title = '',
    children,
    actions,
  }: {
    title?: string;
    children: Snippet;
    actions?: Snippet;
  } = $props();
</script>

<section class="card">
  {#if title || actions}
    <header>
      {#if title}<h3>{title}</h3>{/if}
      {#if actions}<div class="actions">{@render actions()}</div>{/if}
    </header>
  {/if}
  <div class="body">
    {@render children()}
  </div>
</section>

<style>
  .card {
    background: var(--surface-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-1);
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-color);
  }

  h3 {
    font-size: var(--font-size-base);
    font-weight: 700;
  }

  .actions {
    display: flex;
    gap: var(--space-2);
  }

  .body {
    padding: var(--space-4);
  }
</style>
