<script lang="ts">
  /**
   * The floating "+" (D19): New Task / New Version / New Project on every page.
   *
   * Each item opens a dialog holding the matching create form from
   * components/forms. Task and Version prefill from the board context
   * (links.ts currentBoardContext: the URL's ?project/&version on Home, else
   * the last board selection). The command palette opens the same dialogs
   * through `openCreate` (commands.ts OPEN_CREATE_EVENT).
   *
   * Keys (lib/ui/keybinds.ts, registered here so a page without the FAB —
   * onboarding — has no create keys): Ctrl+Enter opens the menu with its first
   * item focused (also `openFab()`, OPEN_FAB_EVENT); Ctrl+N / Alt+N, Ctrl+Shift+P
   * / Alt+Shift+P and Ctrl+Shift+V open New Task / Project / Version.
   * `openCreate(kind, prefill)` may carry the board's own project, version and
   * a New Task status (Ctrl+1/2/3, D26) instead of the board context.
   *
   * After creating: a project or version navigates to its board; a task shows
   * a toast with an Open link (the board, if showing that version, already
   * updated through the change feed).
   *
   * The dialog is a non-modal `<dialog open>` rather than a `role="dialog"`
   * div: MarkdownField ignores keys whose target sits inside `[role="dialog"]`
   * (those belong to the editor's own diagram/drawing/footnote dialogs), so a
   * role attribute here would switch off Ctrl+S/Escape in the forms' editors.
   * Escape and a backdrop click close it — never while a markdown field in it
   * is editing, so unsaved text is not thrown away.
   *
   * Stacking: FAB and menu z 50 (below the board's drag ghost at 60), toast
   * z 55, dialog backdrop z 75 (above the card dialog at 70). The markdown
   * editor's sub-dialogs (z 70) render INSIDE this dialog's stacking context,
   * so they still paint above the form. The command palette is z 90.
   *
   * Test hooks: fab, fab-menu, fab-new-task, fab-new-version, fab-new-project,
   * create-dialog (data-kind), create-dialog-close, toast, toast-open,
   * toast-close.
   */
  import { onMount, tick } from 'svelte';
  import type { Project, Task, Version } from '../lib/db/types';
  import type { StatusTypeKey } from '../lib/db/types';
  import {
    OPEN_CREATE_EVENT,
    OPEN_FAB_EVENT,
    type CreateKind,
    type CreatePrefill,
    type OpenCreateDetail,
  } from '../lib/ui/commands';
  import { registerKeyHandlers } from '../lib/ui/keybinds';
  import { currentBoardContext, projectHref, resolveTaskHref, versionHref } from '../lib/ui/links';
  import ProjectCreateForm from './forms/ProjectCreateForm.svelte';
  import VersionCreateForm from './forms/VersionCreateForm.svelte';
  import TaskCreateForm from './forms/TaskCreateForm.svelte';
  import { isMarkdownEditing } from './forms/markdownEditing';

  const ITEMS: { kind: CreateKind; label: string; icon: string }[] = [
    { kind: 'task', label: 'New Task', icon: '☐' },
    { kind: 'version', label: 'New Version', icon: '⑂' },
    { kind: 'project', label: 'New Project', icon: '▦' },
  ];
  const TITLES: Record<CreateKind, string> = { task: 'New task', version: 'New version', project: 'New project' };
  const TOAST_MS = 8000;

  const uid = $props.id();
  let menuOpen = $state(false);
  let kind: CreateKind | null = $state(null);
  /** Re-keys the form so every open starts from a clean draft. */
  let openCount = $state(0);
  let context = $state<{ project: string | null; version: string | null; status: StatusTypeKey }>({
    project: null,
    version: null,
    status: 'todo',
  });
  let toast = $state<{ title: string; href: string } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  let fabEl: HTMLButtonElement | null = $state(null);
  let menuEl: HTMLDivElement | null = $state(null);
  let dialogEl: HTMLDialogElement | null = $state(null);
  let returnFocus: HTMLElement | null = null;
  let pressedBackdrop = false;

  async function toggleMenu() {
    menuOpen = !menuOpen;
    if (menuOpen) {
      await tick();
      menuEl?.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }

  /** Open the menu (or bring focus back into it) with its first item focused. */
  async function openMenu() {
    if (kind) return;
    menuOpen = true;
    await tick();
    menuEl?.querySelector<HTMLButtonElement>('button')?.focus();
  }

  function closeMenu(focusFab = false) {
    menuOpen = false;
    if (focusFab) fabEl?.focus();
  }

  function open(next: CreateKind, prefill?: CreatePrefill) {
    if (kind && isMarkdownEditing(dialogEl) && !confirm('Discard the form you have open?')) return;
    if (!kind) {
      const active = document.activeElement;
      // Not a menu item: the menu is about to close, taking it with it.
      returnFocus =
        active instanceof HTMLElement && active !== document.body && !menuEl?.contains(active) ? active : fabEl;
    }
    menuOpen = false;
    // The board's own project/version when it passed them (Ctrl+1/2/3), else the board context.
    const board =
      prefill?.project !== undefined
        ? { project: prefill.project ?? null, version: prefill.version ?? null }
        : currentBoardContext();
    context = { ...board, status: prefill?.status ?? 'todo' };
    kind = next;
    openCount++;
  }

  function close() {
    if (!kind) return;
    kind = null;
    const target = returnFocus?.isConnected ? returnFocus : fabEl;
    returnFocus = null;
    target?.focus({ preventScroll: true });
  }

  /** Close unless a markdown field inside is mid-edit (its own Cancel/Escape handles that). */
  function requestClose() {
    if (isMarkdownEditing(dialogEl)) return;
    close();
  }

  function showToast(title: string, href: string) {
    clearTimeout(toastTimer);
    toast = { title, href };
    toastTimer = setTimeout(() => (toast = null), TOAST_MS);
  }

  function projectCreated(project: Project) {
    close();
    location.href = projectHref(project.id);
  }

  function versionCreated(version: Version) {
    close();
    location.href = versionHref(version);
  }

  async function taskCreated(task: Task) {
    close();
    showToast(task.title, await resolveTaskHref(task.id));
  }

  function onMenuKey(event: KeyboardEvent) {
    const buttons = [...(menuEl?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(at + delta + buttons.length) % buttons.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    } else if (event.key === 'Tab') {
      closeMenu();
    }
  }

  function onWindowKey(event: KeyboardEvent) {
    // Escape already handled (a markdown editor cancelling, a completion popup
    // closing, the palette) is not ours.
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (kind) {
      if (isMarkdownEditing(dialogEl)) return;
      event.preventDefault();
      close();
    } else if (menuOpen) {
      closeMenu(true);
    }
  }

  function onWindowPointer(event: PointerEvent) {
    if (!menuOpen) return;
    const target = event.target as Node | null;
    if (target && (menuEl?.contains(target) || fabEl?.contains(target))) return;
    closeMenu();
  }

  onMount(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenCreateDetail>).detail;
      if (detail && (detail.kind === 'task' || detail.kind === 'version' || detail.kind === 'project')) {
        open(detail.kind, detail.prefill);
      }
    };
    const onOpenFab = () => void openMenu();
    window.addEventListener(OPEN_CREATE_EVENT, onOpen);
    window.addEventListener(OPEN_FAB_EVENT, onOpenFab);
    const unregister = registerKeyHandlers('global', {
      'fab.open': () => void openMenu(),
      'create.task': () => open('task'),
      'create.project': () => open('project'),
      'create.version': () => open('version'),
    });
    return () => {
      window.removeEventListener(OPEN_CREATE_EVENT, onOpen);
      window.removeEventListener(OPEN_FAB_EVENT, onOpenFab);
      unregister();
      clearTimeout(toastTimer);
    };
  });
