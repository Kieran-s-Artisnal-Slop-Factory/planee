<script lang="ts">
  /**
   * Home (D13): the projects, each with its current version and open work,
   * linking to its board; inline project creation; the raw table pages below.
   *
   * Test hooks (data-testid): home-new-project-name, home-new-project-create,
   * home-project-card (data-project-id), home-project-version,
   * home-project-open.
   */
  import { onMount } from 'svelte';
  import { all } from '../../lib/db/repo';
  import { onChanged } from '../../lib/db/changes';
  import type { Project, Task, Version, VersionTask } from '../../lib/db/types';
  import { href } from '../../lib/paths';
  import { projectLabel } from '../../lib/crud';
  import { SYNC_EVENT, getSyncStatus, type SyncStatus } from '../../lib/sync';
  import { currentVersion } from '../../lib/versions';
  import { createProject } from '../../lib/board/actions';

  interface ProjectSummary {
    project: Project;
    current: Version | undefined;
    open: number;
    updatedAt: string;
  }

  let loading = $state(true);
  let summaries = $state<ProjectSummary[]>([]);
  let counts = $state({ project: 0, version: 0, task: 0, version_task: 0, asset: 0, preferences: 0 });
  let sync: SyncStatus = $state({ lastSyncAt: null, lastError: null, pending: 0 });

  let newName = $state('');
  let creating = $state(false);
  let createError = $state('');

  const latest = (...stamps: (string | undefined)[]) =>
    stamps.reduce<string>((max, at) => (at && at > max ? at : max), '');

  async function load() {
    const [projects, versions, tasks, links, assets, preferences] = await Promise.all([
      all<Project>('project'),
      all<Version>('version'),
      all<Task>('task'),
      all<VersionTask>('version_task'),
      all('asset'),
      all('preferences'),
    ]);
    const liveTasks = new Set(tasks.map((t) => t.id));
    summaries = projects
      .map((project) => {
        const own = versions.filter((v) => v.project === project.id);
        const ownIds = new Set(own.map((v) => v.id));
        const current = currentVersion(own);
        const ownLinks = links.filter((l) => ownIds.has(l.version));
        const open = current
          ? ownLinks.filter(
              (l) =>
                l.version === current.id &&
                liveTasks.has(l.task) &&
                (l.status === 'todo' || l.status === 'in_progress')
            ).length
          : 0;
        const updatedAt = latest(
          project.updated_at,
          ...own.map((v) => v.updated_at),
          ...tasks.filter((t) => t.project === project.id).map((t) => t.updated_at),
          ...ownLinks.map((l) => l.updated_at)
        );
        return { project, current, open, updatedAt };
      })
      .sort((a, b) => projectLabel(a.project).localeCompare(projectLabel(b.project)));
    counts = {
      project: projects.length,
      version: versions.length,
      task: tasks.length,
      version_task: links.length,
      asset: assets.length,
      preferences: preferences.length,
    };
    sync = await getSyncStatus();
    loading = false;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    void load();
    const stop = onChanged('*', () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 50);
    });
    const onSync = () => void getSyncStatus().then((status) => (sync = status));
    window.addEventListener(SYNC_EVENT, onSync);
    return () => {
      stop();
      clearTimeout(timer);
      window.removeEventListener(SYNC_EVENT, onSync);
    };
  });

  async function create(event: SubmitEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    creating = true;
    createError = '';
    try {
      const { project, version } = await createProject(name);
      location.href = href(`/board/?project=${encodeURIComponent(project.id)}&version=${encodeURIComponent(version.id)}`);
    } catch (err) {
      createError = err instanceof Error ? err.message : String(err);
      creating = false;
    }
  }

  const when = (iso: string) => (iso ? new Date(iso).toLocaleString() : '—');
</script>

<div class="page-header home-header">
  <h1>Projects</h1>
  <form class="new-project" onsubmit={create}>
    <input
      data-testid="home-new-project-name"
      placeholder="New project name"
      aria-label="New project name"
      bind:value={newName}
    />
    <button
      type="submit"
      class="btn btn-primary"
      data-testid="home-new-project-create"
      disabled={!newName.trim() || creating}>{creating ? 'Creating…' : 'New project'}</button
    >
  </form>
</div>

{#if createError}
  <p class="banner banner-danger" role="alert">{createError}</p>
{/if}

{#if loading}
  <p class="muted">Loading…</p>
{:else}
  {#if summaries.length === 0}
    <p class="muted empty">No projects yet — name one above to start its board at version 0.1.0.</p>
  {:else}
    <div class="projects">
      {#each summaries as summary (summary.project.id)}
        <a
          class="project-card"
          data-testid="home-project-card"
          data-project-id={summary.project.id}
          href={href(`/board/?project=${encodeURIComponent(summary.project.id)}`)}
        >
          <span class="project-name">{projectLabel(summary.project) || 'Untitled project'}</span>
          <span class="project-version" data-testid="home-project-version">
            {#if summary.current}
              Version {summary.current.number}
            {:else}
              No open version
            {/if}
          </span>
          <span class="project-open" data-testid="home-project-open">
            {summary.open} open {summary.open === 1 ? 'task' : 'tasks'}
          </span>
          <span class="project-updated muted">Updated {when(summary.updatedAt)}</span>
        </a>
      {/each}
    </div>
  {/if}

  <h2 class="tables-heading">Tables</h2>
  <div class="tiles">
    <a class="tile" href={href('/board/')}>
      <span class="count">▦</span>
      <span class="label">Board</span>
    </a>
    <a class="tile" href={href('/project/')}>
      <span class="count">{counts.project}</span>
      <span class="label">Project</span>
    </a>
    <a class="tile" href={href('/version/')}>
      <span class="count">{counts.version}</span>
      <span class="label">Version</span>
    </a>
    <a class="tile" href={href('/task/')}>
      <span class="count">{counts.task}</span>
      <span class="label">Task</span>
    </a>
    <a class="tile" href={href('/version_task/')}>
      <span class="count">{counts.version_task}</span>
      <span class="label">Version task</span>
    </a>
    <a class="tile" href={href('/asset/')}>
      <span class="count">{counts.asset}</span>
      <span class="label">Assets</span>
    </a>
    <a class="tile" href={href('/preferences/')}>
      <span class="count">{counts.preferences}</span>
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
    {#if sync.pending > 0}· {sync.pending} pending{/if}
  </p>
{/if}

<style>
  .home-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .home-header h1 {
    margin: 0;
  }

  .new-project {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }

  .new-project input {
    width: auto;
    min-width: 14rem;
  }

  .empty {
    padding: var(--space-5);
    border: 1px dashed var(--border-color);
    border-radius: var(--radius-lg);
  }

  .projects {
    display: grid;
    gap: var(--space-4);
    grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  }

  .project-card {
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

  .project-card:hover {
    border-color: var(--color-primary);
  }

  .project-name {
    font-size: var(--font-size-lg);
    font-weight: 700;
  }

  .project-version {
    font-weight: 600;
    color: var(--color-primary-strong);
  }

  .project-updated {
    font-size: var(--font-size-sm);
  }

  .tables-heading {
    margin-top: var(--space-6);
    font-size: var(--font-size-lg);
  }

  .tiles {
    display: grid;
    gap: var(--space-4);
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
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

  .muted {
    color: var(--text-muted-color);
  }
</style>
