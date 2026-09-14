<script lang="ts">
  import Card from '../Card.svelte';
  import { setSyncMode, setSyncUrl, syncNow, testConnection } from '../../lib/sync';
  import { requestPersistentStorage } from '../../lib/db/persistence';
  import { href } from '../../lib/paths';

  const ONBOARDED_KEY = 'planee-onboarded';

  let choice: 'sync' | 'offline' | null = $state(null);
  let url = $state('');
  let testMessage: string | null = $state(null);
  let testOk = $state(false);
  let busy = $state(false);

  async function test() {
    busy = true;
    const result = await testConnection(url);
    testMessage = result.message;
    testOk = result.ok;
    busy = false;
  }

  async function finish(mode: 'sync' | 'offline') {
    busy = true;
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
      onclick={() => (choice = 'sync')}
    >
      <strong>Sync with a server</strong>
      <span class="muted">Back up and share data across devices.</span>
    </button>
    <button
      class="choice"
      class:selected={choice === 'offline'}
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
            placeholder="http://localhost:8228 (empty = same-origin)"
            bind:value={url}
          />
        </div>
        {#if testMessage}
          <p class={testOk ? 'ok' : 'err'}>{testMessage}</p>
        {/if}
        <div class="row">
          <button class="btn" onclick={test} disabled={busy}>Test connection</button>
          <button class="btn btn-primary" onclick={() => finish('sync')} disabled={busy}>
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
          <button class="btn btn-primary" onclick={() => finish('offline')} disabled={busy}>
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
</style>
