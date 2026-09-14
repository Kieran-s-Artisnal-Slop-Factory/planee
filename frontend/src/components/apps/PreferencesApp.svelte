<script lang="ts">
  import { onMount } from 'svelte';
  import { getSingleton, putSingleton } from '../../lib/db/repo';
  import type { Preferences, SyncFields, TaskTypeKey } from '../../lib/db/types';
  import { TASK_TYPE_VALUES } from '../../lib/db/types';
  import Card from '../Card.svelte';

  let loading = $state(true);
  let saved = $state(false);
  let formError: string | null = $state(null);
  let draft = $state(blankDraft());



  function blankDraft() {
    return {
    default_task_type: '',
    };
  }


  async function load() {

    // undefined until the row is first saved — the form just shows defaults.
    const row = await getSingleton<Preferences>('preferences');
    if (!row) return;
    draft = {
      default_task_type: row.default_task_type ?? '',
    };
  }

  onMount(async () => {
    await load();
    loading = false;
  });

  async function save(e: SubmitEvent) {
    e.preventDefault();
    formError = null;
    saved = false;
    let values: Omit<Preferences, keyof SyncFields>;
    try {
      values = {
      default_task_type: (draft.default_task_type as TaskTypeKey),
      };
    } catch (err) {
      formError = 'Invalid JSON: ' + (err instanceof Error ? err.message : String(err));
      return;
    }
    // putSingleton upserts under the fixed id, keeps the existing row's sync
    // cursor, and revives a tombstone — never withSyncFields(), which would
    // mint a new UUID on every device.
    await putSingleton('preferences', values);
    saved = true;
  }
</script>

<div class="page-header">
  <h1>Preferences</h1>
</div>

{#if loading}
  <p class="muted">Loading…</p>
{:else}
  <Card title="Preferences">
    <form class="stack" onsubmit={save} data-testid="preferences-form">
      <div>
        <label for="f-default_task_type">Default task type</label>
        <select id="f-default_task_type" bind:value={draft.default_task_type} required>
          <option value="" disabled>Select…</option>
          {#each TASK_TYPE_VALUES as opt (opt.key)}
            <option value={opt.key}>{opt.label}</option>
          {/each}
        </select>
      </div>
      {#if formError}
        <p class="form-error">{formError}</p>
      {/if}
      <div class="row">
        <button class="btn btn-primary" data-testid="preferences-save" type="submit">Save</button>
        {#if saved}
          <span class="muted saved" data-testid="preferences-saved">Saved</span>
        {/if}
      </div>
    </form>
  </Card>

  <p class="muted note">
    One row for the whole app. It is stored under a fixed id, so every device
    converges on the same preferences instead of each keeping its own copy.
  </p>
{/if}

<style>
  .mono {
    font-family: ui-monospace, monospace;
    font-size: var(--font-size-sm);
  }

  .form-error {
    color: var(--color-danger);
    font-size: var(--font-size-sm);
  }

  .inline-new {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .inline-new input {
    max-width: 16rem;
  }

  .saved {
    align-self: center;
    font-size: var(--font-size-sm);
  }

  .note {
    margin-top: var(--space-3);
    font-size: var(--font-size-sm);
  }
</style>
