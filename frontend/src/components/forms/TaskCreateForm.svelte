<script lang="ts">
  /**
   * Create a task (used by /task and the FAB's "New Task").
   *
   * Title, project, type (default: preferences.default_task_type), priority
   * (default 4 · Low), description and subtasks (MarkdownFields kept in the
   * draft and written with the row), and which of the project's versions to
   * schedule it in. `initialProject`/`initialVersion` preselect the project
   * and pre-check the version (the FAB passes the board context, D19).
   *
   * Links are created with addTaskToVersion (lib/board/actions.ts) with the
   * chosen status (TODO unless `initialStatus` says otherwise — the board's
   * Ctrl+1/2/3, D26), so the new card lands at the top of that column.
   *
   * Test hooks: task-create-form, task-create-title, task-create-project,
   * task-create-status, task-create-version-<versionId> (checkbox),
   * task-create-version (inline "Create & link" button), task-create-submit,
   * task-create-description and task-create-subtasks (MarkdownField prefixes).
   */
  import { onMount, untrack } from 'svelte';
  import { all, getSingleton, put, withSyncFields } from '../../lib/db/repo';
  import { DEFAULT_PRIORITY, DEFAULT_TASK_TYPE, PRIORITY_VALUES } from '../../lib/db/types';
  import type {
    Preferences,
    Project,
    StatusTypeKey,
    SyncFields,
    Task,
    TaskType,
    TaskTypeKey,
    Version,
  } from '../../lib/db/types';
  import { projectLabel } from '../../lib/crud';
  import { sortVersions } from '../../lib/versions';
  import { addTaskToVersion } from '../../lib/board/actions';
  import MarkdownField from '../markdown/MarkdownField.svelte';
  import { watchMarkdownEditing } from './markdownEditing';

  type TaskValues = Omit<Task, keyof SyncFields>;

  /** The board's three columns; a new link starts in one of them. */
  const STATUSES: { key: StatusTypeKey; label: string }[] = [
    { key: 'todo', label: 'TODO' },
    { key: 'in_progress', label: 'In Progress' },
    { key: 'done', label: 'Done' },
  ];

  let {
    initialProject = null,
    initialVersion = null,
    initialStatus = 'todo',
    onCreated = undefined,
    onCancel = undefined,
    autofocus = false,
  }: {
    initialProject?: string | null;
    initialVersion?: string | null;
    /** The status of the links it creates (the column the card starts in). */
    initialStatus?: StatusTypeKey;
    onCreated?: (task: Task) => void;
    onCancel?: () => void;
    /** Focus the title on mount (dialogs). */
    autofocus?: boolean;
  } = $props();

  const uid = $props.id();
  let projects: Project[] = $state([]);
  let taskTypes: TaskType[] = $state([]);
  let versions: Version[] = $state([]);
  let defaultTaskType: TaskTypeKey = $state(DEFAULT_TASK_TYPE);
  let draft = $state(blankDraft());
  let linked: string[] = $state([]);
  /** Starts from `initialStatus` once; the select owns it after that. */
  let status: StatusTypeKey = $state(
    untrack(() => (STATUSES.some((s) => s.key === initialStatus) ? initialStatus : 'todo'))
  );
  let newProjectName = $state('');
  let newVersionNumber = $state('');
  let formError: string | null = $state(null);
  let saving = $state(false);
  let formEl: HTMLFormElement | null = $state(null);
  let titleEl: HTMLInputElement | null = $state(null);
  let markdownEditing = $state(false);

  $effect(() => watchMarkdownEditing(formEl, (editing) => (markdownEditing = editing)));

  function blankDraft(project = '') {
    return {
      title: '',
      project,
      task_type: defaultTaskType as string,
      priority: DEFAULT_PRIORITY as number,
      description: '',
      subtasks: '',
    };
  }

  /** The selected project's versions: a task is only scheduled in its own project's versions. */
  const versionsForDraft = $derived(sortVersions(versions.filter((v) => v.project === draft.project)));

  /** Switching project drops checked versions of the old one (e.g. the board context's version). */
  function selectProject(projectId: string) {
    draft.project = projectId;
    linked = linked.filter((id) => versions.some((v) => v.id === id && v.project === projectId));
  }

  onMount(async () => {
    const [p, t, v, prefs] = await Promise.all([
      all<Project>('project'),
      all<TaskType>('task_type'),
      all<Version>('version'),
      getSingleton<Preferences>('preferences'),
    ]);
    projects = p.sort((a, b) => projectLabel(a).localeCompare(projectLabel(b)));
    taskTypes = t.sort((a, b) => a.position - b.position);
    versions = v;
    defaultTaskType = prefs?.default_task_type ?? DEFAULT_TASK_TYPE;
    const project = initialProject && projects.some((row) => row.id === initialProject) ? initialProject : '';
    draft = { ...draft, project, task_type: defaultTaskType };
    const version = initialVersion ? versions.find((row) => row.id === initialVersion) : undefined;
    if (version && version.project === project) linked = [version.id];
    if (autofocus) titleEl?.focus();
  });

  function toggleLink(versionId: string) {
    linked = linked.includes(versionId) ? linked.filter((id) => id !== versionId) : [...linked, versionId];
  }

  /** Create a project row in place and select it. */
  async function createProjectInline() {
    const name = newProjectName.trim();
    if (!name) return;
    const created = await put('project', withSyncFields({ name, description: '' }));
    projects = [...projects, created];
    selectProject(created.id);
    newProjectName = '';
  }

  /**
   * Create a version in place and check it. It belongs to the task's project —
   * never '' (an orphan row every device would then carry) — so the button is
   * disabled until a project is selected.
   */
  async function createVersionInline() {
    const number = newVersionNumber.trim();
    if (!number || !draft.project) return;
    const created = await put(
      'version',
      withSyncFields<Omit<Version, keyof SyncFields>>({ number, project: draft.project, description: null, completed: false })
    );
    versions = [...versions, created];
    linked = [...linked, created.id];
    newVersionNumber = '';
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (saving) return;
    formError = null;
    if (markdownEditing) {
      formError = 'Save or cancel the description and subtasks first.';
      return;
    }
    const values: TaskValues = {
      project: draft.project,
      title: draft.title.trim(),
      task_type: draft.task_type as TaskTypeKey,
      description: draft.description === '' ? null : draft.description,
      priority: draft.priority,
      subtasks: draft.subtasks === '' ? null : draft.subtasks,
    };
    if (!values.title || !values.project) {
      formError = 'A task needs a title and a project.';
      return;
    }
    saving = true;
    try {
      const created = await put('task', withSyncFields<TaskValues>(values));
      for (const versionId of linked) {
        await addTaskToVersion(created.id, versionId, status);
      }
      draft = blankDraft(draft.project);
      linked = [];
      onCreated?.(created);
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }
</script>

<form class="stack create-form" data-testid="task-create-form" onsubmit={save} bind:this={formEl}>
  <div>
    <label for="{uid}-title">Title</label>
    <input id="{uid}-title" data-testid="task-create-title" bind:value={draft.title} bind:this={titleEl} required />
  </div>
  <div>
    <label for="{uid}-project">Project</label>
    <select
      id="{uid}-project"
      data-testid="task-create-project"
      value={draft.project}
      onchange={(e) => selectProject(e.currentTarget.value)}
      required
    >
      <option value="" disabled>Select…</option>
      {#each projects as opt (opt.id)}
        <option value={opt.id}>{projectLabel(opt)}</option>
      {/each}
    </select>
    <div class="inline-new">
      <input placeholder="New project name" bind:value={newProjectName} />
      <button type="button" class="btn btn-sm" onclick={createProjectInline} disabled={!newProjectName.trim()}>
        + New
      </button>
    </div>
  </div>
  <div class="field-pair">
    <div>
      <label for="{uid}-type">Type</label>
      <select id="{uid}-type" bind:value={draft.task_type} required>
        {#each taskTypes as opt (opt.id)}
          <option value={opt.id}>{opt.label}</option>
        {/each}
        {#if draft.task_type && !taskTypes.some((o) => o.id === draft.task_type)}
          <option value={draft.task_type}>{draft.task_type}</option>
        {/if}
      </select>
    </div>
    <div>
      <label for="{uid}-priority">Priority</label>
      <select id="{uid}-priority" bind:value={draft.priority} required>
        {#each PRIORITY_VALUES as opt (opt.value)}
          <option value={opt.value}>{opt.value} · {opt.label}</option>
        {/each}
      </select>
    </div>
  </div>
  <div class="md-box">
    <MarkdownField
      label="Description"
      testid="task-create-description"
      value={draft.description}
      placeholder="No description yet."
      minHeight="8rem"
      onSave={async (md) => {
        draft.description = md;
      }}
    />
    <MarkdownField
      label="Subtasks"
      testid="task-create-subtasks"
      value={draft.subtasks}
      placeholder="No subtasks yet. Write a checklist: - [ ] first step"
      minHeight="6rem"
      onSave={async (md) => {
        draft.subtasks = md;
      }}
    />
    <p class="hint md-note">Kept with the new task and stored when you create it.</p>
  </div>
  <div>
    <span class="label">Versions</span>
    {#if versionsForDraft.length === 0}
      <p class="muted">
        {draft.project ? 'No version yet for this project — create one below.' : 'Select a project to schedule the task in its versions.'}
      </p>
    {/if}
    <label class="status-pick">
      <span>Starts in</span>
      <select data-testid="task-create-status" bind:value={status}>
        {#each STATUSES as opt (opt.key)}
          <option value={opt.key}>{opt.label}</option>
        {/each}
      </select>
    </label>
    <div class="link-list">
      {#each versionsForDraft as opt (opt.id)}
        <label class="check link-item">
          <input
            type="checkbox"
            data-testid="task-create-version-{opt.id}"
            checked={linked.includes(opt.id)}
            onchange={() => toggleLink(opt.id)}
          />
          {opt.number}{opt.completed ? ' (completed)' : ''}
        </label>
      {/each}
    </div>
    <div class="inline-new">
      <input placeholder="New version number" bind:value={newVersionNumber} />
      <button
        type="button"
        class="btn btn-sm"
        data-testid="task-create-version"
        onclick={createVersionInline}
        disabled={!newVersionNumber.trim() || !draft.project}
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
    <button
      class="btn btn-primary"
      data-testid="task-create-submit"
      type="submit"
      disabled={markdownEditing || saving}>Create task</button
    >
    {#if onCancel}
      <button class="btn" type="button" onclick={() => onCancel?.()}>Cancel</button>
    {/if}
    {#if markdownEditing}
      <span class="hint">Save or cancel the description and subtasks first.</span>
    {/if}
  </div>
</form>

<style>
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

  .label {
    display: block;
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

  .status-pick {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-1) 0 0;
    font-size: var(--font-size-sm);
  }

  .status-pick select {
    width: auto;
    padding: var(--space-1) var(--space-2);
  }
</style>
