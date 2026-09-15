<script lang="ts">
  import { onMount } from 'svelte';
  import { href, isPath } from '../lib/paths';
  import { openPalette } from '../lib/ui/commands';

  let { currentPath = '/' }: { currentPath?: string } = $props();
  let open = $state(false);

  let online = $state(true);
  /** "⌘K" on Apple platforms, "Ctrl K" elsewhere (decided after mount; SSR renders Ctrl). */
  let mac = $state(false);

  onMount(() => {
    // Opportunistic background sync, throttled internally.
    import('../lib/sync').then(({ maybeAutoSync }) => maybeAutoSync());

    mac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
    online = navigator.onLine;
    const goOnline = () => (online = true);
    const goOffline = () => (online = false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  });

  // Everything else (the overview pages, creating things, recent items) is
  // one Ctrl/Cmd+K away in the command palette (D20).
  const links = [
    { path: '/', label: 'Home' },
    { path: '/preferences/', label: 'Preferences' },
    { path: '/settings/', label: 'Settings' },
  ];
</script>

<header class="navbar">
  <a class="brand" href={href('/')}>planee</a>

  {#if !online}
    <span class="offline-badge" title="You're offline — everything keeps working from this device">
      offline
    </span>
  {/if}

  <button
    type="button"
    class="palette-hint"
    data-testid="nav-palette"
    title="Command palette — search, create, go to any page"
    aria-label="Open command palette"
    onclick={() => {
      open = false;
      openPalette();
    }}
  >
    <span class="search-icon" aria-hidden="true">⌕</span>
    <span class="hint-label">Search</span>
    <kbd>{mac ? '⌘K' : 'Ctrl K'}</kbd>
  </button>

  <button
    class="hamburger"
    aria-expanded={open}
    aria-controls="site-nav"
    aria-label="Toggle navigation"
    onclick={() => (open = !open)}
  >
    <span class="bar"></span>
    <span class="bar"></span>
    <span class="bar"></span>
  </button>

  <nav id="site-nav" class:open>
    {#each links as link}
      <a
        href={href(link.path)}
        aria-current={isPath(currentPath, link.path) ? 'page' : undefined}
        onclick={() => (open = false)}
      >
        {link.label}
      </a>
    {/each}
  </nav>
</header>

<style>
  .navbar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    height: var(--navbar-height);
    padding-inline: var(--space-4);
    background: var(--surface-color);
    border-bottom: 1px solid var(--border-color);
  }

  .brand {
    font-weight: 800;
    font-size: var(--font-size-lg);
    text-decoration: none;
    color: var(--color-primary);
    letter-spacing: -0.02em;
  }


  .offline-badge {
    background: var(--color-warning);
    color: var(--bg-color);
    border-radius: var(--radius-full);
    padding: 0 var(--space-2);
    font-size: var(--font-size-sm);
    font-weight: 700;
  }

  nav {
    display: flex;
    gap: var(--space-2);
  }

  .palette-hint {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2) var(--space-1) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    background: var(--bg-color);
    color: var(--text-muted-color);
    font: inherit;
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .palette-hint:hover {
    color: var(--text-color);
    border-color: var(--color-primary);
  }

  .palette-hint kbd {
    font-size: 0.75rem;
  }

  .search-icon {
    font-size: 1.1em;
    line-height: 1;
  }

  nav a {
    text-decoration: none;
    color: var(--text-muted-color);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    font-weight: 600;
    font-size: var(--font-size-sm);
  }

  nav a:hover {
    color: var(--text-color);
  }

  nav a[aria-current='page'] {
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
  }

  .hamburger {
    display: none;
    flex-direction: column;
    justify-content: center;
    gap: 5px;
    width: 2.5rem;
    height: 2.5rem;
    background: none;
    border: none;
    cursor: pointer;
    padding: var(--space-2);
  }

  .bar {
    height: 2px;
    width: 100%;
    background: var(--text-color);
    border-radius: var(--radius-full);
    transition: transform 0.2s ease, opacity 0.2s ease;
  }

  @media (max-width: 40rem) {
    .hamburger {
      display: flex;
    }

    .hint-label,
    .palette-hint kbd {
      display: none;
    }

    .palette-hint {
      padding: var(--space-1) var(--space-3);
    }

    .hamburger[aria-expanded='true'] .bar:nth-child(1) {
      transform: translateY(7px) rotate(45deg);
    }

    .hamburger[aria-expanded='true'] .bar:nth-child(2) {
      opacity: 0;
    }

    .hamburger[aria-expanded='true'] .bar:nth-child(3) {
      transform: translateY(-7px) rotate(-45deg);
    }

    nav {
      display: none;
      position: absolute;
      top: var(--navbar-height);
      left: 0;
      right: 0;
      flex-direction: column;
      background: var(--surface-color);
      border-bottom: 1px solid var(--border-color);
      padding: var(--space-3);
      box-shadow: var(--shadow-2);
    }

    nav.open {
      display: flex;
    }

    nav a {
      padding: var(--space-3);
      font-size: var(--font-size-base);
    }
  }
</style>
