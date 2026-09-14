<script lang="ts">
  import { onMount } from 'svelte';
  import { all, getSingleton, patch, put, softDelete, withSyncFields } from '../../lib/db/repo';
  import { DEFAULT_PRIORITY, DEFAULT_STATUS, DEFAULT_TASK_TYPE } from '../../lib/db/types';
  import type {
    VersionTask,
    SyncFields,
    Preferences,
    Project,
    StatusType,
    StatusTypeKey,
    Task,
    Version,
  } from '../../lib/db/types';
  import { changedFields, projectLabel as labelOfProject, taskLabel as labelOfTask } from '../../lib/crud';
  import Card from '../Card.svelte';

  type VersionTaskValues = Omit<VersionTask, keyof SyncFields>;

  let loading = $state(true);
  let rows: VersionTask[] = $state([]);
  let versionOptions: Version[] = $state([]);
  let taskOptions: Task[] = $state([]);
  let projectOptions: Project[] = $state([]);
  let statusOptions: StatusType[] = $state([]);

  let editingId: string | null = $state(null); // null = closed, '' = new row
  let editingOriginal: VersionTaskValues | null = null; // the row as it was when Edit was clicked
  let formError: string | null = $state(null);
  let draft = $state(blankDraft());
  let inlineNew = $state({ version: '', task: '' });

  function blankDraft() {
    return {
      version: '',
      task: '',
      status: DEFAULT_STATUS as string,
      position: 0 as number | null,
    };
  }

  const projectName = (id: string | undefined) =>
    labelOfProject(projectOptions.find((p) => p.id === id));
  const versionOptionLabel = (v: Version) => {
    const name = projectName(v.project);
    return name ? `${name} ${v.number}` : v.number;
  };
  const versionLabel = (id: string | null) => {
    const v = versionOptions.find((o) => o.id === id);
    return v ? versionOptionLabel(v) : (id ?? '');
  };
  const taskLabel = (id: string | null) =>
    labelOfTask(taskOptions.find((o) => o.id === id)) || (id ?? '');
  const statusLabel = (id: string) => statusOptions.find((o) => o.id === id)?.label ?? id;

  const selectedVersion = $derived(versionOptions.find((v) => v.id === draft.version));
  const selectedTask = $derived(taskOptions.find((t) => t.id === draft.task));

  /**
   * Create a version row in place and select it. A version needs a project;
   * the only one this form knows is the selected task's, so the button waits
   * for a task (never a version with project '').
   */
  async function createForFk_version() {
    const number = inlineNew.version.trim();
    const project = selectedTask?.project;
    if (!number || !project) return;
    const created = await put(
      'version',
      withSyncFields<Omit<Version, keyof SyncFields>>({ number, project, description: null, completed: false })
    );
    versionOptions = await all<Version>('version');
    draft.version = created.id;
    inlineNew.version = '';
  }

  /** Create a task row in place and select it — in the selected version's project, for the same reason. */
  async function createForFk_task() {
    const title = inlineNew.task.trim();
    const project = selectedVersion?.project;
    if (!title || !project) return;
    const prefs = await getSingleton<Preferences>('preferences');
    const created = await put(
      'task',
      withSyncFields<Omit<Task, keyof SyncFields>>({
        project,
        title,
        task_type: prefs?.default_task_type ?? DEFAULT_TASK_TYPE,
        description: null,
        priority: DEFAULT_PRIORITY,
        subtasks: null,
      })
    );
    taskOptions = await all<Task>('task');
    draft.task = created.id;
    inlineNew.task = '';
  }

  async function refresh() {
    rows = await all<VersionTask>('version_task');
    versionOptions = await all<Version>('version');
    taskOptions = await all<Task>('task');
    projectOptions = await all<Project>('project');
    statusOptions = (await all<StatusType>('status_type')).sort((a, b) => a.position - b.position);
  }

  onMount(async () => {
    await refresh();
    loading = false;
  });

  function startCreate() {
    draft = blankDraft();
    editingOriginal = null;
    formError = null;
    editingId = '';
  }

  function startEdit(row: VersionTask) {
    draft = {
      version: row.version ?? '',
      task: row.task ?? '',
      status: row.status ?? DEFAULT_STATUS,
      position: row.position ?? 0,
    };
    editingOriginal = {
      version: row.version,
      task: row.task,
      status: row.status,
      position: row.position,
    };
    formError = null;
    editingId = row.id;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    formError = null;
    // An emptied number input binds null; a position must be a real number.
    if (draft.position == null || !Number.isFinite(draft.position)) {
      formError = 'Position must be a number.';
      return;
    }
    const values: VersionTaskValues = {
      version: draft.version,
      task: draft.task,
      status: draft.status as StatusTypeKey,
      position: draft.position,
    };
    if (!values.version || !values.task) {
      formError = 'Pick a version and a task.';
      return;
    }
    if (editingId) {
      // patch() re-reads the row from the store and changes ONLY the fields
      // named — and only the fields the user changed are named, so a status
      // change here does not re-stamp position and beat a concurrent drag on
      // another device.
      const changes = editingOriginal ? changedFields(editingOriginal, values) : values;
      if (Object.keys(changes).length > 0) {
        const saved = await patch<VersionTask>('version_task', editingId, changes);
        if (!saved) {
          formError = 'That row was deleted somewhere else — nothing was saved.';
          await refresh();
          return;
        }
      }
    } else {
      await put('version_task', withSyncFields<VersionTaskValues>(values));
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
            <option value={opt.id}>{versionOptionLabel(opt)}</option>
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
            disabled={!inlineNew.version.trim() || !selectedTask}
            title={selectedTask ? undefined : "Select a task first (the version goes in that task's project)"}
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
            <option value={opt.id}>{labelOfTask(opt)}</option>
          {/each}
        </select>
        <div class="inline-new">
          <input
            placeholder="New task title"
            bind:value={inlineNew.task}
          />
          <button
            type="button"
            class="btn btn-sm"
            onclick={() => createForFk_task()}
            disabled={!inlineNew.task.trim() || !selectedVersion}
            title={selectedVersion ? undefined : "Select a version first (the task goes in that version's project)"}
          >
            + New
          </button>
        </div>
      </div>
      <div class="field-pair">
        <div>
          <label for="f-status">Status</label>
          <select id="f-status" bind:value={draft.status} required>
            {#each statusOptions as opt (opt.id)}
              <option value={opt.id}>{opt.label}</option>
            {/each}
            {#if draft.status && !statusOptions.some((o) => o.id === draft.status)}
              <option value={draft.status}>{draft.status}</option>
            {/if}
          </select>
        </div>
        <div>
          <label for="f-position">Position</label>
          <input id="f-position" type="number" step="any" bind:value={draft.position} required />
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
          <th>Status</th>
          <th>Position</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr data-testid="version_task-row" data-row-id={row.id}>
            <td>{versionLabel(row.version)}</td>
            <td>{taskLabel(row.task)}</td>
            <td>{statusLabel(row.status)}</td>
            <td class="mono">{row.position}</td>
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

  .field-pair {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--space-3);
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
</style>
