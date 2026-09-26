<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { all, get, getSingleton, patch, put, softDelete, withSyncFields } from '../../lib/db/repo';
  import { onChanged } from '../../lib/db/changes';
  import { recordView } from '../../lib/ui/recent';
  import { DEFAULT_PRIORITY, DEFAULT_STATUS, DEFAULT_TASK_TYPE, PRIORITY_VALUES } from '../../lib/db/types';
  import type {
    Task,
    SyncFields,
    Preferences,
    Project,
    TaskType,
    TaskTypeKey,
    Version,
    VersionTask,
  } from '../../lib/db/types';
  import { changedFields, priorityLabel, projectLabel as labelOfProject } from '../../lib/crud';
  import Card from '../Card.svelte';
  import MarkdownField from '../markdown/MarkdownField.svelte';
  import MarkdownCell from '../markdown/MarkdownCell.svelte';
  import TaskCreateForm from '../forms/TaskCreateForm.svelte';

  type TaskValues = Omit<Task, keyof SyncFields>;

  let loading = $state(true);
  let rows: Task[] = $state([]);
  let projectOptions: Project[] = $state([]);
  let taskTypeOptions: TaskType[] = $state([]);
  let versionOptions: Version[] = $state([]);
  let version_taskRows: VersionTask[] = $state([]);
  let linked_version_task: string[] = $state([]);
  let newLink_version_task = $state('');
  /** The "+ New" form (TaskCreateForm) is open. */
  let creating = $state(false);
  /** A notice shown above the table (e.g. `?edit=` pointed at a deleted task). */
  let notice: string | null = $state(null);
  let editingId: string | null = $state(null); // null = closed, else the task being edited
  let editingOriginal: TaskValues | null = null; // the row as it was when Edit was clicked
  let formError: string | null = $state(null);
  /** preferences.default_task_type, read on mount; the schema default until one is saved. */
  let defaultTaskType: TaskTypeKey = $state(DEFAULT_TASK_TYPE);
  let draft = $state(blankDraft());
  let inlineNew = $state({ project: '' });

  let formEl: HTMLFormElement | null = $state(null);
  /**
   * True while the description or subtasks MarkdownField is open in its
   * editor. The form's own Save is disabled meanwhile, so submitting can
   * neither drop the unsaved text (a new row) nor close the form over it (an
   * existing row). Read from the DOM: a field's Save button exists only while
   * editing.
   */
  let markdownEditing = $state(false);
  $effect(() => {
    const form = formEl;
    if (!form) {
      markdownEditing = false;
      return;
    }
    const check = () =>
      (markdownEditing =
        form.querySelector('[data-testid="task-description-save"], [data-testid="task-subtasks-save"]') !== null);
    const observer = new MutationObserver(check);
    observer.observe(form, { childList: true, subtree: true });
    check();
    return () => observer.disconnect();
  });

  function blankDraft() {
    return {
      title: '',
      project: '',
      task_type: defaultTaskType as string,
      priority: DEFAULT_PRIORITY as number,
      description: '',
      subtasks: '',
    };
  }

  const projectLabel = (id: string | null) =>
    labelOfProject(projectOptions.find((o) => o.id === id)) || (id ?? '');
  const taskTypeLabel = (id: string) => taskTypeOptions.find((o) => o.id === id)?.label ?? id;
  const versionLabel = (v: Version) => {
    const project = projectOptions.find((p) => p.id === v.project);
    return project ? `${labelOfProject(project)} ${v.number}` : v.number;
  };
  /** Versions of the selected project first; a task can only sensibly be scheduled in its own project's versions. */
  const versionsForDraft = $derived(
    draft.project ? versionOptions.filter((v) => v.project === draft.project || linked_version_task.includes(v.id)) : versionOptions
  );

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
   * Create a version row in place and link it. The version belongs to the
   * task's project: creating it with project '' made an orphan row that the
   * server stored and every device then carried (finding 7), so the button is
   * disabled until a project is selected.
   */
  async function createLink_version_task() {
    const number = newLink_version_task.trim();
    if (!number || !draft.project) return;
    const created = await put(
      'version',
      withSyncFields<Omit<Version, keyof SyncFields>>({
        number,
        project: draft.project,
        description: null,
        completed: false,
      })
    );
    versionOptions = await all<Version>('version');
    linked_version_task = [...linked_version_task, created.id];
    newLink_version_task = '';
  }

  /** Make version_task rows match the checked version links. */
  async function syncLinks_version_task(ownerId: string) {
    // Re-read the links FRESH rather than diffing against the copy loaded on
    // mount: a sync (or another tab) may have added or removed links since,
    // and diffing a stale list re-creates rows someone deleted and deletes
    // rows someone added.
    const live = await all<VersionTask>('version_task');
    const current = live.filter((r) => r.task === ownerId);
    for (const targetId of linked_version_task) {
      if (!current.some((r) => r.version === targetId)) {
        await put('version_task', withSyncFields({ version: targetId, task: ownerId, status: DEFAULT_STATUS, position: 0 }));
      }
    }
    for (const r of current) {
      if (!linked_version_task.includes(r.version)) {
        await softDelete('version_task', r.id);
      }
    }
  }

  async function refresh() {
    rows = await all<Task>('task');
    projectOptions = await all<Project>('project');
    taskTypeOptions = (await all<TaskType>('task_type')).sort((a, b) => a.position - b.position);
    versionOptions = await all<Version>('version');
    version_taskRows = await all<VersionTask>('version_task');
    const prefs = await getSingleton<Preferences>('preferences');
    defaultTaskType = prefs?.default_task_type ?? DEFAULT_TASK_TYPE;
  }

  onMount(() => {
    // Live: rows created elsewhere (the FAB, another tab, a sync) show up here.
    // refresh only reads, so it never touches an open edit form's draft.
    const stop = onChanged(['task', 'project', 'version', 'version_task', 'preferences'], () => void refresh());
    void (async () => {
      await refresh();
      loading = false;
      // /task/?edit=<id> opens that task's edit form (links.ts taskEditHref).
      const editId = new URLSearchParams(location.search).get('edit');
      if (editId) {
        const row = rows.find((r) => r.id === editId);
        if (row) {
          startEdit(row);
          await tick();
          formEl?.scrollIntoView({ block: 'start', behavior: 'smooth' });
          formEl?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
        } else {
          notice = 'That task no longer exists.';
        }
      }
    })();
    return stop;
  });

  function startCreate() {
    editingId = null;
    creating = true;
  }

  function toValues(d: ReturnType<typeof blankDraft>): TaskValues {
    return {
      project: d.project,
      title: d.title.trim(),
      task_type: d.task_type as TaskTypeKey,
      description: d.description === '' ? null : d.description,
      priority: d.priority,
      subtasks: d.subtasks === '' ? null : d.subtasks,
    };
  }

  function startEdit(row: Task) {
    draft = {
      title: row.title ?? '',
      project: row.project ?? '',
      task_type: row.task_type ?? defaultTaskType,
      priority: row.priority ?? DEFAULT_PRIORITY,
      description: row.description ?? '',
      subtasks: row.subtasks ?? '',
    };
    // The row's REAL values (null stays null), so opening and saving an
    // untouched form patches nothing.
    editingOriginal = {
      project: row.project,
      title: row.title,
      task_type: row.task_type,
      description: row.description ?? null,
      priority: row.priority,
      subtasks: row.subtasks ?? null,
    };
    linked_version_task = version_taskRows
      .filter((r) => r.task === row.id)
      .map((r) => r.version);
    formError = null;
    creating = false;
    editingId = row.id;
    recordView('task', row.id);
  }

  type MarkdownKey = 'description' | 'subtasks';

  /**
   * Save handler for an existing task's markdown field: its own Save patches
   * just that field, straight away (D10). (New tasks: TaskCreateForm.)
   */
  function markdownSaver(field: MarkdownKey) {
    return async (md: string) => {
      const id = editingId;
      if (!id) return;
      const stored = md === '' ? null : md;
      const saved = await patch<Task>('task', id, { [field]: stored });
      if (!saved) throw new Error('That row was deleted somewhere else — nothing was saved.');
      draft[field] = md;
      if (editingOriginal) editingOriginal[field] = stored;
      await refresh();
    };
  }

  /** The stored value right now, so a concurrent change is caught before it is overwritten. */
  function freshMarkdown(field: MarkdownKey) {
    return async () => {
      const row = editingId ? await get<Task>('task', editingId) : undefined;
      if (!row) throw new Error('That row was deleted somewhere else — nothing was saved.');
      return row[field] ?? '';
    };
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    formError = null;
    if (markdownEditing) {
      formError = 'Save or cancel the description and subtasks first.';
      return;
    }
    const values = toValues(draft);
    if (!values.title || !values.project) {
      formError = 'A task needs a title and a project.';
      return;
    }
    const savedId = editingId;
    if (!savedId) return;
    // patch() re-reads the row from the store and changes ONLY the fields
    // named — and only the fields the user changed are named, so an
    // untouched field keeps its per-field stamp and a concurrent edit to it
    // on another device still wins.
    const changes: Partial<TaskValues> = editingOriginal ? changedFields(editingOriginal, values) : { ...values };
    // Description and subtasks are not this button's: their MarkdownFields saved them already.
    delete changes.description;
    delete changes.subtasks;
    if (Object.keys(changes).length > 0) {
      const saved = await patch<Task>('task', savedId, changes);
      if (!saved) {
        formError = 'That row was deleted somewhere else — nothing was saved.';
        await refresh();
        return;
      }
    }
    await syncLinks_version_task(savedId);
    editingId = null;
    await refresh();
  }

  async function del(row: Task) {
    if (!confirm('Delete this row?')) return;
    await softDelete('task', row.id);
    await refresh();
  }
