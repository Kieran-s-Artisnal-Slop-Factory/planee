<script lang="ts">
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import {
    clearAllData,
    downloadExport,
    importData,
    type ExportEnvelope,
    type ImportMode,
  } from '../../lib/db/export';
  import {
    getSyncMode,
    getSyncStatus,
    getSyncUrl,
    isOfflineDefaultBuild,
    setSyncMode,
    setSyncUrl,
    syncNow,
    testConnection,
    type SyncResult,
    type SyncStatus,
  } from '../../lib/sync';
  import { requestPersistentStorage, type PersistState } from '../../lib/db/persistence';
  import { href } from '../../lib/paths';

  // retoken's scheme model (see Layout.astro): the key is shared with any
  // retoken or retemplate site on this origin on purpose.
  const THEME_KEY = 'retoken-scheme';

  let message: string | null = $state(null);
  let messageOk = $state(true);
  let busy = $state(false);
  let theme = $state('auto');
  let persistState: PersistState | null = $state(null);
  let url = $state('');
  let status: SyncStatus = $state({ lastSyncAt: null, lastError: null, pending: 0 });
  let mode: 'offline' | 'sync' = $state('sync');

  // A sub-path or offline-default build (GitHub Pages) has no sync server of
  // its own: same-origin there is a static host.
  const browserOnlyBuild = import.meta.env.BASE_URL !== '/' || isOfflineDefaultBuild();
  // Browsers block fetches from an https page to an http server (mixed content),
  // so an http:// URL can never work from an https copy of the app.
  // (client:only component, so `location` always exists here.)
  const pageIsHttps = location.protocol === 'https:';
  let mixedContent = $derived(pageIsHttps && /^http:/i.test(url.trim()));

  // With no URL saved, getSyncUrl() returns the same-origin base ('' at the
  // root, '/planee' under a sub-path). Show that as an empty field so it
  // matches the "empty = same-origin" placeholder instead of a bare path.
  const SAME_ORIGIN = import.meta.env.BASE_URL.replace(/\/+$/, '');
  function displayedSyncUrl(): string {
    const current = getSyncUrl();
    return current === SAME_ORIGIN ? '' : current;
  }

  onMount(async () => {
    theme = localStorage.getItem(THEME_KEY) ?? 'auto';
    inDeveloperMode = sessionStorage.getItem(DEV_MODE_KEY) === '1';
    url = displayedSyncUrl();
    status = await getSyncStatus();
    mode = getSyncMode();
  });

  function pickMode(value: 'offline' | 'sync') {
    mode = value;
    setSyncMode(value);
    message =
      value === 'offline'
        ? 'Background sync disabled — everything stays on this device.'
        : 'Sync enabled — runs on page load and every 15 minutes.';
    messageOk = true;
  }

  async function saveUrl() {
    // Awaited: setSyncUrl resets the sync cursors when the server changes, and
    // that must complete before any subsequent "Sync now".
    await setSyncUrl(url);
    url = displayedSyncUrl();
    message = 'Server URL saved. Empty means same-origin (backend serves this app).';
    if (mode === 'offline' && url) {
      message += ' Sync is still off — choose "Sync enabled" to start syncing with it.';
    }
    messageOk = true;
  }

  async function test() {
    busy = true;
    const result = await testConnection(url.trim() || SAME_ORIGIN);
    message = result.message;
    messageOk = result.ok;
    busy = false;
  }

  async function doSync() {
    busy = true;
    const result: SyncResult = await syncNow();
    if (result.ok) {
      // Conflicts and rejections are reported, never swallowed: a sync that
      // says "OK" while the server refused rows is how data loss stays quiet.
      let detail = 'Synced — pushed ' + result.pushed + ', pulled ' + result.pulled + '.';
      if (result.conflicts > 0) {
        detail += ' ' + result.conflicts + ' row(s) were newer elsewhere and were adopted.';
      }
      if (result.rejected > 0) {
        detail += ' ' + result.rejected + ' row(s) were rejected by the server — see the console.';
      }
      message = detail;
    } else {
      message = result.error ?? 'Sync failed.';
    }
    messageOk = result.ok && result.rejected === 0;
    status = await getSyncStatus();
    busy = false;
  }

  function setTheme(value: string) {
    theme = value;
    if (value === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, value);
    const root = document.documentElement;
    root.style.colorScheme = value === 'auto' ? '' : value;
    root.dataset.scheme =
      value === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : value;
  }

  async function persist() {
    persistState = await requestPersistentStorage();
  }

  // ---- backup
  let importInput: HTMLInputElement | undefined = $state();

  let importMode: ImportMode = $state('replace');

  async function onImportFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    const warning =
      importMode === 'replace'
        ? 'Restore REPLACES the data on this device with the backup. Continue?'
        : 'Merge folds the backup into your current data, keeping whichever copy of each row is newer. Continue?';
    if (!confirm(warning)) return;
    busy = true;
    try {
      const envelope = JSON.parse(await file.text()) as ExportEnvelope;
      const result = await importData(envelope, importMode);
      message =
        'Import complete: ' + result.rows + ' rows loaded' +
        (result.skipped > 0 ? ', ' + result.skipped + ' skipped (local copy newer)' : '') +
        '. Reloading…';
      messageOk = true;
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      // Import validates the whole file before writing anything, so a failure
      // here means nothing was changed.
      message = 'Import failed (nothing was changed): ' + (err instanceof Error ? err.message : String(err));
      messageOk = false;
    }
    busy = false;
  }

  // ---- developer options, gated behind typing the exact phrase once per
  // browser session (sessionStorage, so it resets across sessions)
  const DEV_MODE_KEY = 'planee-inDeveloperMode';
  const DEV_PHRASE = 'I understand I can lose and corrupt my data by using these settings';
  let inDeveloperMode = $state(false);
  let showDevModal = $state(false);
  let devPhraseInput = $state('');

  function unlockDeveloperMode(e: SubmitEvent) {
    e.preventDefault();
    if (devPhraseInput.trim() !== DEV_PHRASE) return;
    sessionStorage.setItem(DEV_MODE_KEY, '1');
    inDeveloperMode = true;
    showDevModal = false;
    devPhraseInput = '';
  }

  async function clearData() {
    if (!confirm('Delete ALL local data? This cannot be undone — export a backup first if in doubt.')) {
      return;
    }
    await clearAllData();
    localStorage.removeItem('planee-onboarded');
    location.href = href('/onboarding/');
  }
