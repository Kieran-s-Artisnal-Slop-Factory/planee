<script lang="ts">
  /**
   * Ctrl/Cmd+K command palette (D20): the create actions, recent and matching
   * tasks/projects/versions, and the overview pages. Ranking and grouping live
   * in lib/ui/palette.ts (unit-tested); this component loads rows and renders.
   *
   * - Opens on Ctrl+K / Cmd+K from anywhere — a capture-phase listener on
   *   window, so it wins over inputs, CodeMirror and Milkdown (whose own
   *   Mod-K never sees the key) — and on `openPalette()` (OPEN_PALETTE_EVENT).
   * - Rows are read (repo `all`) each time it opens and kept while it is open.
   * - Up/Down move the highlight (wrapping), Enter activates, Escape or a
   *   backdrop click closes. Hovering highlights.
   * - Actions close the palette and `openCreate` (the FAB's dialogs); tasks go
   *   to `resolveTaskHref`, projects and versions to their board, pages to
   *   their path. Each action row shows its keybind (lib/ui/keymap.ts): the
   *   browser-safe fallback (Alt+N…) unless planee runs as an installed app.
   * - While a markdown editor is open (lib/ui/commands.ts
   *   `canOpenEditorTool`), an Editor group offers its four tools — "Insert a
   *   formula / diagram / drawing / footnote" — each with this device's key
   *   (lib/markdown/shortcuts.ts). Activating one closes the palette, hands
   *   focus back, and `openEditorTool` opens it in the most recently focused
   *   editor. (10c-E, D22)
   *
   * z-index 90: above the FAB's create dialog (75) and the card dialog (70).
   *
   * Test hooks: palette (the dialog), palette-input, palette-results,
   * palette-item (data-kind, data-id, aria-selected on the highlight),
   * palette-item-keys (the chord hint), palette-empty.
   */
  import { onMount, tick } from 'svelte';
  import { href } from '../lib/paths';
  import type { Project, Task, Version } from '../lib/db/types';
  import {
    OPEN_PALETTE_EVENT,
    canOpenEditorTool,
    openCreate,
    openEditorTool,
    type CreateKind,
    type EditorToolId,
  } from '../lib/ui/commands';
  import { chordLabel, isInstalledApp } from '../lib/ui/keys';
  import { keybind } from '../lib/ui/keymap';
  import { TOOLS, loadShortcuts, shortcutLabel } from '../lib/markdown/shortcuts';
  import { projectHref, resolveTaskHref, versionHref } from '../lib/ui/links';
  import { recentViews } from '../lib/ui/recent';
  import {
    buildPalette,
    flatten,
    moveHighlight,
    type PaletteData,
    type PaletteItem,
    type PaletteTool,
  } from '../lib/ui/palette';

  let {
    /** Offer the create actions (false where there is no FAB to fulfil them, e.g. onboarding). */
    actions = true,
  }: { actions?: boolean } = $props();

  const uid = $props.id();
  const EMPTY: PaletteData = { tasks: [], projects: [], versions: [], recent: [] };

  let isOpen = $state(false);
  let query = $state('');
  let data = $state.raw<PaletteData>(EMPTY);
  let loading = $state(false);
  let highlight = $state(0);
  let busy = $state(false);
  let inputEl: HTMLInputElement | null = $state(null);
  let listEl: HTMLDivElement | null = $state(null);
  let returnFocus: HTMLElement | null = null;
  let pressedBackdrop = false;
  /** Guards a load that finishes after the palette was closed (and maybe reopened). */
  let loadToken = 0;

  /** The editor's tools, when an editor is open to receive them (read on open). */
  let tools = $state.raw<PaletteTool[]>([]);
  /** Each create action's chord, as shown (read on open). */
  let actionKeys = $state.raw<Partial<Record<CreateKind, string>>>({});

  const ACTION_KEYBINDS: Record<CreateKind, string> = {
    task: 'create.task',
    version: 'create.version',
    project: 'create.project',
  };

  /** The chord to show for an action: the fallback in a browser tab, the primary in an installed app. */
  function actionChords(): Partial<Record<CreateKind, string>> {
    const installed = isInstalledApp();
    const out: Partial<Record<CreateKind, string>> = {};
    for (const [kind, id] of Object.entries(ACTION_KEYBINDS) as [CreateKind, string][]) {
      try {
        const bind = keybind(id);
        const chord = installed ? bind.keys[0] : (bind.fallback ?? bind.keys[0]);
        if (chord) out[kind] = chordLabel(chord);
      } catch {
        // Not in the keymap (yet): no hint.
      }
    }
    return out;
  }

  function editorTools(): PaletteTool[] {
    if (!canOpenEditorTool()) return [];
    const keys = loadShortcuts();
    return TOOLS.map((tool) => ({
      id: tool.id,
      label: tool.command,
      hint: tool.hint,
      keys: shortcutLabel(keys[tool.id]) || undefined,
      icon: tool.glyph,
    }));
  }

  const groups = $derived(
    buildPalette(query, { ...data, tools, actionKeys }).map((g) =>
      g.name === 'Actions' && !actions ? { ...g, items: [] } : g
    ).filter((g) => g.items.length > 0)
  );
  const items = $derived(flatten(groups));

  $effect(() => {
    void query;
    highlight = 0;
  });

  $effect(() => {
    // Keep the highlighted row visible while moving with the keyboard.
    const index = highlight;
    if (!isOpen || !listEl) return;
    listEl.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  });

  async function load() {
    const token = ++loadToken;
    loading = true;
    try {
      const { all } = await import('../lib/db/repo');
      const [tasks, projects, versions] = await Promise.all([
        all<Task>('task'),
        all<Project>('project'),
        all<Version>('version'),
      ]);
      if (token !== loadToken) return;
      data = {
        tasks,
        projects,
        versions,
        recent: [
          ...recentViews('task').map((v) => ({ kind: 'task' as const, ...v })),
          ...recentViews('project').map((v) => ({ kind: 'project' as const, ...v })),
          ...recentViews('version').map((v) => ({ kind: 'version' as const, ...v })),
        ],
      };
    } catch {
      // No database (blocked storage): actions and pages still work.
    } finally {
      if (token === loadToken) loading = false;
    }
  }

  async function open() {
    if (isOpen) {
      inputEl?.focus();
      inputEl?.select();
      return;
    }
    const active = document.activeElement;
    returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    query = '';
    highlight = 0;
    busy = false;
    tools = editorTools();
    actionKeys = actionChords();
    isOpen = true;
    void load();
    await tick();
    inputEl?.focus();
  }

  function close({ restoreFocus = true } = {}) {
    if (!isOpen) return;
    isOpen = false;
    loadToken++;
    data = EMPTY;
    tools = [];
    loading = false;
    const target = returnFocus;
    returnFocus = null;
    if (restoreFocus && target?.isConnected) target.focus({ preventScroll: true });
  }

  async function activate(item: PaletteItem | undefined) {
    if (!item || busy) return;
    switch (item.kind) {
      case 'action':
        close({ restoreFocus: false });
        openCreate(item.id as CreateKind);
        return;
      case 'tool':
        // Focus goes back to the editor first: the tool dialog remembers
        // where it came from and returns there when it closes.
        close();
        openEditorTool(item.id as EditorToolId);
        return;
      case 'page':
        close({ restoreFocus: false });
        location.href = href(item.id);
        return;
      case 'project':
        close({ restoreFocus: false });
        location.href = projectHref(item.id);
        return;
      case 'version': {
        const version = data.versions.find((v) => v.id === item.id);
        close({ restoreFocus: false });
        if (version) location.href = versionHref(version);
        return;
      }
      case 'task': {
        busy = true;
        try {
          const target = await resolveTaskHref(item.id);
          close({ restoreFocus: false });
          location.href = target;
        } finally {
          busy = false;
        }
        return;
      }
    }
  }

  function onInputKey(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      highlight = moveHighlight(highlight, event.key === 'ArrowDown' ? 1 : -1, items.length);
    } else if (event.key === 'Home' && event.ctrlKey) {
      event.preventDefault();
      highlight = items.length ? 0 : -1;
    } else if (event.key === 'End' && event.ctrlKey) {
      event.preventDefault();
      highlight = items.length - 1;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void activate(items[highlight]);
    }
  }

  /** Capture phase on window: runs before any editor or input sees the key. */
  function onCaptureKey(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      event.stopPropagation();
      void open();
      return;
    }
    if (isOpen && event.key === 'Escape') {
      // Ours alone: nothing underneath (the FAB dialog, a card dialog, an
      // editor) should also react to this Escape.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  onMount(() => {
    const onOpenEvent = () => void open();
    window.addEventListener('keydown', onCaptureKey, { capture: true });
    window.addEventListener(OPEN_PALETTE_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener('keydown', onCaptureKey, { capture: true });
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpenEvent);
    };
  });

  const KIND_ICON: Record<PaletteItem['kind'], string> = {
    action: '+',
    tool: '✎',
    task: '☐',
    project: '▦',
    version: '⑂',
    page: '→',
  };

  /** The flat index of each item, for highlight bookkeeping inside grouped markup. */
  const indexOf = (item: PaletteItem) => items.indexOf(item);
