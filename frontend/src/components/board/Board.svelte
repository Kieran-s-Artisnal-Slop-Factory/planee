<script lang="ts">
  /**
   * The board: one project, one version at a time (D3). Home mounts it under
   * the recent-issues strip (D17); `/board/` only redirects to `/`.
   *
   * Reads go through repo (`lib/board/actions.ts` loadProjectData); every write
   * goes through `lib/board/actions.ts`, which plans with the pure
   * `lib/board/adapter.ts` and writes with repo `put`/`patch`/`softDelete`.
   * The page never writes a row built from what it is showing.
   *
   * Live: `onChanged` (lib/db/changes.ts) fires for local writes, other tabs
   * and syncs that pulled rows; the page re-reads (debounced) and hands the
   * board fresh cards. Markdown fields are keyed by row id, so a re-read never
   * re-creates one — an open edit survives any number of refreshes. Asset
   * changes bump a preview nonce instead of re-keying anything.
   *
   * URL: `?project=<id>&version=<id>`, falling back to the last board opened
   * (localStorage `planee-board-last`), then the first project by name and its
   * current version. `&task=<task id>` opens that task's card dialog (D18) once
   * the data is loaded: in the selected version when it is scheduled there,
   * else in the version links.pickTaskVersion picks (switching project and
   * version to it), else (unscheduled) the page moves to `/task/?edit=`.
   * An open dialog keeps `task` in the URL; closing it removes it.
   * `openTarget({ project, version, task })` does the same in place (Home's
   * recent issues).
   *
   * Views (D16, per device): opening a card dialog records the task; a
   * project/version becoming the shown selection records it (once per change,
   * not per re-read).
   *
   * Keys (D23–D27, lib/ui/keybinds.ts; the chords are in lib/ui/keymap.ts):
   * the board registers its `home` keys while mounted — Ctrl+1/2/3 New Task in
   * that column (the FAB's dialog, status preset, this project and version),
   * Ctrl+Shift+1/2/3 focus a column's first card, Ctrl+4 the project picker,
   * Ctrl+Shift+C Mark complete, Ctrl+Shift+E the Edit version modal — and its
   * `card` keys, live while a card has focus (Tab/PageDown, Shift+Tab/PageUp,
   * Ctrl+E, Ctrl+arrows: KanbanBoard's keyboard methods). On a completed
   * version the writing keys are disabled (swallowed, dimmed in the overlay).
   *
   * Test hooks (data-testid): board-root (data-project, data-version,
   * data-readonly), board-project-select, board-version-current,
   * board-version-option, board-completed-toggle, board-completed-version,
   * board-new-version, board-new-version-input, board-new-version-create,
   * board-create-first-version, board-version-title, board-completed-badge,
   * board-mark-complete, board-reopen, complete-dialog, complete-dialog-bump,
   * complete-dialog-anyway, complete-dialog-cancel, complete-dialog-number,
   * version-description, task-description, task-subtasks, card-type,
   * card-resolution, card-subtasks, card-type-select, card-resolution-select,
   * card-bump, unscheduled, unscheduled-task, unscheduled-add, sync-pill,
   * sync-now, board-error, board-empty, board-new-project, board-edit-version
   * (and EditVersionDialog's). KanbanBoard's own hooks are data attributes — see
   * the Phase 9 report / KanbanBoard.svelte.
   */
  import { onMount } from 'svelte';
  import KanbanBoard from '../kanban/KanbanBoard.svelte';
  import MarkdownField from '../markdown/MarkdownField.svelte';
  import EditVersionDialog from './EditVersionDialog.svelte';
  import { all, byIndex, get } from '../../lib/db/repo';
  import { onChanged } from '../../lib/db/changes';
  import { TASK_TYPE_VALUES, isDoneStatus } from '../../lib/db/types';
  import type { Project, StatusTypeKey, Task, TaskTypeKey, Version, VersionTask } from '../../lib/db/types';
  import { projectLabel } from '../../lib/crud';
  import {
    SYNC_EVENT,
    flushPendingSync,
    getSyncMode,
    getSyncStatus,
    syncNow,
    type SyncMode,
    type SyncStatus,
  } from '../../lib/sync';
  import {
    BOARD_CREATE_DEFAULTS,
    RESOLUTION_LABELS,
    boardSchema,
    planComplete,
    subtaskProgress,
    toCards,
    type BoardCard,
    type TaskChanges,
  } from '../../lib/board/adapter';
  import * as actions from '../../lib/board/actions';
  import type { ProjectData } from '../../lib/board/actions';
  import { currentVersion, latestVersion, sortVersions, suggestNextNumber } from '../../lib/versions';
  import type { CardRecord } from '../../lib/kanban/types';
  import { BOARD_LAST_KEY, pickTaskVersion, taskEditHref, type BoardTarget } from '../../lib/ui/links';
  import { recordView } from '../../lib/ui/recent';
  import { openCreate } from '../../lib/ui/commands';
  import { registerKeyHandlers } from '../../lib/ui/keybinds';
  import type { CardDirection } from '../../lib/board/keyboard';
  import { TASK_TYPE_TONES } from '../../lib/ui/recentIssues';

  const LAST_KEY = BOARD_LAST_KEY;
  const WATCHED = ['project', 'version', 'task', 'version_task', 'asset', 'preferences'];
  const schema = boardSchema();
  const formFields = ['title', 'status', 'priority'] as const;

  let loading = $state(true);
  let projects = $state<Project[]>([]);
  let projectId = $state('');
  let versionId = $state('');
  let data = $state<ProjectData | null>(null);
  let actionError = $state('');
  let assetNonce = $state(0);

  let showCompleted = $state(false);
  let newVersionOpen = $state(false);
  let newVersionNumber = $state('');
  let unscheduledOpen = $state(false);

  let editingVersion = $state(false);
  // A version completed (or deleted) elsewhere takes its Edit dialog with it,
  // for good: reopening it later must not bring the dialog back.
  $effect(() => {
    if (editingVersion && (!version || version.completed)) editingVersion = false;
  });
  let kanban = $state<ReturnType<typeof KanbanBoard>>();
  let projectSelect = $state<HTMLSelectElement>();

  let completing = $state<{ todo: number; inProgress: number; target: string; exists: boolean } | null>(null);
  let completeNumber = $state('');
  let completeBusy = $state(false);

  /** A task to open once the data is in (`?task=` / openTarget). */
  let pendingTask: string | null = null;
  /** How many project/version switches the pending task has caused; stops a loop. */
  let pendingHops = 0;
  /** The card (version_task id) whose dialog the board should open. */
  let openCardId = $state<string | null>(null);

  let sync = $state<SyncStatus>({ lastSyncAt: null, lastError: null, pending: 0 });
  let syncMode = $state<SyncMode>('sync');
  let syncBusy = $state(false);
  let syncMessage = $state('');

  const versions = $derived(sortVersions(data?.versions ?? []));
  const current = $derived(currentVersion(versions));
  const version = $derived(versions.find((v) => v.id === versionId));
  const otherOpen = $derived(versions.filter((v) => !v.completed && v.id !== current?.id));
  const completed = $derived(versions.filter((v) => v.completed).reverse());
  const readonly = $derived(!!version?.completed);
  const cards = $derived(
    data && version ? toCards(data.links.filter((l) => l.version === version.id), data.tasks) : []
  );
  const unscheduled = $derived.by(() => {
    if (!data) return [];
    const scheduled = new Set(data.links.map((l) => l.task));
    return data.tasks
      .filter((t) => !scheduled.has(t.id))
      .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  });
  const sortedProjects = $derived(
    [...projects].sort((a, b) => projectLabel(a).localeCompare(projectLabel(b)))
  );

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  // ── Loading ────────────────────────────────────────────────────────────────

  let loadSeq = 0;

  async function reload() {
    const seq = ++loadSeq;
    const list = await actions.loadProjects();
    const byName = [...list].sort((a, b) => projectLabel(a).localeCompare(projectLabel(b)));
    const pid = list.some((p) => p.id === projectId) ? projectId : (byName[0]?.id ?? '');
    const next = pid ? await actions.loadProjectData(pid) : null;
    if (seq !== loadSeq) return;
    projects = list;
    projectId = pid;
    data = next;
    const live = next?.versions ?? [];
    if (!live.some((v) => v.id === versionId)) {
      versionId = currentVersion(live)?.id ?? latestVersion(live)?.id ?? '';
    }
    loading = false;
    remember();
    // A pending task may still move the board elsewhere: record what it settles on.
    if (pendingTask) await resolvePendingTask(seq);
    else recordSelection();
  }

  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void reload(), 50);
  }

  /** Put the selection in the URL and remember it for the next visit. */
  function remember() {
    try {
      const url = new URL(location.href);
      if (projectId) url.searchParams.set('project', projectId);
      else url.searchParams.delete('project');
      if (versionId) url.searchParams.set('version', versionId);
      else url.searchParams.delete('version');
      if (url.href !== location.href) history.replaceState(history.state, '', url);
    } catch {
      // No history API (or a sandbox refusing it): the selection still works.
    }
    try {
      if (projectId) localStorage.setItem(LAST_KEY, JSON.stringify({ project: projectId, version: versionId }));
    } catch {
      // Storage unavailable: the next visit starts from the first project.
    }
  }

  /** Set or remove `task` in the URL without touching the rest of it. */
  function setTaskParam(taskId: string | null) {
    try {
      const url = new URL(location.href);
      if (taskId) url.searchParams.set('task', taskId);
      else url.searchParams.delete('task');
      if (url.href !== location.href) history.replaceState(history.state, '', url);
    } catch {
      // No history API: the dialog still works.
    }
  }

  let recordedProject = '';
  let recordedVersion = '';

  /** Record the shown project/version as viewed, once per change. */
  function recordSelection() {
    if (projectId && projectId !== recordedProject && data?.project.id === projectId) {
      recordedProject = projectId;
      recordView('project', projectId);
    }
    if (versionId && versionId !== recordedVersion && data?.versions.some((v) => v.id === versionId)) {
      recordedVersion = versionId;
      recordView('version', versionId);
    }
  }

  /**
   * Open the pending task's card: in the selected version if it is there, else
   * switch to the version its card opens in, else (unscheduled) go to its editor.
   */
  async function resolvePendingTask(seq: number) {
    const taskId = pendingTask;
    if (!taskId || !data) return;
    const here = data.links.find((l) => l.task === taskId && l.version === versionId);
    if (here && data.tasks.some((t) => t.id === taskId)) {
      pendingTask = null;
      pendingHops = 0;
      openCardId = here.id;
      recordSelection();
      return;
    }
    const [task, links, allVersions] = await Promise.all([
      get<Task>('task', taskId),
      byIndex<VersionTask>('version_task', 'task', taskId),
      all<Version>('version'),
    ]);
    if (seq !== loadSeq || pendingTask !== taskId) return;
    const giveUp = () => {
      pendingTask = null;
      pendingHops = 0;
      setTaskParam(null);
      recordSelection();
    };
    if (!task) return giveUp();
    const picked = pickTaskVersion(taskId, links, allVersions);
    if (!picked) {
      pendingTask = null;
      location.replace(taskEditHref(taskId));
      return;
    }
    const pickedProject = allVersions.find((v) => v.id === picked.id)?.project ?? task.project;
    if ((pickedProject === projectId && picked.id === versionId) || pendingHops >= 2) return giveUp();
    pendingHops += 1;
    if (pickedProject !== projectId) {
      projectId = pickedProject;
      newVersionOpen = false;
      showCompleted = false;
    }
    versionId = picked.id;
    await reload();
  }

  /**
   * Show a project/version/task in place: what navigating to
   * `boardHref(target)` would show, without reloading the page.
   */
  export function openTarget(target: BoardTarget) {
    openCardId = null;
    if (target.project && target.project !== projectId) {
      projectId = target.project;
      newVersionOpen = false;
      showCompleted = false;
    }
    if (target.version) versionId = target.version;
    else if (target.project) versionId = '';
    pendingTask = target.task ?? null;
    pendingHops = 0;
    setTaskParam(pendingTask);
    void reload();
  }

  function dialogOpened(record: CardRecord) {
    const card = record as BoardCard;
    if (!card.taskId) return;
    recordView('task', card.taskId);
    setTaskParam(card.taskId);
  }

  function dialogClosed() {
    openCardId = null;
    setTaskParam(null);
  }

  function initialSelection() {
    const params = new URLSearchParams(location.search);
    pendingTask = params.get('task') || null;
    const project = params.get('project');
    if (project) {
      projectId = project;
      versionId = params.get('version') ?? '';
      return;
    }
    try {
      const last = JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null') as {
        project?: string;
        version?: string;
      } | null;
      if (last?.project) {
        projectId = last.project;
        versionId = last.version ?? '';
      }
    } catch {
      // A corrupt entry is just no entry.
    }
  }

  async function refreshSync() {
    try {
      sync = await getSyncStatus();
      syncMode = getSyncMode();
    } catch {
      // IndexedDB unavailable: leave the last known status.
    }
  }

  onMount(() => {
    initialSelection();
    void reload();
    void refreshSync();
    const stop = onChanged(WATCHED, (stores) => {
      if (stores.includes('asset')) assetNonce += 1;
      if (stores.some((s) => s !== 'asset')) scheduleReload();
      void refreshSync();
    });
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent).detail as { ok?: boolean; error?: string } | undefined;
      if (detail && !detail.ok && detail.error) syncMessage = detail.error;
      void refreshSync();
    };
    window.addEventListener(SYNC_EVENT, onSync);
    return () => {
      stop();
      clearTimeout(reloadTimer);
      window.removeEventListener(SYNC_EVENT, onSync);
    };
  });

  // ── Keys ───────────────────────────────────────────────────────────────────

  const COLUMNS: StatusTypeKey[] = ['todo', 'in_progress', 'done'];
  /** A version is showing and can be written to. */
  const writable = () => !!version && !version.completed;

  /** Ctrl+4: the project picker, opened where the browser allows it. */
  function openProjectPicker() {
    const select = projectSelect;
    if (!select) return;
    select.focus();
    try {
      select.showPicker();
    } catch {
      // No showPicker (or no user activation): focused is the next best thing.
    }
  }

  onMount(() => {
    const home: Parameters<typeof registerKeyHandlers>[1] = {
      'board.project': { run: openProjectPicker, enabled: () => !!projectSelect },
      'version.complete': { run: openComplete, enabled: () => writable() && !!data },
      'version.edit': { run: () => (editingVersion = true), enabled: writable },
    };
    for (const status of COLUMNS) {
      home[`column.${status}.new`] = {
        // D26: the FAB's New Task dialog, this board's project and version, the column's status.
        run: () => openCreate('task', { status, project: projectId, version: versionId }),
        enabled: writable,
      };
      home[`column.${status}.focus`] = {
        run: () => void kanban?.focusFirstCard(status),
        enabled: () => !!version && !!kanban,
      };
    }
    const move = (direction: CardDirection) => ({
      run: () => void kanban?.moveFocusedCard(direction),
      enabled: () => !readonly,
    });
    const stopHome = registerKeyHandlers('home', home);
    const stopCard = registerKeyHandlers(
      'card',
      {
        'card.next': () => kanban?.focusNeighbourCard(1) ?? false,
        'card.prev': () => kanban?.focusNeighbourCard(-1) ?? false,
        'card.edit': { run: () => void kanban?.editFocusedCard(), enabled: () => !readonly },
        'card.up': move('up'),
        'card.down': move('down'),
        'card.left': move('left'),
        'card.right': move('right'),
      },
      { active: () => !!kanban?.focusedCardId() }
    );
    return () => {
      stopHome();
      stopCard();
    };
  });

  // ── Selection ──────────────────────────────────────────────────────────────

  function selectProject(id: string) {
    if (id === projectId) return;
    dropDialog();
    projectId = id;
    versionId = '';
    newVersionOpen = false;
    showCompleted = false;
    void reload();
  }

  function selectVersion(id: string) {
    if (id !== versionId) dropDialog();
    versionId = id;
    newVersionOpen = false;
    remember();
    recordSelection();
  }

  /** Switching the board away takes an open or pending card dialog with it. */
  function dropDialog() {
    pendingTask = null;
    pendingHops = 0;
    openCardId = null;
    setTaskParam(null);
  }

  /** Run a write, showing its failure rather than dropping it. */
  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    actionError = '';
    try {
      return await work();
    } catch (err) {
      actionError = message(err);
      return undefined;
    }
  }

  // ── Versions ───────────────────────────────────────────────────────────────

  function startNewVersion() {
    newVersionNumber = suggestNextNumber(
      latestVersion(versions)?.number ?? '0.0.0',
      versions.map((v) => v.number)
    );
    newVersionOpen = true;
  }

  async function createVersion(number: string) {
    if (!projectId) return;
    if (versions.some((v) => v.number.trim() === number.trim())) {
      actionError = `Version ${number.trim()} already exists.`;
      return;
    }
    const created = await run(() => actions.createVersion(projectId, number));
    if (!created) return;
    newVersionOpen = false;
    versionId = created.id;
    await reload();
  }

  function openComplete() {
    if (!version || !data) return;
    const plan = planComplete(version, data.links, data.versions);
    const exists = 'version' in plan.target;
    completing = {
      todo: plan.todo,
      inProgress: plan.inProgress,
      target: 'version' in plan.target ? plan.target.version.number : plan.target.create,
      exists,
    };
    completeNumber = exists ? '' : completing.target;
  }

  async function complete(bumpOpen: boolean) {
    if (!version || !completing || completeBusy) return;
    const id = version.id;
    const number = completeNumber.trim();
    if (bumpOpen && !completing.exists && versions.some((v) => v.number.trim() === number)) {
      actionError = `Version ${number} already exists.`;
      return;
    }
    completeBusy = true;
    const done = await run(() =>
      actions.completeVersion(id, {
        bumpOpen,
        chooseNumber: () => completeNumber.trim() || null,
      })
    );
    completeBusy = false;
    if (!done) return;
    completing = null;
    await reload();
    // The completed version is history now: follow the work to the new current one.
    const now = currentVersion(versions);
    if (now) selectVersion(now.id);
  }

  async function reopen() {
    if (!version) return;
    const id = version.id;
    await run(() => actions.reopenVersion(id));
  }

  /** The Edit version modal's save: only the fields it changed (D10). */
  async function saveVersionEdit(id: string, changes: { number?: string; description?: string | null }) {
    await actions.patchVersion(id, changes);
  }

  async function saveVersionDescription(id: string, md: string) {
    await actions.patchVersion(id, { description: md === '' ? null : md });
  }

  async function freshVersionDescription(id: string) {
    return (await get<Version>('version', id))?.description ?? null;
  }

  // ── Cards ──────────────────────────────────────────────────────────────────

  const onCreate = (draft: CardRecord) => actions.createCard(draft, { projectId, versionId });
  const onUpdate = (id: unknown, patch: CardRecord) => actions.updateCard(String(id), patch);
  const onDelete = (id: unknown) => actions.deleteCard(String(id));

  async function saveTask(taskId: string, changes: TaskChanges) {
    await actions.patchTask(taskId, changes);
  }

  async function freshTask(taskId: string, field: 'description' | 'subtasks') {
    return (await get<Task>('task', taskId))?.[field] ?? null;
  }

  const askNumber = (suggested: string) =>
    prompt('There is no later open version. Create one numbered:', suggested);

  async function bump(linkId: string, close: () => void) {
    const target = await run(() => actions.bumpLink(linkId, askNumber));
    if (target) close();
  }

  async function setResolution(linkId: string, status: string) {
    await run(() => actions.setResolution(linkId, status as StatusTypeKey, askNumber));
  }

  async function addToVersion(taskId: string) {
    if (!versionId) return;
    const id = versionId;
    await run(() => actions.addTaskToVersion(taskId, id));
  }

  const typeLabel = (key: string) => TASK_TYPE_VALUES.find((t) => t.key === key)?.label ?? key;
  const TYPE_TONES = TASK_TYPE_TONES;

  // ── Sync ───────────────────────────────────────────────────────────────────

  async function syncNowClicked() {
    if (syncBusy) return;
    syncBusy = true;
    syncMessage = '';
    try {
      await flushPendingSync();
      const result = await syncNow();
      syncMessage = result.ok
        ? `Synced: ${result.pushed} sent, ${result.pulled} received`
        : (result.error ?? 'Sync failed');
    } finally {
      syncBusy = false;
      await refreshSync();
    }
  }