</script>

<div class="page-header">
  <h1>Settings</h1>
</div>

{#if message}
  <p class={messageOk ? 'ok' : 'err'}>{message}</p>
{/if}

<div class="stack">
  <Card title="Sync server">
    <div class="stack">
      {#if browserOnlyBuild}
        <p class="muted small">
          This copy of planee runs entirely in your browser. Data stays on this device until you
          set a sync server below.
        </p>
      {/if}
      <div class="row">
        <button
          class="btn"
          class:btn-primary={mode === 'sync'}
          onclick={() => pickMode('sync')}
        >
          Sync enabled
        </button>
        <button
          class="btn"
          class:btn-primary={mode === 'offline'}
          onclick={() => pickMode('offline')}
        >
          Offline only
        </button>
      </div>
      <div>
        <label for="sync-url">Server URL</label>
        <input
          id="sync-url"
          placeholder="http://localhost:8228 (empty = same-origin)"
          bind:value={url}
          aria-describedby={mixedContent ? 'sync-url-warning' : undefined}
        />
        {#if mixedContent}
          <p id="sync-url-warning" class="warn" role="alert">
            This page is served over https, so browsers block requests to an <code>http://</code>
            server (mixed content). Use an <code>https://</code> server URL, or open planee from the
            backend itself.
          </p>
        {/if}
      </div>
      <div class="row">
        <button class="btn btn-primary" onclick={saveUrl} disabled={busy}>Save</button>
        <button class="btn" onclick={test} disabled={busy}>Test connection</button>
        <button class="btn" onclick={doSync} disabled={busy}>Sync now</button>
      </div>
      <p class="muted small">
        {#if status.lastError}
          Last sync failed: {status.lastError}
        {:else if status.lastSyncAt}
          Last synced {new Date(status.lastSyncAt).toLocaleString()}
        {:else}
          Never synced.
        {/if}
        {#if status.pending > 0}
          <br />{status.pending} change{status.pending === 1 ? '' : 's'} waiting to be sent.
        {/if}
      </p>
    </div>
  </Card>

  <Card title="Appearance">
    <div class="row">
      {#each ['auto', 'light', 'dark'] as value}
        <button
          class="btn"
          class:btn-primary={theme === value}
          onclick={() => setTheme(value)}
        >
          {value}
        </button>
      {/each}
    </div>
  </Card>

  <Card title="Storage">
    <div class="stack">
      <p class="muted small">
        Data lives in this browser's IndexedDB. Ask the browser to protect it from eviction, and
        use the backend's <code>/backup</code> endpoint for server-side backups.
      </p>
      <div class="row">
        <button class="btn" onclick={persist}>Request persistent storage</button>
        {#if persistState}
          <span class={persistState === 'granted' ? 'ok' : 'err'}>{persistState}</span>
        {/if}
      </div>
    </div>
  </Card>

  <Card title="Backup">
    <div class="stack">
      <p class="muted small">
        Download every table (deleted rows included) as one JSON file, or load a previous backup.
        <strong>Restore</strong> replaces this device's data with the file;
        <strong>Merge</strong> folds the file in, keeping whichever copy of each row is newer.
      </p>
      <div class="row">
        {#each [['replace', 'Restore'], ['merge', 'Merge']] as [value, label]}
          <button
            class="btn"
            class:btn-primary={importMode === value}
            onclick={() => (importMode = value as ImportMode)}
          >
            {label}
          </button>
        {/each}
      </div>
      <div class="row">
        <button class="btn" onclick={() => downloadExport()} disabled={busy}>Export JSON</button>
        <button class="btn" onclick={() => importInput?.click()} disabled={busy}>Import JSON</button>
        <input
          bind:this={importInput}
          type="file"
          accept="application/json,.json"
          style="display: none"
          onchange={onImportFile}
        />
      </div>
    </div>
  </Card>

  <Card title="Developer">
    {#if !inDeveloperMode}
      <div class="stack">
        <p class="muted small">
          Developer options can corrupt or destroy your data and are locked by default.
        </p>
        <div class="row">
          <button class="btn" onclick={() => (showDevModal = true)}>Unlock developer options</button>
        </div>
      </div>
    {:else}
      <div class="stack">
        <p class="muted small">Wipe everything on this device (the server keeps its copy).</p>
        <div class="row">
          <button class="btn btn-danger" onclick={clearData}>Clear all data</button>
        </div>
      </div>
    {/if}
  </Card>
</div>

{#if showDevModal}
  <div
    class="modal-backdrop"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && (showDevModal = false)}
  >
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dev-modal-title">
      <h3 id="dev-modal-title">Unlock developer options</h3>
      <p class="muted small">Type the following phrase exactly to continue:</p>
      <p class="phrase">{DEV_PHRASE}</p>
      <form onsubmit={unlockDeveloperMode}>
        <input bind:value={devPhraseInput} placeholder="Type the phrase…" />
        <div class="row modal-actions">
          <button class="btn" type="button" onclick={() => (showDevModal = false)}>Cancel</button>
          <button class="btn btn-primary" type="submit" disabled={devPhraseInput.trim() !== DEV_PHRASE}>
            Unlock
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .ok {
    color: var(--color-success);
    font-size: var(--font-size-sm);
  }

  .err {
    color: var(--color-danger);
    font-size: var(--font-size-sm);
  }

  .small {
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

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.5);
    display: grid;
    place-items: center;
    z-index: 50;
    padding: var(--space-4);
  }

  .modal {
    background: var(--surface-raised-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-2);
    padding: var(--space-4);
    max-width: 28rem;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .phrase {
    font-family: ui-monospace, monospace;
    font-size: var(--font-size-sm);
    background: var(--color-primary-soft);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    user-select: all;
  }

  .modal form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .modal-actions {
    justify-content: flex-end;
  }
</style>
