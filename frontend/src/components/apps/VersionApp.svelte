<script lang="ts">
  import { onMount } from 'svelte';
  import { all, get, getSingleton, patch, put, softDelete, withSyncFields } from '../../lib/db/repo';
  import { DEFAULT_PRIORITY, DEFAULT_STATUS, DEFAULT_TASK_TYPE } from '../../lib/db/types';
  import type { Version, SyncFields, Preferences, Project, Task, VersionTask } from '../../lib/db/types';
  import { changedFields, projectLabel as labelOfProject, taskLabel as labelOfTask } from '../../lib/crud';
  import Card from '../Card.svelte';
  import MarkdownField from '../markdown/MarkdownField.svelte';
  import MarkdownCell from '../markdown/MarkdownCell.svelte';

  type VersionValues = Omit<Version, keyof SyncFields>;

  let loading = $state(true);
  let rows: Version[] = $state([]);
  let projectOptions: Project[] = $state([]);
  let taskOptions: Task[] = $state([]);
  let version_taskRows: VersionTask[] = $state([]);
  let linked_version_task: string[] = $state([]);
  let newLink_version_task = $state('');
  let editingId: string | null = $state(null); // null = closed, '' = new row
  let editingOriginal: VersionValues | null = null; // the row as it was when Edit was clicked
  let formError: string | null = $state(null);
  let draft = $state(blankDraft());
  let inlineNew = $state({ project: '' });

  let formEl: HTMLFormElement | null = $state(null);
  /**
   * True while the description's MarkdownField is open in its editor. The
   * form's own Save is disabled meanwhile, so submitting can neither drop the
   * unsaved text (a new row) nor close the form over it (an existing row).
   * Read from the DOM: the field's Save button exists only while editing.
   */
  let markdownEditing = $state(false);
  $effect(() => {
    const form = formEl;
    if (!form) {
      markdownEditing = false;
      return;
    }
    const check = () => (markdownEditing = form.querySelector('[data-testid="version-description-save"]') !== null);
    const observer = new MutationObserver(check);
    observer.observe(form, { childList: true, subtree: true });
    check();
    return () => observer.disconnect();
  });

  function blankDraft() {
    return {
      number: '',
      project: '',
      description: '',
      completed: false,
    };
  }

  const projectLabel = (id: string | null) =>
    labelOfProject(projectOptions.find((o) => o.id === id)) || (id ?? '');

  /** Create a project row in place and select it for project. */
  async function createForFk_project() {
    const name = inlineNew.project.trim();
    if (!name) return;
    const created = await put('project', withSyncFields({ name, description: '' }));
    projectOptions = await all<Project>('project');
    draft.project = created.id;
    inlineNew.project = '';
  }

  function toggleLink_version_task(targetId: string) {
    linked_version_task = linked_version_task.includes(targetId)
      ? linked_version_task.filter((id) => id !== targetId)
      : [...linked_version_task, targetId];
  }

  /**
   * Create a task row in place and link it. The task belongs to the project
   * this version is for — never '' (an orphan row the server stores and every
   * device then carries) — so the button stays disabled until a project is
   * selected.
   */
  async function createLink_version_task() {
    const title = newLink_version_task.trim();
    if (!title || !draft.project) return;
    const prefs = await getSingleton<Preferences>('preferences');
    const created = await put(
      'task',
      withSyncFields<Omit<Task, keyof SyncFields>>({
        project: draft.project,
        title,
        task_type: prefs?.default_task_type ?? DEFAULT_TASK_TYPE,
        description: null,
        priority: DEFAULT_PRIORITY,
        subtasks: null,
      })
    );
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
        await put('version_task', withSyncFields({ version: ownerId, task: targetId, status: DEFAULT_STATUS, position: 0 }));
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
    editingOriginal = null;
    linked_version_task = [];
    formError = null;
    editingId = '';
  }

  function toValues(d: ReturnType<typeof blankDraft>): VersionValues {
    return {
      number: d.number.trim(),
      project: d.project,
      description: d.description === '' ? null : d.description,
      completed: d.completed,
    };
  }

  function startEdit(row: Version) {
    draft = {
      number: row.number ?? '',
      project: row.project ?? '',
      description: row.description ?? '',
      completed: row.completed === true,
    };
    // The row's REAL values (a null description stays null), so opening and
    // saving an untouched form patches nothing.
    editingOriginal = {
      number: row.number,
      project: row.project,
      description: row.description ?? null,
      completed: row.completed === true,
    };
    linked_version_task = version_taskRows
      .filter((r) => r.version === row.id)
      .map((r) => r.task);
    formError = null;
    editingId = row.id;
  }

  /** An existing row's description: its own Save patches just that field, straight away (D10). */
  async function saveDescription(md: string) {
    const id = editingId;
    if (!id) return;
    const description = md === '' ? null : md;
    const saved = await patch<Version>('version', id, { description });
    if (!saved) throw new Error('That row was deleted somewhere else — nothing was saved.');
    draft.description = md;
    if (editingOriginal) editingOriginal.description = description;
    await refresh();
  }

  /** The stored description right now, so a concurrent change is caught before it is overwritten. */
  async function freshDescription() {
    const row = editingId ? await get<Version>('version', editingId) : undefined;
    if (!row) throw new Error('That row was deleted somewhere else — nothing was saved.');
    return row.description ?? '';
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    formError = null;
    if (markdownEditing) {
      formError = 'Save or cancel the description first.';
      return;
    }
    const values = toValues(draft);
    if (!values.number || !values.project) {
      formError = 'A version needs a number and a project.';
      return;
    }
    let savedId: string;
    if (editingId) {
      // patch() re-reads the row from the store and changes ONLY the fields
      // named — and only the fields the user changed are named, so an
      // untouched field keeps its per-field stamp and a concurrent edit to it
      // on another device still wins.
      const changes: Partial<VersionValues> = editingOriginal ? changedFields(editingOriginal, values) : { ...values };
      // The description is not this button's: its MarkdownField saved it already.
      delete changes.description;
      if (Object.keys(changes).length > 0) {
        const saved = await patch<Version>('version', editingId, changes);
        if (!saved) {
          formError = 'That row was deleted somewhere else — nothing was saved.';
          await refresh();
          return;
        }
      }
      savedId = editingId;
    } else {
      const created = await put('version', withSyncFields<VersionValues>(values));
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
  {#key editingId}
  <Card title={editingId ? 'Edit' : 'New version'}>
    <form class="stack" onsubmit={save} bind:this={formEl}>
      <div>
        <label for="f-number">Number</label>
        <input id="f-number" bind:value={draft.number} placeholder="0.1.0" required />
      </div>
      <div>
        <label for="f-project">Project</label>
        <select id="f-project" bind:value={draft.project} required>
          <option value="" disabled>Select…</option>
          {#each projectOptions as opt (opt.id)}
            <option value={opt.id}>{labelOfProject(opt)}</option>
          {/each}
        </select>
        <div class="inline-new">
          <input
            placeholder="New project name"
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
      <div class="md-box">
        <MarkdownField
          label="Description"
          testid="version-description"
          value={draft.description}
          placeholder="No description yet."
          minHeight="8rem"
          onSave={editingId
            ? saveDescription
            : async (md) => {
                draft.description = md;
              }}
          getFresh={editingId ? freshDescription : undefined}
        />
        <p class="hint md-note">
          {editingId
            ? 'Saved on its own with its Save button.'
            : 'Kept with the new version and stored when you save it.'}
        </p>
      </div>
      <div>
        <label class="check">
          <input type="checkbox" data-testid="version-completed" bind:checked={draft.completed} />
          Completed
        </label>
      </div>
      <div>
        <label>Tasks</label>
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
              {labelOfTask(opt)}
            </label>
          {/each}
        </div>
        <div class="inline-new">
          <input placeholder="New task title" bind:value={newLink_version_task} />
          <button
            type="button"
            class="btn btn-sm"
            onclick={createLink_version_task}
            disabled={!newLink_version_task.trim() || !draft.project}
            title={draft.project ? undefined : 'Select a project first'}
          >
            + Create & link
          </button>
        </div>
      </div>
      {#if formError}
        <p class="form-error">{formError}</p>
      {/if}
      <div class="row">
        <button class="btn btn-primary" data-testid="version-save" type="submit" disabled={markdownEditing}>Save</button>
        <button class="btn" type="button" onclick={() => (editingId = null)}>Cancel</button>
        {#if markdownEditing}
          <span class="hint">Save or cancel the description first.</span>
        {/if}
      </div>
    </form>
  </Card>
  {/key}
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
          <th>Description</th>
          <th>Completed</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr data-testid="version-row" data-row-id={row.id}>
            <td>{row.number ?? ''}</td>
            <td>{projectLabel(row.project)}</td>
            <td><MarkdownCell markdown={row.description} testid="version-description-cell" /></td>
            <td>
              {#if row.completed}
                <span class="badge badge-done">Completed</span>
              {:else}
                <span class="badge">Open</span>
              {/if}
            </td>
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

  .md-box {
    padding: var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
  }

  .md-note {
    margin: var(--space-2) 0 0;
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
