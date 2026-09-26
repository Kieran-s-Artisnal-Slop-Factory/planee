<script lang="ts">
  import { onMount } from 'svelte';
  import { getSingleton, putSingleton } from '../../lib/db/repo';
  import type { Preferences, SyncFields, TaskTypeKey } from '../../lib/db/types';
  import { DEFAULT_RECENT_ISSUES_COUNT, DEFAULT_SHOW_KEYBIND_SHEET, TASK_TYPE_VALUES } from '../../lib/db/types';
  import Card from '../Card.svelte';

  type Values = Omit<Preferences, keyof SyncFields>;

  /** Bounds for recent_issues_count in the form (the column itself is unbounded). */
  const RECENT_ISSUES_MIN = 0;
  const RECENT_ISSUES_MAX = 50;

  let loading = $state(true);
  let saved = $state(false);
  let formError: string | null = $state(null);
  let draft = $state(blankDraft());
  /**
   * The values as stored when the form loaded (or last saved), or null while
   * no live row exists. Save writes only the fields that differ from this, so
   * a field edited on another device meanwhile is not overwritten with this
   * form's stale copy of it.
   */
  let stored: Values | null = null;

  function blankDraft() {
    return {
      default_task_type: '',
      recent_issues_count: DEFAULT_RECENT_ISSUES_COUNT as number | null,
      show_keybind_sheet: DEFAULT_SHOW_KEYBIND_SHEET,
    };
  }

  async function load() {
    // undefined until the row is first saved — the form just shows defaults.
    const row = await getSingleton<Preferences>('preferences');
    if (!row) return;
    stored = {
      default_task_type: row.default_task_type,
      recent_issues_count: row.recent_issues_count ?? DEFAULT_RECENT_ISSUES_COUNT,
      show_keybind_sheet: row.show_keybind_sheet ?? DEFAULT_SHOW_KEYBIND_SHEET,
    };
    draft = {
      default_task_type: row.default_task_type ?? '',
      recent_issues_count: stored.recent_issues_count,
      show_keybind_sheet: stored.show_keybind_sheet,
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
    const count = draft.recent_issues_count;
    if (
      typeof count !== 'number' ||
      !Number.isInteger(count) ||
      count < RECENT_ISSUES_MIN ||
      count > RECENT_ISSUES_MAX
    ) {
      formError = `Recent issues on Home must be a whole number from ${RECENT_ISSUES_MIN} to ${RECENT_ISSUES_MAX}.`;
      return;
    }
    const values: Values = {
      default_task_type: draft.default_task_type as TaskTypeKey,
      recent_issues_count: count,
      show_keybind_sheet: draft.show_keybind_sheet,
    };
    // A first save (or reviving a deleted row) writes every field: the server
    // column default_task_type is NOT NULL, so a new row must carry it. After
    // that only the fields the user actually changed are written — and
    // re-stamped — so a concurrent edit to the other field on another device
    // survives the merge.
    const changes: Partial<Values> = stored
      ? (Object.fromEntries(
          (Object.keys(values) as (keyof Values)[])
            .filter((key) => values[key] !== stored![key])
            .map((key) => [key, values[key]])
        ) as Partial<Values>)
      : values;
    if (Object.keys(changes).length > 0) {
      // putSingleton upserts under the fixed id, keeps the existing row's sync
      // cursor, and revives a tombstone — never withSyncFields(), which would
      // mint a new UUID on every device.
      await putSingleton('preferences', changes);
    }
    stored = { ...(stored ?? values), ...changes };
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
      <div>
        <label for="f-recent_issues_count">Recent issues on Home</label>
        <input
          id="f-recent_issues_count"
          data-testid="preferences-recent-issues-count"
          type="number"
          min={RECENT_ISSUES_MIN}
          max={RECENT_ISSUES_MAX}
          step="1"
          required
          bind:value={draft.recent_issues_count}
        />
      </div>
      <div>
        <label class="check">
          <input
            type="checkbox"
            data-testid="preferences-show-keybind-sheet"
            bind:checked={draft.show_keybind_sheet}
          />
          Show the shortcut cheat sheet when holding Ctrl
        </label>
        <p class="hint check-hint">
          The key badges on buttons and cards show either way; this only hides the full list.
        </p>
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
  .form-error {
    color: var(--color-danger);
    font-size: var(--font-size-sm);
  }

  #f-recent_issues_count {
    max-width: 8rem;
  }

  .check-hint {
    margin: var(--space-1) 0 0;
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
