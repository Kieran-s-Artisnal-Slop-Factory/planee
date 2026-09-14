<script lang="ts">
  import { onMount } from 'svelte';
  import { all, patch, put, softDelete, withSyncFields } from '../../lib/db/repo';
  import type { VersionTask, SyncFields, Version, Task } from '../../lib/db/types';
  import Card from '../Card.svelte';

  let loading = $state(true);
  let rows: VersionTask[] = $state([]);
  let versionOptions: Version[] = $state([]);
  let taskOptions: Task[] = $state([]);

  let editingId: string | null = $state(null); // null = closed, '' = new row
  let formError: string | null = $state(null);
  let draft = $state(blankDraft());
  let inlineNew = $state({ version: '', task: '' });

  function blankDraft() {
    return {
    version: '',
    task: '',
    };
  }

  const versionLabel = (id: string | null) =>
    versionOptions.find((o) => o.id === id)?.number ?? id ?? '';
  const taskLabel = (id: string | null) =>
    taskOptions.find((o) => o.id === id)?.description ?? id ?? '';

  /** Create a version row in place and select it for version. */
  async function createForFk_version() {
    const label = inlineNew.version.trim();
    if (!label) return;
    const created = await put('version', withSyncFields({ number: label, project: '' }));
    versionOptions = await all<Version>('version');
    draft.version = created.id;
    inlineNew.version = '';
  }

  /** Create a task row in place and select it for task. */
  async function createForFk_task() {
    const label = inlineNew.task.trim();
    if (!label) return;
    const created = await put('task', withSyncFields({ project: '', description: label, priority: 3, subtasks: null }));
    taskOptions = await all<Task>('task');
    draft.task = created.id;
    inlineNew.task = '';
  }


  async function refresh() {
    rows = await all<VersionTask>('version_task');
    versionOptions = await all<Version>('version');
    taskOptions = await all<Task>('task');

  }

  onMount(async () => {
    await refresh();
    loading = false;
  });

  function startCreate() {
    draft = blankDraft();

    formError = null;
    editingId = '';
  }

  function startEdit(row: VersionTask) {
    draft = {
      version: row.version ?? '',
      task: row.task ?? '',
    };

    formError = null;
    editingId = row.id;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    formError = null;
    let values: Omit<VersionTask, keyof SyncFields>;
    try {
      values = {
      version: draft.version,
      task: draft.task,
      };
    } catch (err) {
      formError = 'Invalid JSON: ' + (err instanceof Error ? err.message : String(err));
      return;
    }
    let savedId: string;
    if (editingId) {
      // patch() re-reads the row from the store and changes ONLY these fields.
      // Writing `{ ...rowFromTheList, ...values }` instead would push the
      // component's snapshot back over anything that changed underneath it —
      // an edit pulled from another device, a change made in another tab —
      // and that reversion then propagates as if it were deliberate.
      const saved = await patch<VersionTask>('version_task', editingId, values);
      if (!saved) {
        formError = 'That row was deleted somewhere else — nothing was saved.';
        await refresh();
        return;
      }
      savedId = editingId;
    } else {
      const created = await put('version_task', withSyncFields(values));
      savedId = created.id;
    }

    editingId = null;
    await refresh();
  }

  async function del(row: VersionTask) {
    if (!confirm('Delete this row?')) return;
    await softDelete('version_task', row.id);
    await refresh();
  }
</script>

<div class="page-header">
  <h1>Version task</h1>
  <button class="btn btn-primary" data-testid="version_task-new" onclick={startCreate}>+ New</button>
</div>

{#if editingId !== null}
  <Card title={editingId ? 'Edit' : 'New version task'}>
    <form class="stack" onsubmit={save}>
      <div>
        <label for="f-version">Version</label>
        <select id="f-version" bind:value={draft.version} required>
          <option value="" disabled>Select…</option>
          {#each versionOptions as opt (opt.id)}
            <option value={opt.id}>{opt.number}</option>
          {/each}
        </select>
        <div class="inline-new">
          <input
            placeholder="New version number"
            bind:value={inlineNew.version}
          />
          <button
            type="button"
            class="btn btn-sm"
            onclick={() => createForFk_version()}
            disabled={!inlineNew.version.trim()}
          >
            + New
          </button>
        </div>
      </div>
      <div>
        <label for="f-task">Task</label>
        <select id="f-task" bind:value={draft.task} required>
          <option value="" disabled>Select…</option>
          {#each taskOptions as opt (opt.id)}
            <option value={opt.id}>{opt.description}</option>
          {/each}
        </select>
        <div class="inline-new">
          <input
            placeholder="New task description"
            bind:value={inlineNew.task}
          />
          <button
            type="button"
            class="btn btn-sm"
            onclick={() => createForFk_task()}
            disabled={!inlineNew.task.trim()}
          >
            + New
          </button>
        </div>
      </div>

      {#if formError}
        <p class="form-error">{formError}</p>
      {/if}
      <div class="row">
        <button class="btn btn-primary" data-testid="version_task-save" type="submit">Save</button>
        <button class="btn" type="button" onclick={() => (editingId = null)}>Cancel</button>
      </div>
    </form>
  </Card>
{/if}

{#if loading}
  <p class="muted">Loading…</p>
{:else if rows.length === 0}
  <p class="muted">Nothing here yet.</p>
{:else}
  <div class="table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>Version</th>
          <th>Task</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr data-testid="version_task-row" data-row-id={row.id}>
            <td>{versionLabel(row.version)}</td>
            <td>{taskLabel(row.task)}</td>
            <td class="actions">
              <button class="btn btn-sm" data-testid="version_task-edit" onclick={() => startEdit(row)}>Edit</button>
              <button class="btn btn-sm btn-danger" data-testid="version_task-delete" onclick={() => del(row)}>Delete</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .actions {
    display: flex;
    gap: var(--space-1);
    justify-content: flex-end;
  }

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

  .link-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    padding: var(--space-2) 0;
  }

  .link-item {
    margin: 0;
  }
</style>
