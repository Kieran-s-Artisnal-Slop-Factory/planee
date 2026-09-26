<script lang="ts">
  /**
   * The recent-issues strip on Home (D16, D17): the tasks most recently added,
   * updated or viewed on this device, across every project. The ranking lives
   * in lib/ui/recentIssues.ts; this only loads rows and renders.
   *
   * How many: the synced `preferences.recent_issues_count` (default 6; 0 hides
   * the strip). Refreshes on the change feed, on views recorded in this tab
   * (RECENT_VIEWS_EVENT) or another one (storage event), and once a minute so
   * "5m ago" keeps moving.
   *
   * Clicking an item calls `onOpen(taskId, href)`; the href (links.taskHrefFrom)
   * is also the anchor's, so a middle-click or ctrl-click opens a new tab.
   *
   * Only reads — never writes a row.
   *
   * Test hooks (data-testid): recent-issues, recent-issue (data-task-id,
   * data-reason = added|updated|viewed), recent-issue-title,
   * recent-issue-project, recent-issue-version, recent-issue-status,
   * recent-issue-type, recent-issue-when.
   */
  import { onMount } from 'svelte';
  import { all, getSingleton } from '../../lib/db/repo';
  import { onChanged } from '../../lib/db/changes';
  import { DEFAULT_RECENT_ISSUES_COUNT } from '../../lib/db/types';
  import type { Preferences, Project, Task, Version, VersionTask } from '../../lib/db/types';
  import { taskHrefFrom } from '../../lib/ui/links';
  import { MAX_VIEWS_PER_KIND, RECENT_VIEWS_EVENT, RECENT_VIEWS_KEY, recentViews } from '../../lib/ui/recent';
  import {
    TASK_TYPE_TONES,
    activityLabel,
    recentIssues,
    recentIssuesCount,
    statusLabel,
    statusTone,
    taskTypeLabel,
    type RecentIssue,
  } from '../../lib/ui/recentIssues';

  let { onOpen }: { onOpen: (taskId: string, href: string, event: MouseEvent) => void } = $props();

  const WATCHED = ['project', 'version', 'task', 'version_task', 'preferences'];

  let items = $state<(RecentIssue & { href: string })[]>([]);
  let now = $state(Date.now());

  let seq = 0;
  async function load() {
    const mine = ++seq;
    try {
      const [tasks, links, versions, projects, preferences] = await Promise.all([
        all<Task>('task'),
        all<VersionTask>('version_task'),
        all<Version>('version'),
        all<Project>('project'),
        getSingleton<Preferences>('preferences'),
      ]);
      if (mine !== seq) return;
      const limit = recentIssuesCount(preferences?.recent_issues_count, DEFAULT_RECENT_ISSUES_COUNT);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      items = recentIssues({
        tasks,
        links,
        versions,
        projects,
        views: recentViews('task', MAX_VIEWS_PER_KIND),
        limit,
      }).map((item) => ({ ...item, href: taskHrefFrom(byId.get(item.taskId)!, links, versions) }));
      now = Date.now();
    } catch {
      // IndexedDB unavailable: the strip is a nicety, the board reports the problem.
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 50);
  }

  onMount(() => {
    void load();
    const stop = onChanged(WATCHED, schedule);
    const onViews = (event: Event) => {
      const kind = (event as CustomEvent<{ kind?: string }>).detail?.kind;
      if (!kind || kind === 'task') schedule();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === RECENT_VIEWS_KEY) schedule();
    };
    window.addEventListener(RECENT_VIEWS_EVENT, onViews);
    window.addEventListener('storage', onStorage);
    const tick = setInterval(() => (now = Date.now()), 60_000);
    return () => {
      stop();
      clearTimeout(timer);
      clearInterval(tick);
      window.removeEventListener(RECENT_VIEWS_EVENT, onViews);
      window.removeEventListener('storage', onStorage);
    };
  });

  function click(event: MouseEvent, item: RecentIssue & { href: string }) {
    // Let the browser handle new-tab/new-window clicks on the real link.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(item.taskId, item.href, event);
  }
</script>

{#if items.length > 0}
  <section class="recent" data-testid="recent-issues" aria-labelledby="recent-issues-heading">
    <h2 id="recent-issues-heading">Recent issues</h2>
    <ul>
      {#each items as item (item.taskId)}
        <li>
          <a
            class="issue"
            href={item.href}
            data-testid="recent-issue"
            data-task-id={item.taskId}
            data-reason={item.reason}
            onclick={(event) => click(event, item)}
          >
            <span class="title" data-testid="recent-issue-title" title={item.title}>{item.title}</span>
            <span class="where">
              <span class="project" data-testid="recent-issue-project" title={item.projectName}>{item.projectName}</span>
              <span aria-hidden="true">·</span>
              <span class="version" data-testid="recent-issue-version">
                {item.version ? item.version.number : 'Unscheduled'}
              </span>
            </span>
            <span class="pills">
              {#if item.status}
                <span class="pill tone-{statusTone(item.status)}" data-testid="recent-issue-status" data-status={item.status}
                  >{statusLabel(item.status)}</span
                >
              {/if}
              <span class="pill tone-{TASK_TYPE_TONES[item.taskType] ?? 'muted'}" data-testid="recent-issue-type"
                >{taskTypeLabel(item.taskType)}</span
              >
            </span>
            <time class="when" datetime={item.activityAt} data-testid="recent-issue-when"
              >{activityLabel(item, now)}</time
            >
          </a>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .recent {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }

  h2 {
    margin: 0;
    font-size: var(--font-size-sm);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted-color);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-2);
    /* One row of six on a laptop; wraps to fewer per row as the page narrows. */
    grid-template-columns: repeat(auto-fill, minmax(12.5rem, 1fr));
  }

  li {
    min-width: 0;
  }

  .issue {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    height: 100%;
    box-sizing: border-box;
    padding: var(--space-2) var(--space-3);
    background: var(--surface-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    color: var(--text-color);
    text-decoration: none;
    font-size: var(--font-size-sm);
    line-height: 1.35;
  }

  .issue:hover,
  .issue:focus-visible {
    border-color: var(--color-primary);
  }

  .title {
    font-weight: 700;
    font-size: var(--font-size-base);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .where {
    display: flex;
    gap: var(--space-1);
    min-width: 0;
    color: var(--text-muted-color);
  }

  .project {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .version {
    flex: none;
    font-variant-numeric: tabular-nums;
  }

  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .pill {
    display: inline-flex;
    align-items: center;
    padding: 0 var(--space-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    background: var(--surface-raised-color);
    color: var(--text-muted-color);
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .pill.tone-info {
    color: var(--color-info);
    border-color: var(--color-info);
    background: var(--color-info-soft);
  }

  .pill.tone-success {
    color: var(--color-success);
    border-color: var(--color-success);
    background: var(--color-success-soft);
  }

  .pill.tone-warning {
    color: var(--color-warning);
    border-color: var(--color-warning);
    background: var(--color-warning-soft);
  }

  .pill.tone-danger {
    color: var(--color-danger);
    border-color: var(--color-danger);
    background: var(--color-danger-soft);
  }

  .pill.tone-primary {
    color: var(--color-primary-strong);
    border-color: var(--color-primary);
    background: var(--color-primary-soft);
  }

  .when {
    color: var(--text-muted-color);
    font-size: 0.75rem;
  }
</style>