</script>

<svelte:window onkeydown={onWindowKey} onpointerdown={onWindowPointer} />

<div class="fab-root">
  {#if toast}
    <div class="toast" data-testid="toast" role="status">
      <span class="toast-text">Task created{toast.title ? ` — ${toast.title}` : ''}</span>
      <a class="btn btn-sm btn-primary" data-testid="toast-open" href={toast.href}>Open</a>
      <button
        type="button"
        class="toast-close"
        data-testid="toast-close"
        aria-label="Dismiss"
        onclick={() => {
          clearTimeout(toastTimer);
          toast = null;
        }}>×</button
      >
    </div>
  {/if}

  {#if menuOpen}
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div
      class="fab-menu"
      id="{uid}-menu"
      role="menu"
      aria-label="Create"
      data-testid="fab-menu"
      bind:this={menuEl}
      onkeydown={onMenuKey}
    >
      {#each ITEMS as item (item.kind)}
        <button
          type="button"
          role="menuitem"
          data-testid="fab-new-{item.kind}"
          data-keybind="create.{item.kind}@beside"
          onclick={() => open(item.kind)}
        >
          <span class="icon" aria-hidden="true">{item.icon}</span>
          {item.label}
        </button>
      {/each}
    </div>
  {/if}

  <button
    type="button"
    class="fab"
    class:open={menuOpen}
    data-testid="fab"
    data-keybind="fab.open@beside"
    aria-label="Create…"
    title="Create a task, version or project"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    aria-controls={menuOpen ? `${uid}-menu` : undefined}
    bind:this={fabEl}
    onclick={toggleMenu}
    onkeydown={(event) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        if (!menuOpen) void toggleMenu();
      }
    }}
  >
    <span aria-hidden="true">+</span>
  </button>
</div>

{#if kind}
  <div
    class="backdrop"
    role="presentation"
    onpointerdown={(event) => (pressedBackdrop = event.target === event.currentTarget)}
    onclick={(event) => {
      if (pressedBackdrop && event.target === event.currentTarget) requestClose();
      pressedBackdrop = false;
    }}
  >
    <dialog
      open
      class="modal create-dialog"
      data-testid="create-dialog"
      data-kind={kind}
      aria-modal="true"
      aria-labelledby="{uid}-title"
      bind:this={dialogEl}
    >
      <div class="head">
        <h2 id="{uid}-title">{TITLES[kind]}</h2>
        <button type="button" class="close" data-testid="create-dialog-close" aria-label="Close" onclick={requestClose}
          >×</button
        >
      </div>
      <div class="body">
        {#key openCount}
          {#if kind === 'task'}
            <TaskCreateForm
              autofocus
              initialProject={context.project}
              initialVersion={context.version}
              initialStatus={context.status}
              onCreated={taskCreated}
              onCancel={requestClose}
            />
          {:else if kind === 'version'}
            <VersionCreateForm autofocus initialProject={context.project} onCreated={versionCreated} onCancel={requestClose} />
          {:else}
            <ProjectCreateForm autofocus onCreated={projectCreated} onCancel={requestClose} />
          {/if}
        {/key}
      </div>
    </dialog>
  </div>
{/if}

<style>
  .fab-root {
    position: fixed;
    right: max(var(--space-5), env(safe-area-inset-right));
    bottom: max(var(--space-5), env(safe-area-inset-bottom));
    z-index: 50;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-3);
    pointer-events: none;
  }

  .fab-root > :global(*) {
    pointer-events: auto;
  }

  .fab {
    width: 3.5rem;
    height: 3.5rem;
    border-radius: var(--radius-full);
    border: 1px solid var(--color-primary);
    background: var(--color-primary);
    color: var(--color-on-primary);
    box-shadow: var(--shadow-2), inset 0 0 0 2px var(--color-primary), inset 0 0 0 3px var(--color-on-primary);
    font-size: 2rem;
    line-height: 1;
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: background-color 120ms, transform 160ms;
  }

  .fab span {
    display: block;
    transition: transform 160ms;
    margin-top: -0.1em;
  }

  .fab:hover {
    background: var(--color-primary-strong);
  }

  .fab.open span {
    transform: rotate(45deg);
  }

  .fab:focus-visible {
    outline: 2px solid var(--detailed-gold, var(--color-primary));
    outline-offset: 3px;
  }

  .fab-menu {
    display: flex;
    flex-direction: column;
    min-width: 12rem;
    padding: var(--space-1);
    background: var(--surface-raised-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-2);
  }

  .fab-menu button {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-color);
    font: inherit;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }

  .fab-menu button:hover,
  .fab-menu button:focus-visible {
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
    outline: none;
  }

  .icon {
    width: 1.25rem;
    text-align: center;
    color: var(--color-primary);
  }

  .toast {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    max-width: min(26rem, calc(100vw - 2 * var(--space-5)));
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
    background: var(--surface-raised-color);
    color: var(--text-color);
    border: 1px solid var(--border-color);
    border-left: 3px solid var(--color-success, var(--color-primary));
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-2);
    z-index: 55;
  }

  .toast-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .toast-close,
  .close {
    border: none;
    background: none;
    color: var(--text-muted-color);
    font-size: var(--font-size-xl);
    line-height: 1;
    cursor: pointer;
    padding: 0 var(--space-2);
  }

  .toast-close:hover,
  .close:hover {
    color: var(--text-color);
  }

  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 75;
    display: grid;
    place-items: center;
    padding: var(--space-4);
    background: rgb(0 0 0 / 0.55);
  }

  /* A non-modal <dialog open>: undo the UA's absolute centring, keep the
     theme's .modal look. No transform here — the editor's own dialogs are
     position: fixed inside it and must stay relative to the viewport. */
  .create-dialog {
    position: relative;
    inset: auto;
    margin: 0;
    width: min(44rem, 100%);
    max-height: calc(100vh - 2 * var(--space-4));
    max-height: calc(100dvh - 2 * var(--space-4));
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5) var(--space-5);
  }

  .create-dialog > :global(*) {
    margin-top: 0;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .head h2 {
    margin: 0;
    font-size: var(--font-size-xl);
  }

  @media (max-width: 40rem) {
    .fab-root {
      right: var(--space-4);
      bottom: var(--space-4);
    }
  }

  @media print {
    .fab-root,
    .backdrop {
      display: none;
    }
  }
</style>
