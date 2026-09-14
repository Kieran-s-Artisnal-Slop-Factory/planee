<script lang="ts">
  import { onMount } from 'svelte';
  import { all } from '../../lib/db/repo';
  import { href } from '../../lib/paths';
  import { getSyncStatus, type SyncStatus } from '../../lib/sync';

  let loading = $state(true);
  let projectCount = $state(0);
  let versionCount = $state(0);
  let taskCount = $state(0);
  let versionTaskCount = $state(0);
  let assetCount = $state(0);
  let preferencesCount = $state(0);
  let sync: SyncStatus = $state({ lastSyncAt: null, lastError: null, pending: 0 });

  onMount(async () => {
    projectCount = (await all('project')).length;
    versionCount = (await all('version')).length;
    taskCount = (await all('task')).length;
    versionTaskCount = (await all('version_task')).length;
    assetCount = (await all('asset')).length;
    preferencesCount = (await all('preferences')).length;
    sync = await getSyncStatus();
    loading = false;
  });
</script>

<section class="hero detailed-marquee">
  <div class="detailed-flare detailed-sunburst" aria-hidden="true"><svg viewBox="0 0 800 300" preserveAspectRatio="xMidYMax meet" fill="none" stroke="currentColor" stroke-width="1"><path d="M340 300L104 300M340 295L105 274M341 290L108 249M342 284L114 223M344 279L122 199M346 275L132 175M348 270L144 152M351 266L158 130M354 261L173 110M358 258L191 91M361 254L210 73M366 251L230 58M370 248L252 44M375 246L275 32M379 244L299 22M384 242L323 14M390 241L349 8M395 240L374 5M400 240L400 4M405 240L426 5M410 241L451 8M416 242L477 14M421 244L501 22M425 246L525 32M430 248L548 44M434 251L570 58M439 254L590 73M442 258L609 91M446 261L627 110M449 266L642 130M452 270L656 152M454 275L668 175M456 279L678 199M458 284L686 223M459 290L692 249M460 295L695 274M460 300L696 300"/><path d="M260 300A140 140 0 0 1 540 300M180 300A220 220 0 0 1 620 300M104 300A296 296 0 0 1 696 300" stroke-width="1.5"/></svg></div>
  <div class="stack">
    <p class="kicker">A retemplate template</p>
    <h1>Detailed</h1>
    <p>Brass on black. Cream by day, navy by night. Sunbursts, stepped corners and chevron rules, with Limelight over the door and Jost for the small print.</p>
    <div class="row">
      <a class="btn btn-primary btn-lg" href="../index.html">Get started</a>
      <a class="btn btn-lg detailed-outline" href="index.html">Browse the components</a>
    </div>
  </div>
</section>


<div class="page-header">
  <h1>planee</h1>
</div>

{#if loading}
  <p class="muted">Loading…</p>
{:else}
  <div class="tiles">
    <a class="tile" href={href('/project/')}>
      <span class="count">{projectCount}</span>
      <span class="label">Project</span>
    </a>
    <a class="tile" href={href('/version/')}>
      <span class="count">{versionCount}</span>
      <span class="label">Version</span>
    </a>
    <a class="tile" href={href('/task/')}>
      <span class="count">{taskCount}</span>
      <span class="label">Task</span>
    </a>
    <a class="tile" href={href('/version_task/')}>
      <span class="count">{versionTaskCount}</span>
      <span class="label">Version task</span>
    </a>
    <a class="tile" href={href('/asset/')}>
      <span class="count">{assetCount}</span>
      <span class="label">Assets</span>
    </a>
    <a class="tile" href={href('/preferences/')}>
      <span class="count">{preferencesCount}</span>
      <span class="label">Preferences</span>
    </a>
  </div>

  <p class="muted status">
    {#if sync.lastError}
      Last sync failed: {sync.lastError}
    {:else if sync.lastSyncAt}
      Last synced {new Date(sync.lastSyncAt).toLocaleString()}
    {:else}
      Never synced — configure a server in <a href={href('/settings/')}>Settings</a>, or keep working
      fully offline.
    {/if}
  </p>
{/if}

<style>
  .tiles {
    display: grid;
    gap: var(--space-4);
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  }

  .tile {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-4);
    background: var(--surface-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-1);
    text-decoration: none;
    color: var(--text-color);
  }

  .tile:hover {
    border-color: var(--color-primary);
  }

  .count {
    font-size: var(--font-size-2xl);
    font-weight: 800;
    color: var(--color-primary-strong);
  }

  .label {
    font-weight: 600;
    color: var(--text-muted-color);
  }

  .status {
    margin-top: var(--space-5);
    font-size: var(--font-size-sm);
  }
</style>
