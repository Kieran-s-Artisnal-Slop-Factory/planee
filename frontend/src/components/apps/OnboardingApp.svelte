<script lang="ts">
  import Card from '../Card.svelte';
  import { isOfflineDefaultBuild, setSyncMode, setSyncUrl, syncNow, testConnection } from '../../lib/sync';
  import { requestPersistentStorage } from '../../lib/db/persistence';
  import { href } from '../../lib/paths';

  const ONBOARDED_KEY = 'planee-onboarded';

  let choice: 'sync' | 'offline' | null = $state(null);
  let url = $state('');
  let testMessage: string | null = $state(null);
  let testOk = $state(false);
  let busy = $state(false);

  // A sub-path or offline-default build (GitHub Pages) has no sync server of
  // its own: same-origin there is a static host, so "empty = same-origin"
  // would save a sync target where every sync fails. Such a build needs a
  // server address; a backend-served build keeps empty = same-origin.
  const browserOnlyBuild = import.meta.env.BASE_URL !== '/' || isOfflineDefaultBuild();
  const SAME_ORIGIN = import.meta.env.BASE_URL.replace(/\/+$/, '');
  const urlMissing = $derived(browserOnlyBuild && url.trim() === '');
  // Browsers block fetches from an https page to an http server (mixed content),
  // so an http:// URL can never work from an https copy of the app.
  // (client:only component, so `location` always exists here.)
  const pageIsHttps = location.protocol === 'https:';
  const mixedContent = $derived(pageIsHttps && /^http:/i.test(url.trim()));

  async function test() {
    if (urlMissing) return;
    busy = true;
    const result = await testConnection(url.trim() || SAME_ORIGIN);
    testMessage = result.message;
    testOk = result.ok;
    busy = false;
  }

  async function finish(mode: 'sync' | 'offline') {
    if (mode === 'sync' && urlMissing) return;
    busy = true;
    // Always saved explicitly, both ways: an unset mode falls back to the
    // build default, which is not necessarily what was chosen here.
    setSyncMode(mode);
    if (mode === 'sync') {
      // Await so any cursor reset lands before the first sync runs.
      await setSyncUrl(url);
      void syncNow();
    }
    // Best-effort: keep IndexedDB out of the browser's eviction pool.
    await requestPersistentStorage();
    localStorage.setItem(ONBOARDED_KEY, '1');
    location.replace(href('/'));
  }
</script>

<div class="onboarding">
  <h1>Welcome to planee</h1>
  <p class="muted">
    Your data lives on this device and works fully offline. You can also sync it with a
    planee server — your own, on your network. Choose how to start (you can change this
    any time in Settings).
  </p>

  <div class="choices">
    <button
      class="choice"
      class:selected={choice === 'sync'}
      data-testid="onboarding-choose-sync"
      onclick={() => (choice = 'sync')}
    >
      <strong>Sync with a server</strong>
      <span class="muted">Back up and share data across devices.</span>
    </button>
    <button
      class="choice"
      class:selected={choice === 'offline'}
      data-testid="onboarding-choose-offline"
      onclick={() => (choice = 'offline')}
    >
      <strong>Offline only</strong>
      <span class="muted">Everything stays on this device.</span>
    </button>
  </div>

  {#if choice === 'sync'}
    <Card title="Server address">
      <div class="stack">
        <div>
          <label for="ob-url">Server URL</label>
          <input
            id="ob-url"
            data-testid="onboarding-url"
            placeholder={browserOnlyBuild ? 'https://planee.example.com' : 'http://localhost:8228 (empty = same-origin)'}
            bind:value={url}
            required={browserOnlyBuild}
            aria-describedby={[browserOnlyBuild ? 'ob-url-hint' : '', mixedContent ? 'ob-url-warning' : '']
              .filter(Boolean)
              .join(' ') || undefined}
          />
          {#if browserOnlyBuild}
            <p id="ob-url-hint" class="muted small">
              This copy of planee runs entirely in your browser and has no sync server of its own —
              enter the address of your planee server.
            </p>
          {/if}
          {#if mixedContent}
            <p id="ob-url-warning" class="warn" role="alert">
              This page is served over https, so browsers block requests to an <code>http://</code>
              server (mixed content). Use an <code>https://</code> server URL, or open planee from the
              backend itself.
            </p>
          {/if}
        </div>
        {#if testMessage}
          <p class={testOk ? 'ok' : 'err'}>{testMessage}</p>
        {/if}
        <div class="row">
          <button class="btn" onclick={test} disabled={busy || urlMissing}>Test connection</button>
          <button
            class="btn btn-primary"
            data-testid="onboarding-start-sync"
            onclick={() => finish('sync')}
            disabled={busy || urlMissing}
          >
            Start syncing
          </button>
        </div>
      </div>
    </Card>
  {:else if choice === 'offline'}
    <Card title="Offline only">
      <div class="stack">
        <p class="muted">
          Nothing ever leaves this browser. Remember to export backups — or enable sync later in
          Settings.
        </p>
        <div class="row">
          <button
            class="btn btn-primary"
            data-testid="onboarding-start-offline"
            onclick={() => finish('offline')}
            disabled={busy}
          >
            Continue offline
          </button>
        </div>
      </div>
    </Card>
  {/if}
</div>

<style>
  .onboarding {
    max-width: 34rem;
    margin-inline: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding-top: var(--space-6);
  }

  .choices {
    display: grid;
    gap: var(--space-3);
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  }

  .choice {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    text-align: left;
    padding: var(--space-4);
    background: var(--surface-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    cursor: pointer;
    font: inherit;
    color: var(--text-color);
  }

  .choice:hover {
    border-color: var(--color-primary);
  }

  .choice.selected {
    border-color: var(--color-primary);
    background: var(--color-primary-soft);
  }

  .ok {
    color: var(--color-success);
    font-size: var(--font-size-sm);
  }

  .err {
    color: var(--color-danger);
    font-size: var(--font-size-sm);
  }

  .row {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .muted {
    color: var(--text-muted-color);
  }

  .small {
    margin: var(--space-2) 0 0;
    font-size: var(--font-size-sm);
  }

  .warn {
    margin-top: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-left: 3px solid var(--color-warning);
    background: var(--color-warning-soft);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
  }
</style>
