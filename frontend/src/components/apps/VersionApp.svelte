<script lang="ts">
  import { onMount } from 'svelte';
  import { all, patch, put, softDelete, withSyncFields } from '../../lib/db/repo';
  import type { Version, SyncFields, Project, Task, VersionTask } from '../../lib/db/types';
  import Card from '../Card.svelte';

  let loading = $state(true);
  let rows: Version[] = $state([]);
  let projectOptions: Project[] = $state([]);
  let taskOptions: Task[] = $state([]);
  let version_taskRows: VersionTask[] = $state([]);
  let linked_version_task: string[] = $state([]);
  let newLink_version_task = $state('');
  let editingId: string | null = $state(null); // null = closed, '' = new row
  let formError: string | null = $state(null);
  let draft = $state(blankDraft());
  let inlineNew = $state({ project: '' });

  function blankDraft() {
    return {
    number: '',
    project: '',
    };
  }

  const projectLabel = (id: string | null) =>
    projectOptions.find((o) => o.id === id)?.description ?? id ?? '';
  const taskLabel = (id: string | null) =>
    taskOptions.find((o) => o.id === id)?.description ?? id ?? '';

  /** Create a project row in place and select it for project. */
  async function createForFk_project() {
    const label = inlineNew.project.trim();
    if (!label) return;
    const created = await put('project', withSyncFields({ description: label, version: '' }));
    projectOptions = await all<Project>('project');
    draft.project = created.id;
    inlineNew.project = '';
  }

  function toggleLink_version_task(targetId: string) {
    linked_version_task = linked_version_task.includes(targetId)
      ? linked_version_task.filter((id) => id !== targetId)
      : [...linked_version_task, targetId];
  }

  /** Create a task row in place and link it. */
  async function createLink_version_task() {
    const label = newLink_version_task.trim();
    if (!label) return;
    const created = await put('task', withSyncFields({ project: '', description: label, priority: 3, subtasks: null }));
    taskOptions = await all<Task>('task');
    linked_version_task = [...linked_version_task, created.id];
    newLink_version_task = '';
  }

  /** Make version_task rows match the checked task links. */
  async function syncLinks_version_task(ownerId: string) {
    // Re-read the links FRESH rather than diffing against the copy loaded on
    // mount: a sync (or another tab) may have added or removed links since,
    // and diffing a stale list re-creates rows someone deleted and deletes
    // rows someone added.
    const live = await all<VersionTask>('version_task');
    const current = live.filter((r) => r.version === ownerId);
    for (const targetId of linked_version_task) {
      if (!current.some((r) => r.task === targetId)) {
        await put('version_task', withSyncFields({ version: ownerId, task: targetId }));
      }
    }
    for (const r of current) {
      if (!linked_version_task.includes(r.task)) {
        await softDelete('version_task', r.id);
      }
    }
  }

  async function refresh() {
    rows = await all<Version>('version');
    projectOptions = await all<Project>('project');
    taskOptions = await all<Task>('task');
    version_taskRows = await all<VersionTask>('version_task');
  }

  onMount(async () => {
    await refresh();
    loading = false;
  });

  function startCreate() {
    draft = blankDraft();
    linked_version_task = [];
    formError = null;
    editingId = '';
  }

  function startEdit(row: Version) {
    draft = {
      number: row.number ?? '',
      project: row.project ?? '',
    };
    linked_version_task = version_taskRows
      .filter((r) => r.version === row.id)
      .map((r) => r.task);
    formError = null;
    editingId = row.id;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    formError = null;
    let values: Omit<Version, keyof SyncFields>;
    try {
      values = {
      number: draft.number,
      project: draft.project,
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
      const saved = await patch<Version>('version', editingId, values);
      if (!saved) {
        formError = 'That row was deleted somewhere else — nothing was saved.';
        await refresh();
        return;
      }
      savedId = editingId;
    } else {
      const created = await put('version', withSyncFields(values));
      savedId = created.id;
    }
    await syncLinks_version_task(savedId);
    editingId = null;
    await refresh();
  }

  async function del(row: Version) {
    if (!confirm('Delete this row?')) return;
    await softDelete('version', row.id);
    await refresh();
  }
</script>

<div class="page-header">
  <h1>Version</h1>
  <button class="btn btn-primary" data-testid="version-new" onclick={startCreate}>+ New</button>
</div>

{#if editingId !== null}
  <Card title={editingId ? 'Edit' : 'New version'}>
    <form class="stack" onsubmit={save}>
      <div>
        <label for="f-number">Number</label>
        <input id="f-number" bind:value={draft.number} required />
      </div>
      <div>
        <label for="f-project">Project</label>
        <select id="f-project" bind:value={draft.project} required>
          <option value="" disabled>Select…</option>
          {#each projectOptions as opt (opt.id)}
            <option value={opt.id}>{opt.description}</option>
          {/each}
        </select>
        <div class="inline-new">
          <input
            placeholder="New project description"
            bind:value={inlineNew.project}
          />
          <button
            type="button"
            class="btn btn-sm"
            onclick={() => createForFk_project()}
            disabled={!inlineNew.project.trim()}
          >
            + New
          </button>
        </div>
      </div>
      <div>
        <label>Task</label>
        {#if taskOptions.length === 0}
          <p class="muted">No task yet — create one below.</p>
        {/if}
        <div class="link-list">
          {#each taskOptions as opt (opt.id)}
            <label class="check link-item">
              <input
                type="checkbox"
                checked={linked_version_task.includes(opt.id)}
                onchange={() => toggleLink_version_task(opt.id)}
              />
              {opt.description}
            </label>
          {/each}
        </div>
        <div class="inline-new">
          <input placeholder="New task description" bind:value={newLink_version_task} />
          <button
            type="button"
            class="btn btn-sm"
            onclick={createLink_version_task}
            disabled={!newLink_version_task.trim()}
          >
            + Create & link
          </button>
        </div>
      </div>
      {#if formError}
        <p class="form-error">{formError}</p>
      {/if}
      <div class="row">
        <button class="btn btn-primary" data-testid="version-save" type="submit">Save</button>
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
          <th>Number</th>
          <th>Project</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr data-testid="version-row" data-row-id={row.id}>
            <td>{row.number ?? ''}</td>
            <td>{projectLabel(row.project)}</td>
            <td class="actions">
              <button class="btn btn-sm" data-testid="version-edit" onclick={() => startEdit(row)}>Edit</button>
              <button class="btn btn-sm btn-danger" data-testid="version-delete" onclick={() => del(row)}>Delete</button>
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