</script>

{#if isOpen}
  <div
    class="backdrop"
    role="presentation"
    onpointerdown={(event) => (pressedBackdrop = event.target === event.currentTarget)}
    onclick={(event) => {
      if (pressedBackdrop && event.target === event.currentTarget) close();
      pressedBackdrop = false;
    }}
  >
    <dialog open class="palette" data-testid="palette" aria-modal="true" aria-label="Command palette">
      <input
        bind:this={inputEl}
        bind:value={query}
        class="palette-input"
        data-testid="palette-input"
        type="text"
        placeholder="Search tasks, projects, versions, pages… or create"
        autocomplete="off"
        spellcheck="false"
        role="combobox"
        aria-expanded="true"
        aria-controls="{uid}-results"
        aria-activedescendant={highlight >= 0 && items[highlight] ? `${uid}-item-${highlight}` : undefined}
        onkeydown={onInputKey}
      />
      <div
        class="results"
        id="{uid}-results"
        role="listbox"
        aria-label="Results"
        data-testid="palette-results"
        bind:this={listEl}
      >
        {#each groups as group (group.name)}
          <div class="group" role="group" aria-labelledby="{uid}-group-{group.name}">
            <div class="group-name" id="{uid}-group-{group.name}">{group.name}</div>
            {#each group.items as item (item.kind + ':' + item.id)}
              {@const index = indexOf(item)}
              <div
                class="item"
                class:active={index === highlight}
                id="{uid}-item-{index}"
                role="option"
                tabindex="-1"
                aria-selected={index === highlight}
                data-testid="palette-item"
                data-kind={item.kind}
                data-id={item.id}
                data-index={index}
                onpointermove={() => {
                  if (highlight !== index) highlight = index;
                }}
                onpointerdown={(event) => event.preventDefault()}
                onclick={() => void activate(item)}
                onkeydown={() => {}}
              >
                <span class="kind" aria-hidden="true">{item.icon ?? KIND_ICON[item.kind]}</span>
                <span class="label">{item.label}</span>
                {#if item.hint}<span class="hint-text">{item.hint}</span>{/if}
                {#if item.keys}<kbd class="item-keys" data-testid="palette-item-keys">{item.keys}</kbd>{/if}
              </div>
            {/each}
          </div>
        {/each}
        {#if items.length === 0}
          <p class="empty" data-testid="palette-empty">{loading ? 'Loading…' : 'No matches.'}</p>
        {/if}
      </div>
      <div class="footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>Enter</kbd> open</span>
        <span><kbd>Esc</kbd> close</span>
        {#if loading || busy}<span class="loading">Loading…</span>{/if}
      </div>
    </dialog>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: min(12vh, 6rem) var(--space-4) var(--space-4);
    background: rgb(0 0 0 / 0.45);
  }

  .palette {
    position: relative;
    inset: auto;
    margin: 0;
    width: min(40rem, 100%);
    max-height: min(70vh, 36rem);
    display: flex;
    flex-direction: column;
    padding: 0;
    overflow: hidden;
    color: var(--text-color);
    background: var(--surface-raised-color);
    border: 3px double var(--detailed-gold, var(--border-color));
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-2);
  }

  .palette-input {
    flex: none;
    width: 100%;
    font-size: var(--font-size-lg);
    padding: var(--space-3) var(--space-4);
    border: none;
    border-bottom: 1px solid var(--border-color);
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  .palette-input:focus-visible {
    outline: none;
    box-shadow: none;
  }

  .results {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-2) var(--space-2) var(--space-3);
  }

  .group + .group {
    margin-top: var(--space-2);
  }

  .group-name {
    padding: var(--space-1) var(--space-2);
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-muted-color);
  }

  .item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    cursor: pointer;
    user-select: none;
  }

  .item.active {
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
    box-shadow: inset 3px 0 0 var(--color-primary);
  }

  .kind {
    flex: none;
    width: 1.25rem;
    text-align: center;
    color: var(--color-primary);
  }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hint-text {
    flex: none;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .item-keys {
    flex: none;
    font-size: 0.8em;
    font-weight: 400;
    opacity: 0.8;
  }

  .empty {
    margin: 0;
    padding: var(--space-4);
    text-align: center;
    color: var(--text-muted-color);
  }

  .footer {
    flex: none;
    display: flex;
    gap: var(--space-4);
    padding: var(--space-2) var(--space-4);
    border-top: 1px solid var(--border-color);
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .footer kbd + kbd {
    margin-left: 0.2em;
  }

  .loading {
    margin-left: auto;
  }

  @media (max-width: 40rem) {
    .footer {
      display: none;
    }
  }

  @media print {
    .backdrop {
      display: none;
    }
  }
</style>