</script>

<div class="page-header">
  <h1>Task</h1>
  <button class="btn btn-primary" data-testid="task-new" onclick={startCreate}>+ New</button>
</div>

{#if notice}
  <p class="banner banner-warning" data-testid="task-notice">{notice}</p>
{/if}

{#if creating}
  <Card title="New task">
    <TaskCreateForm
      autofocus
      onCreated={() => {
        creating = false;
        void refresh();
      }}
      onCancel={() => (creating = false)}
    />
  </Card>
{/if}

{#if editingId !== null}
  {#key editingId}
  <Card title="Edit">
    <form class="stack" onsubmit={save} bind:this={formEl}>
      <div>
        <label for="f-title">Title</label>
        <input id="f-title" bind:value={draft.title} required />
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
      <div class="field-pair">
        <div>
          <label for="f-task_type">Type</label>
          <select id="f-task_type" bind:value={draft.task_type} required>
            {#each taskTypeOptions as opt (opt.id)}
              <option value={opt.id}>{opt.label}</option>
            {/each}
            {#if draft.task_type && !taskTypeOptions.some((o) => o.id === draft.task_type)}
              <option value={draft.task_type}>{draft.task_type}</option>
            {/if}
          </select>
        </div>
        <div>
          <label for="f-priority">Priority</label>
          <select id="f-priority" bind:value={draft.priority} required>
            {#each PRIORITY_VALUES as opt (opt.value)}
              <option value={opt.value}>{opt.value} · {opt.label}</option>
            {/each}
            {#if !PRIORITY_VALUES.some((o) => o.value === draft.priority)}
              <option value={draft.priority}>{draft.priority}</option>
            {/if}
          </select>
        </div>
      </div>
      <div class="md-box">
        <MarkdownField
          label="Description"
          testid="task-description"
          value={draft.description}
          placeholder="No description yet."
          minHeight="8rem"
          onSave={markdownSaver('description')}
          getFresh={freshMarkdown('description')}
        />
        <MarkdownField
          label="Subtasks"
          testid="task-subtasks"
          value={draft.subtasks}
          placeholder="No subtasks yet. Write a checklist: - [ ] first step"
          minHeight="6rem"
          onSave={markdownSaver('subtasks')}
          getFresh={freshMarkdown('subtasks')}
        />
        <p class="hint md-note">Each is saved on its own with its Save button.</p>
      </div>
      <div>
        <label>Versions</label>
        {#if versionsForDraft.length === 0}
          <p class="muted">No version yet{draft.project ? ' for this project' : ''} — create one below.</p>
        {/if}
        <div class="link-list">
          {#each versionsForDraft as opt (opt.id)}
            <label class="check link-item">
              <input
                type="checkbox"
                checked={linked_version_task.includes(opt.id)}
                onchange={() => toggleLink_version_task(opt.id)}
              />
              {versionLabel(opt)}
            </label>
          {/each}
        </div>
        <div class="inline-new">
          <input placeholder="New version number" bind:value={newLink_version_task} />
          <button
            type="button"
            class="btn btn-sm"
            data-testid="task-create-version"
            onclick={createLink_version_task}
            disabled={!newLink_version_task.trim() || !draft.project}
            title={draft.project ? undefined : 'Select a project first'}
          >
            + Create & link
          </button>
        </div>
        {#if !draft.project}
          <p class="muted hint">Select a project to create a version for it.</p>
        {/if}
      </div>
      {#if formError}
        <p class="form-error">{formError}</p>
      {/if}
      <div class="row">
        <button class="btn btn-primary" data-testid="task-save" type="submit" disabled={markdownEditing}>Save</button>
        <button class="btn" type="button" onclick={() => (editingId = null)}>Cancel</button>
        {#if markdownEditing}
          <span class="hint">Save or cancel the description and subtasks first.</span>
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
          <th>Title</th>
          <th>Project</th>
          <th>Type</th>
          <th>Priority</th>
          <th>Description</th>
          <th>Subtasks</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr data-testid="task-row" data-row-id={row.id}>
            <td>{row.title || '(untitled)'}</td>
            <td>{projectLabel(row.project)}</td>
            <td>{taskTypeLabel(row.task_type)}</td>
            <td>{priorityLabel(row.priority)}</td>
            <td><MarkdownCell markdown={row.description} testid="task-description-cell" /></td>
            <td><MarkdownCell markdown={row.subtasks} testid="task-subtasks-cell" /></td>
            <td class="actions">
              <button class="btn btn-sm" data-testid="task-edit" onclick={() => startEdit(row)}>Edit</button>
              <button class="btn btn-sm btn-danger" data-testid="task-delete" onclick={() => del(row)}>Delete</button>
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
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
  }

  .md-note {
    margin: 0;
  }

  .field-pair {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--space-3);
  }

  .hint {
    font-size: var(--font-size-sm);
    margin-top: var(--space-1);
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
