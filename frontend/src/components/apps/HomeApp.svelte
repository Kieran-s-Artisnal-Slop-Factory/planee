<script lang="ts">
  /**
   * Home IS the board (D17): the recent-issues strip above the full board.
   *
   * The board logic lives once, in components/board/Board.svelte (URL
   * handling, `?task=` deep links, views, sync pill — see its header). Creating
   * projects, versions and tasks is the FAB's job (D19); the board's empty
   * state points there.
   *
   * A recent issue whose link stays on this page (`/?project&version&task`)
   * re-targets the board in place; anything else (an unscheduled task's
   * `/task/?edit=`) is a normal navigation.
   *
   * Test hooks: see Board.svelte and RecentIssues.svelte.
   */
  import Board from '../board/Board.svelte';
  import RecentIssues from '../board/RecentIssues.svelte';
  import { isPath } from '../../lib/paths';
  import { resolveTaskHref } from '../../lib/ui/links';

  let board = $state<ReturnType<typeof Board>>();

  async function openIssue(taskId: string, fallbackHref: string) {
    let target = fallbackHref;
    try {
      target = await resolveTaskHref(taskId);
    } catch {
      // IndexedDB hiccup: the href the strip computed is still a good answer.
    }
    const url = new URL(target, location.href);
    if (board && url.origin === location.origin && isPath(url.pathname, '/')) {
      board.openTarget({
        project: url.searchParams.get('project'),
        version: url.searchParams.get('version'),
        task: url.searchParams.get('task'),
      });
      return;
    }
    location.href = url.href;
  }
</script>

<div class="home">
  <RecentIssues onOpen={(taskId, href) => void openIssue(taskId, href)} />
  <Board bind:this={board} />
</div>

<style>
  .home {
    /* The board's wide column, so the strip lines up with it. */
    width: min(94vw, 90rem);
    margin-inline: calc((100% - min(94vw, 90rem)) / 2);
  }
</style>