</script>

{#snippet cardBadges(record: CardRecord)}
  {@const card = record as BoardCard}
  {@const progress = subtaskProgress(card.subtasks)}
  {#if card.task_type}
    <span class="kb-pill tone-{TYPE_TONES[card.task_type] ?? 'muted'}" data-testid="card-type"
      >{typeLabel(card.task_type)}</span
    >
  {/if}
  {#if card.status && card.status !== 'done' && isDoneStatus(card.status)}
    <span
      class="kb-pill tone-{card.status === 'bumped' ? 'info' : 'warning'}"
      data-testid="card-resolution"
      data-status={card.status}>{RESOLUTION_LABELS[card.status]}</span
    >
  {/if}
  {#if progress.total > 0}
    <span
      class="kb-pill tone-{progress.done === progress.total ? 'success' : 'muted'}"
      data-testid="card-subtasks"
      title="Subtasks done">☑ {progress.done}/{progress.total}</span
    >
  {/if}
{/snippet}

{#snippet dialogBody(record: CardRecord)}
  {@const card = record as BoardCard}
  {#key card.taskId}
    <div class="dialog-body">
      <MarkdownField
        value={card.description || null}
        label="Description"
        placeholder="No description yet."
        testid="task-description"
        {readonly}
        minHeight="10rem"
        nonce={assetNonce}
        getFresh={() => freshTask(card.taskId, 'description')}
        onSave={(md) => saveTask(card.taskId, { description: md === '' ? null : md })}
      />
      <MarkdownField
        value={card.subtasks || null}
        label="Subtasks"
        placeholder="No subtasks. Edit to add a checklist: - [ ] step"
        testid="task-subtasks"
        {readonly}
        minHeight="6rem"
        nonce={assetNonce}
        getFresh={() => freshTask(card.taskId, 'subtasks')}
        onSave={(md) => saveTask(card.taskId, { subtasks: md === '' ? null : md })}
      />
    </div>
  {/key}
{/snippet}

{#snippet dialogActions(record: CardRecord, close: () => void)}
  {@const card = record as BoardCard}
  {#if !readonly && card.taskId}
    <label class="inline-select">
      <span>Type</span>
      <select
        data-testid="card-type-select"
        value={card.task_type}
        onchange={(event) =>
          void run(() => saveTask(card.taskId, { task_type: event.currentTarget.value as TaskTypeKey }))}
      >
        {#each TASK_TYPE_VALUES as type (type.key)}
          <option value={type.key}>{type.label}</option>
        {/each}
      </select>
    </label>
    {#if isDoneStatus(card.status)}
      <label class="inline-select">
        <span>Resolution</span>
        <select
          data-testid="card-resolution-select"
          value={card.status}
          onchange={(event) => void setResolution(card.id, event.currentTarget.value)}
        >
          <option value="done">{RESOLUTION_LABELS.done}</option>
          <option value="wontfix">{RESOLUTION_LABELS.wontfix}</option>
          <option value="out_of_scope">{RESOLUTION_LABELS.out_of_scope}</option>
          {#if card.status === 'bumped'}
            <option value="bumped" disabled>{RESOLUTION_LABELS.bumped}</option>
          {/if}
        </select>
      </label>
    {/if}
    {#if card.status !== 'bumped'}
      <button type="button" class="btn" data-testid="card-bump" onclick={() => void bump(card.id, close)}>
        Bump to next version
      </button>
    {/if}
  {/if}
{/snippet}

<div class="board-page" data-testid="board-root" data-project={projectId} data-version={versionId} data-readonly={readonly}>
  <div class="board-top">
    <div class="board-title">
      <h1>Board</h1>
      {#if projects.length > 0}
        <label class="project-picker">
          <span class="visually-hidden">Project</span>
          <select
            data-testid="board-project-select"
            data-keybind="board.project"
            bind:this={projectSelect}
            value={projectId}
            onchange={(event) => selectProject(event.currentTarget.value)}
          >
            {#each sortedProjects as project (project.id)}
              <option value={project.id}>{projectLabel(project) || 'Untitled project'}</option>
            {/each}
          </select>
        </label>
      {/if}
    </div>

    <div
      class="sync-pill"
      data-testid="sync-pill"
      data-mode={syncMode}
      class:error={syncMode !== 'offline' && !!sync.lastError}
      title={syncMode === 'offline' ? 'Sync is off — changes stay on this device' : (sync.lastError ?? '')}
    >
      {#if syncMode === 'offline'}
        <span>Offline mode</span>
      {:else if sync.lastError}
        <span>Sync failed</span>
      {:else if sync.lastSyncAt}
        <span>Synced {new Date(sync.lastSyncAt).toLocaleTimeString()}</span>
      {:else}
        <span>Not synced yet</span>
      {/if}
      <span class="pending" data-testid="sync-pending">{sync.pending} pending</span>
      <button
        type="button"
        class="btn btn-sm"
        data-testid="sync-now"
        disabled={syncBusy || syncMode === 'offline'}
        title={syncMode === 'offline' ? 'Sync is off — turn it on in Settings' : 'Send and receive changes now'}
        onclick={() => void syncNowClicked()}>{syncBusy ? 'Syncing…' : 'Sync now'}</button
      >
    </div>
  </div>
  {#if syncMode !== 'offline' && (syncMessage || sync.lastError)}
    <p class="muted small sync-detail">{syncMessage || sync.lastError}</p>
  {/if}

  {#if actionError}
    <p class="banner banner-danger board-error" data-testid="board-error" role="alert">
      <span>{actionError}</span>
      <button type="button" class="btn btn-sm" onclick={() => (actionError = '')}>Dismiss</button>
    </p>
  {/if}

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if projects.length === 0}
    <div class="empty" data-testid="board-empty">
      <p><strong>No projects yet.</strong></p>
      <p class="muted">
        Start one with the <span class="plus" aria-hidden="true">+</span> button in the corner. A new project
        opens its board at version {actions.FIRST_VERSION_NUMBER}.
      </p>
      <button type="button" class="btn btn-primary" data-testid="board-new-project" onclick={() => openCreate('project')}>
        New project
      </button>
    </div>
  {:else if data && versions.length === 0}
    <div class="empty">
      <p>This project has no versions yet.</p>
      <button
        type="button"
        class="btn btn-primary"
        data-testid="board-create-first-version"
        onclick={() => void createVersion(actions.FIRST_VERSION_NUMBER)}
      >
        Create version {actions.FIRST_VERSION_NUMBER}
      </button>
    </div>
  {:else if data}
    <nav class="versions" aria-label="Versions">
      {#if current}
        <button
          type="button"
          class="version-btn current"
          class:selected={current.id === versionId}
          data-testid="board-version-current"
          data-version-id={current.id}
          aria-pressed={current.id === versionId}
          onclick={() => selectVersion(current.id)}
        >
          <span class="version-kicker">Current</span>
          <span class="version-number">{current.number}</span>
        </button>
      {:else}
        <span class="muted small">Every version is complete.</span>
      {/if}

      {#each otherOpen as other (other.id)}
        <button
          type="button"
          class="version-btn"
          class:selected={other.id === versionId}
          data-testid="board-version-option"
          data-version-id={other.id}
          aria-pressed={other.id === versionId}
          onclick={() => selectVersion(other.id)}
        >
          <span class="version-number">{other.number}</span>
        </button>
      {/each}

      {#if newVersionOpen}
        <form
          class="new-version"
          onsubmit={(event) => {
            event.preventDefault();
            void createVersion(newVersionNumber);
          }}
        >
          <!-- svelte-ignore a11y_autofocus -->
          <input
            data-testid="board-new-version-input"
            bind:value={newVersionNumber}
            aria-label="New version number"
            autofocus
            onkeydown={(event) => {
              if (event.key === 'Escape') newVersionOpen = false;
            }}
          />
          <button type="submit" class="btn btn-sm btn-primary" data-testid="board-new-version-create" disabled={!newVersionNumber.trim()}>
            Create
          </button>
          <button type="button" class="btn btn-sm" onclick={() => (newVersionOpen = false)}>Cancel</button>
        </form>
      {:else}
        <button type="button" class="btn btn-sm" data-testid="board-new-version" onclick={startNewVersion}>
          + New version
        </button>
      {/if}

      {#if completed.length > 0}
        <button
          type="button"
          class="btn btn-sm completed-toggle"
          data-testid="board-completed-toggle"
          aria-expanded={showCompleted}
          onclick={() => (showCompleted = !showCompleted)}
        >
          Completed versions ({completed.length}) {showCompleted ? '▴' : '▾'}
        </button>
      {/if}
    </nav>

    {#if showCompleted && completed.length > 0}
      <ul class="completed-list">
        {#each completed as done (done.id)}
          <li>
            <button
              type="button"
              class="version-btn done"
              class:selected={done.id === versionId}
              data-testid="board-completed-version"
              data-version-id={done.id}
              aria-pressed={done.id === versionId}
              onclick={() => selectVersion(done.id)}
            >
              <span aria-hidden="true">✓</span>
              <span class="version-number">{done.number}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if version}
      <section class="version-head">
        <div class="version-heading">
          <h2 data-testid="board-version-title">Version {version.number}</h2>
          {#if version.completed}
            <span class="badge badge-done" data-testid="board-completed-badge">Completed</span>
          {:else if version.id === current?.id}
            <span class="badge badge-active">Current</span>
          {/if}
          <span class="spacer"></span>
          {#if version.completed}
            <button type="button" class="btn" data-testid="board-reopen" onclick={() => void reopen()}>
              Reopen version
            </button>
          {:else}
            <button
              type="button"
              class="btn"
              data-testid="board-edit-version"
              data-keybind="version.edit"
              onclick={() => (editingVersion = true)}
            >
              Edit version
            </button>
            <button
              type="button"
              class="btn btn-primary"
              data-testid="board-mark-complete"
              data-keybind="version.complete"
              onclick={openComplete}
            >
              Mark complete
            </button>
          {/if}
        </div>

        {#if version.completed}
          <p class="banner banner-info readonly-note">
            This version is complete, so its board is read-only. Reopen it to make changes.
          </p>
        {/if}

        {#key version.id}
          <MarkdownField
            value={version.description}
            label="Version notes"
            placeholder="No notes for this version."
            testid="version-description"
            {readonly}
            minHeight="8rem"
            nonce={assetNonce}
            getFresh={() => freshVersionDescription(version!.id)}
            onSave={(md) => saveVersionDescription(version!.id, md)}
          />
        {/key}
      </section>

      {#key version.id}
        <KanbanBoard
          bind:this={kanban}
          keyboard
          {cards}
          {schema}
          {readonly}
          {formFields}
          createDefaults={BOARD_CREATE_DEFAULTS}
          {onCreate}
          {onUpdate}
          {onDelete}
          {cardBadges}
          {dialogBody}
          {dialogActions}
          previewNonce={assetNonce}
          {openCardId}
          onDialogOpen={dialogOpened}
          onDialogClose={dialogClosed}
          columnHeight="auto"
          descriptionLines={3}
          empty="No cards."
        />
      {/key}

      {#if !readonly}
        <details class="unscheduled" data-testid="unscheduled" bind:open={unscheduledOpen}>
          <summary>Unscheduled tasks ({unscheduled.length})</summary>
          {#if unscheduled.length === 0}
            <p class="muted small">Every task in this project is scheduled in a version.</p>
          {:else}
            <ul>
              {#each unscheduled as task (task.id)}
                <li data-testid="unscheduled-task" data-task-id={task.id}>
                  <span class="task-title">{task.title || 'Untitled'}</span>
                  <span class="badge">{typeLabel(task.task_type)}</span>
                  <button
                    type="button"
                    class="btn btn-sm"
                    data-testid="unscheduled-add"
                    onclick={() => void addToVersion(task.id)}
                  >
                    Add to this version
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </details>
      {/if}
    {/if}
  {/if}
</div>

{#if editingVersion && version && !version.completed}
  {#key version.id}
    <EditVersionDialog
      {version}
      {versions}
      nonce={assetNonce}
      getFresh={() => get<Version>('version', version!.id)}
      onSave={(changes) => saveVersionEdit(version!.id, changes)}
      onClose={() => (editingVersion = false)}
    />
  {/key}
{/if}

{#if completing && version}
  <div
    class="backdrop"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget && !completeBusy) completing = null;
    }}
  >
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="complete-title" data-testid="complete-dialog">
      <h2 id="complete-title">Complete version {version.number}?</h2>
      {#if completing.todo + completing.inProgress > 0}
        <p>
          {completing.todo + completing.inProgress}
          {completing.todo + completing.inProgress === 1 ? 'task is' : 'tasks are'} still open
          ({completing.todo} TODO, {completing.inProgress} in progress).
        </p>
        {#if completing.exists}
          <p class="muted small">They can move to version {completing.target}.</p>
        {:else}
          <label class="new-number">
            <span>They can move to a new version:</span>
            <input data-testid="complete-dialog-number" bind:value={completeNumber} />
          </label>
        {/if}
      {:else}
        <p>Every task in this version is done.</p>
      {/if}
      {#if actionError}
        <p class="banner banner-danger" role="alert">{actionError}</p>
      {/if}
      <div class="modal-actions">
        <button
          type="button"
          class="btn"
          data-testid="complete-dialog-cancel"
          disabled={completeBusy}
          onclick={() => (completing = null)}>Cancel</button
        >
        <button
          type="button"
          class="btn"
          class:btn-primary={completing.todo + completing.inProgress === 0}
          data-testid="complete-dialog-anyway"
          disabled={completeBusy}
          onclick={() => void complete(false)}
          >{completing.todo + completing.inProgress > 0 ? 'Complete anyway' : 'Complete'}</button
        >
        {#if completing.todo + completing.inProgress > 0}
          <button
            type="button"
            class="btn btn-primary"
            data-testid="complete-dialog-bump"
            disabled={completeBusy || (!completing.exists && !completeNumber.trim())}
            onclick={() => void complete(true)}
          >
            Bump {completing.todo + completing.inProgress} open
            {completing.todo + completing.inProgress === 1 ? 'task' : 'tasks'} to
            {completing.exists ? completing.target : completeNumber.trim() || '…'} and complete
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .board-page {
    /* Wider than the reading column the other pages use: three columns of
       cards need the room. The negative margins centre it on the page. */
    width: min(94vw, 90rem);
    margin-inline: calc((100% - min(94vw, 90rem)) / 2);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .board-top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding-bottom: var(--space-3);
    border-bottom: 3px double var(--detailed-gold, var(--border-color));
  }

  .board-title {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  .board-title h1 {
    margin: 0;
  }

  .project-picker {
    margin: 0;
  }

  .project-picker select {
    width: auto;
    min-width: 14rem;
    font-weight: 600;
  }

  .sync-pill {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    background: var(--surface-color);
    font-size: var(--font-size-sm);
  }

  .sync-pill.error {
    border-color: var(--color-danger);
    background: var(--color-danger-soft);
  }

  .sync-pill .pending {
    color: var(--text-muted-color);
  }

  .sync-detail {
    margin: 0;
    text-align: right;
  }

  .board-error {
    align-items: center;
    justify-content: space-between;
    margin: 0;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-5);
    border: 1px dashed var(--border-color);
    border-radius: var(--radius-lg);
  }

  .empty p {
    margin: 0;
  }

  .plus {
    display: inline-grid;
    place-items: center;
    width: 1.4em;
    height: 1.4em;
    border-radius: var(--radius-full);
    background: var(--color-primary);
    color: var(--surface-color);
    font-weight: 800;
    line-height: 1;
  }

  .versions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .version-btn {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    background: var(--surface-color);
    color: var(--text-color);
    cursor: pointer;
    font: inherit;
  }

  .version-btn:hover {
    border-color: var(--color-primary);
  }

  .version-btn.selected {
    border-color: var(--color-primary);
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
  }

  .version-btn.current {
    padding: var(--space-2) var(--space-4);
    border-width: 2px;
  }

  .version-btn.current .version-number {
    font-size: var(--font-size-lg);
    font-weight: 800;
  }

  .version-kicker {
    font-size: var(--font-size-sm);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted-color);
  }

  .version-btn.done {
    color: var(--text-muted-color);
  }

  .version-btn.done.selected {
    color: var(--color-primary-strong);
  }

  .version-number {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .new-version {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .new-version input {
    width: 8rem;
    padding: var(--space-1) var(--space-2);
  }

  .completed-toggle {
    margin-left: auto;
  }

  .completed-list {
    list-style: none;
    margin: 0;
    padding: var(--space-2);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    border: 1px dashed var(--border-color);
    border-radius: var(--radius-md);
  }

  .version-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .version-heading {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  .version-heading h2 {
    margin: 0;
  }

  .spacer {
    flex: 1;
  }

  .readonly-note {
    margin: 0;
  }

  .dialog-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .inline-select {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--font-size-sm);
  }

  .inline-select select {
    width: auto;
    padding: var(--space-1) var(--space-2);
  }

  .unscheduled {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    padding: var(--space-2) var(--space-3);
    background: var(--surface-color);
  }

  .unscheduled summary {
    cursor: pointer;
    font-weight: 600;
  }

  .unscheduled ul {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .unscheduled li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .task-title {
    flex: 1;
    min-width: 0;
  }

  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.55);
    display: grid;
    place-items: center;
    z-index: 80;
    padding: var(--space-4);
  }

  .backdrop .modal h2 {
    margin: 0;
    font-size: var(--font-size-xl);
  }

  .new-number {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .new-number input {
    width: 10rem;
  }

  .muted {
    color: var(--text-muted-color);
  }

  .small {
    font-size: var(--font-size-sm);
  }
</style>
