<!-- Ported from retoken (af25bc6) -->
<script lang="ts">
  /**
   * One card. Presentational: it reports what the reader did and is told what
   * state it is in, so the board owns every decision about dragging and
   * storage.
   *
   * The description is **rendered markdown at rest** and a textarea behind the
   * pencil — which is why a card can hold a checklist, a code fence or a link
   * and still read as a card. It is clamped to a few lines with a toggle, and
   * the toggle only appears when there is something hidden (measured, because
   * asking a paragraph how tall it would be is the only way to know). The
   * title opens the card in full, where nothing is clamped.
   *
   * `focusable` (planee's keyboard model, D23) makes the card itself a focus
   * target (tabindex -1, a visible ring): the board moves focus between cards
   * and the page's keybinds act on the focused one. Enter on the focused card
   * opens it in full, like its title. `keybinds` goes on the root as
   * `data-keybind` for the Ctrl overlay's badges.
   */
  import { tick, type Snippet } from 'svelte';
  import CardForm from './CardForm.svelte';
  import CardDescription from './CardDescription.svelte';
  import { fieldsOf, type Entry, type PatchFields } from '../../lib/kanban/board';
  import { dueState, formatDue, formatDueFull } from '../../lib/kanban/dates';
  import {
    priorityById,
    type CardRecord,
    type FieldRole,
    type KanbanModel,
  } from '../../lib/kanban/types';

  let {
    entry,
    model,
    index,
    locale = undefined,
    now = Date.now(),
    soonDays = 3,
    markdown = true,
    descriptionLines = 5,
    editable = true,
    deletable = true,
    headingLevel = 4,
    editing = false,
    dragging = false,
    lifted = false,
    ghost = false,
    busy = false,
    error = undefined,
    onEdit = undefined,
    onCancelEdit = undefined,
    onSave = undefined,
    onDelete = undefined,
    onGrab = undefined,
    onLift = undefined,
    onLiftCancel = undefined,
    onRetry = undefined,
    onDismiss = undefined,
    onOpen = undefined,
    formFields = undefined,
    badges = undefined,
    resolveImage = undefined,
    previewNonce = 0,
    focusable = false,
    keybinds = undefined,
    onEnter = undefined,
  }: {
    entry: Entry;
    model: KanbanModel;
    /** Position within its column — what the drop maths and the drag report. */
    index: number;
    locale?: string | undefined;
    now?: number;
    soonDays?: number;
    markdown?: boolean;
    descriptionLines?: number;
    editable?: boolean;
    deletable?: boolean;
    /** One level below the column heading the board chose. */
    headingLevel?: number;
    editing?: boolean;
    /** This card is the one being dragged. */
    dragging?: boolean;
    /** Picked up with the keyboard, waiting for the arrow keys. */
    lifted?: boolean;
    /** The floating copy that follows the pointer: no controls, no body. */
    ghost?: boolean;
    busy?: boolean;
    error?: string | undefined;
    onEdit?: (() => void) | undefined;
    onCancelEdit?: (() => void) | undefined;
    onSave?: ((changed: PatchFields) => void) | undefined;
    onDelete?: (() => void) | undefined;
    /** A pointer went down on the card (or its grip). */
    onGrab?: ((event: PointerEvent) => void) | undefined;
    /** The grip was activated from the keyboard. */
    onLift?: (() => void) | undefined;
    /** The grip lost focus while holding a card. */
    onLiftCancel?: (() => void) | undefined;
    onRetry?: (() => void) | undefined;
    onDismiss?: (() => void) | undefined;
    /** The title was clicked: show the card in full. */
    onOpen?: (() => void) | undefined;
    /** Which fields the inline editor shows. */
    formFields?: readonly FieldRole[] | undefined;
    /** Extra pills after priority and due, from the board's `cardBadges`. */
    badges?: Snippet<[card: CardRecord]> | undefined;
    resolveImage?: ((src: string) => string | undefined) | undefined;
    previewNonce?: number;
    /** The card itself takes focus (tabindex -1) for keyboard navigation. */
    focusable?: boolean;
    /** `data-keybind` for the Ctrl overlay (see lib/ui/keybinds.ts). */
    keybinds?: string | undefined;
    /** Enter pressed on the focused card itself (not one of its controls). */
    onEnter?: (() => void) | undefined;
  } = $props();

  let root = $state<HTMLLIElement | undefined>();

  /**
   * A focusable card keeps the focus a click (or the keys) gave it when it
   * turns into the inline editor, and Svelte's `autofocus` only takes focus
   * from <body> — so hand it to the editor's title here.
   */
  $effect(() => {
    if (!editing || !focusable || !root || document.activeElement !== root) return;
    const card = root;
    void tick().then(() => {
      if (document.activeElement === card) card.querySelector<HTMLElement>('input, textarea, select')?.focus();
    });
  });

  function onKey(event: KeyboardEvent) {
    if (event.target !== event.currentTarget || event.key !== 'Enter') return;
    if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || !onEnter) return;
    event.preventDefault();
    onEnter();
  }

  const priority = $derived(priorityById(entry.priority, model.priorities));
  const due = $derived(entry.due);
  const dueTone = $derived(dueState(due, now, soonDays));
  const draggable = $derived(!ghost && !editing && !!onGrab);

  let body = $state<HTMLDivElement | undefined>();
  /** The unclamped box inside it, which is what actually changes height. */
  let inner = $state<HTMLDivElement | undefined>();
  let expanded = $state(false);
  let overflowing = $state(false);

  /**
   * Watch the rendered description: markdown arrives asynchronously and images
   * change height after they load, so one measurement would be a guess.
   */
  $effect(() => {
    const host = body;
    if (!host || expanded) return;
    const content = inner;
    if (!content) return;
    const check = () => {
      overflowing = host.scrollHeight - host.clientHeight > 2;
    };
    check();
    // The clamp caps the host's own height, so only its CONTENT growing says
    // there is more to show. `inner` is watched rather than whatever the
    // markdown eventually renders into, because it is there from the start —
    // the rendered description arrives an import and a parse later.
    const observer = new ResizeObserver(check);
    observer.observe(content);
    return () => observer.disconnect();
  });

  /**
   * A pointer on the card body starts a drag; a pointer on a control does what
   * the control says. Touch is the exception: the browser owns a touch-drag
   * for scrolling, so on touch only the grip (which opts out with
   * `touch-action: none`) can start one — otherwise the column could not be
   * scrolled by dragging a card, which is how everyone scrolls a phone.
   */
  function grab(event: PointerEvent) {
    if (!draggable) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select, [data-kanban-no-drag]')) {
      if (!target.closest('[data-kanban-grip]')) return;
    }
    if (event.pointerType !== 'mouse' && !target?.closest('[data-kanban-grip]')) return;
    onGrab?.(event);
  }
</script>

<!-- A focusable card is a focus target for the board's keys: tabindex -1, never in the tab order
     (spread, because the a11y check cannot see that the dynamic value is never >= 0). -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<li
  class="kb-card"
  class:focusable={focusable && !ghost}
  class:dragging
  class:lifted
  class:ghost
  class:editing
  class:busy
  class:failed={!!error}
  class:optimistic={entry.optimistic}
  data-kanban-card={ghost ? undefined : ''}
  data-id={entry.id}
  data-index={index}
  data-keybind={focusable && !ghost ? keybinds : undefined}
  {...focusable && !ghost ? { tabindex: -1 } : {}}
  bind:this={root}
  aria-busy={busy || undefined}
  onpointerdown={grab}
  onkeydown={focusable && !ghost ? onKey : undefined}
  ondblclick={editable && !editing && !ghost ? () => onEdit?.() : undefined}
>
  {#if editing}
    <CardForm
      {model}
      fields={fieldsOf(entry)}
      {busy}
      {formFields}
      onSave={(changed) => onSave?.(changed)}
      onCancel={() => onCancelEdit?.()}
      onDelete={deletable && onDelete ? () => onDelete?.() : undefined}
    />
  {:else}
    <div class="kb-head">
      {#if draggable}
        <button
          type="button"
          class="kb-grip"
          data-kanban-grip
          aria-label={`Move "${entry.title}"`}
          title="Drag to move — or press Space and use the arrow keys"
          aria-pressed={lifted}
          onclick={(event) => {
            // A pointer drag already handled the move; only a keyboard
            // activation (Space or Enter, which fire click) means "lift".
            if (event.detail === 0) onLift?.();
          }}
          onblur={() => {
            // A card picked up from the keyboard is held by the focus on this
            // button. Tab or click away and the lift is over — otherwise the
            // next space bar anywhere on the page would drop a card nobody
            // remembers holding.
            if (lifted) onLiftCancel?.();
          }}
        >
          <span aria-hidden="true">⠿</span>
        </button>
      {/if}

      <svelte:element
        this={`h${headingLevel}`}
        class="kb-title"
        class:untitled={!entry.title}
      >
        {#if onOpen && !ghost}
          <button
            type="button"
            class="kb-title-btn"
            title="Open this card"
            onclick={() => onOpen?.()}
          >
            {entry.title || 'Untitled'}
          </button>
        {:else}
          {entry.title || 'Untitled'}
        {/if}
      </svelte:element>

      {#if busy}<span class="kb-spinner" aria-hidden="true"></span>{/if}

      {#if editable && !ghost}
        <button
          type="button"
          class="kb-pencil"
          title="Edit this card"
          aria-label={`Edit "${entry.title}"`}
          onclick={() => onEdit?.()}
        >
          <span aria-hidden="true">✎</span>
        </button>
      {/if}
    </div>

    {#if priority || due || (badges && !ghost)}
      <div class="kb-badges">
        {#if priority}
          <span class="kb-pill tone-{priority.tone}">
            <span class="visually-hidden">{`${model.labels.priority}: `}</span>{priority.label}
          </span>
        {/if}
        {#if due}
          <span
            class="kb-pill due due-{dueTone}"
            title={`${model.labels.due}: ${formatDueFull(due, locale)}`}
          >
            <span aria-hidden="true">{dueTone === 'overdue' ? '⚠' : '◷'}</span>
            <!-- The glyph is decoration and the colour is a hint; the word is
                 what a screen reader actually gets. -->
            <span class="visually-hidden">
              {model.labels.due}{dueTone === 'overdue' ? ' (overdue)' : ''}:
            </span>
            {formatDue(due, locale, now)}
          </span>
        {/if}
        {#if badges && !ghost}{@render badges(entry.card)}{/if}
      </div>
    {/if}

    {#if entry.description && !ghost}
      <div
        class="kb-body"
        class:clamped={!expanded}
        class:faded={!expanded && overflowing}
        style={expanded ? undefined : `--kb-lines: ${descriptionLines}`}
        bind:this={body}
        onfocusin={() => (expanded = true)}
      >
        <div bind:this={inner}>
          <CardDescription
            text={entry.description}
            {markdown}
            {resolveImage}
            nonce={previewNonce}
          />
        </div>
      </div>
      {#if overflowing || expanded}
        <button
          type="button"
          class="kb-more"
          aria-expanded={expanded}
          onclick={() => (expanded = !expanded)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      {/if}
    {/if}

    {#if error}
      <p class="kb-fail">
        <span class="kb-fail-text">⚠ {error}</span>
        {#if onRetry}
          <button type="button" class="btn btn-sm" onclick={() => onRetry?.()}>Retry</button>
        {/if}
        {#if onDismiss}
          <button type="button" class="btn btn-sm" onclick={() => onDismiss?.()}>Undo</button>
        {/if}
      </p>
    {/if}
  {/if}
</li>

<style>
  .kb-card {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    box-shadow: var(--shadow-1);
  }

  .kb-card:hover:not(.editing) {
    border-color: var(--color-primary);
  }

  /* The keyboard's current card (D23). A mouse click focuses it too, quietly:
     the border says "keys act here", the ring only shows for the keyboard. */
  .kb-card.focusable:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .kb-card.focusable:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    box-shadow: 0 0 0 5px var(--color-primary-soft), var(--shadow-1);
  }

  /* The card being dragged stays exactly where it is, dimmed. Nothing reflows
     mid-drag, which is what stops the insertion point flickering between two
     answers when the pointer sits on a boundary. */
  .kb-card.dragging {
    opacity: 0.35;
  }

  .kb-card.lifted {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px var(--color-primary-soft);
  }

  .kb-card.editing {
    border-color: var(--color-primary);
    background: var(--surface-raised-color);
  }

  .kb-card.optimistic {
    border-style: dashed;
  }

  .kb-card.failed {
    border-color: var(--color-danger);
  }

  .kb-card.busy {
    /* Saving is a hint, not a lock: the card stays readable. */
    opacity: 0.8;
  }

  /* The floating copy under the pointer. Fixed width so it doesn't reflow to
     fit its new column while it is in the air. */
  .kb-card.ghost {
    box-shadow: var(--shadow-2);
    border-color: var(--color-primary);
    transform: rotate(1.5deg);
    cursor: grabbing;
  }

  .kb-head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-1);
  }

  .kb-card :global(.kb-title) {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: var(--font-size-base);
    font-weight: 600;
    line-height: 1.3;
    overflow-wrap: break-word;
  }

  .kb-card :global(.kb-title.untitled) {
    color: var(--text-muted-color);
    font-style: italic;
  }

  .kb-title-btn {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .kb-title-btn:hover {
    color: var(--color-primary-strong);
  }

  .kb-grip,
  .kb-pencil,
  .kb-more {
    background: none;
    border: none;
    padding: 0 var(--space-1);
    color: var(--text-muted-color);
    cursor: pointer;
    line-height: 1.3;
    border-radius: var(--radius-sm);
  }

  /* Big enough to hit with a thumb: the grip is the ONLY way to start a drag
     on touch, and the pencil is next to it. */
  .kb-grip,
  .kb-pencil {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.75rem;
    min-height: 1.75rem;
  }

  .kb-grip {
    /* Opting out of the browser's own touch gestures is what makes a
       touch-drag from the grip a card move rather than a scroll. */
    touch-action: none;
    cursor: grab;
  }

  .kb-grip:hover,
  .kb-pencil:hover {
    color: var(--color-primary-strong);
    background: var(--color-primary-soft);
  }

  /* A `cardBadges` snippet that rendered nothing leaves no gap behind. */
  .kb-badges:empty {
    display: none;
  }

  .kb-badges {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .kb-badges :global(.kb-pill) {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0 var(--space-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    background: var(--surface-raised-color);
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    font-weight: 600;
    white-space: nowrap;
  }

  /* Priority tones, and the due-date tones below them, are the semantic
     feedback tokens — so they follow every palette without naming a colour. */
  .kb-badges :global(.kb-pill.tone-info) {
    color: var(--color-info);
    border-color: var(--color-info);
    background: var(--color-info-soft);
  }

  .kb-badges :global(.kb-pill.tone-success) {
    color: var(--color-success);
    border-color: var(--color-success);
    background: var(--color-success-soft);
  }

  .kb-badges :global(.kb-pill.tone-warning) {
    color: var(--color-warning);
    border-color: var(--color-warning);
    background: var(--color-warning-soft);
  }

  .kb-badges :global(.kb-pill.tone-danger) {
    color: var(--color-danger);
    border-color: var(--color-danger);
    background: var(--color-danger-soft);
  }

  .kb-badges :global(.kb-pill.tone-primary) {
    color: var(--color-primary-strong);
    border-color: var(--color-primary);
    background: var(--color-primary-soft);
  }

  .kb-badges :global(.kb-pill.due-overdue) {
    color: var(--color-danger);
    border-color: var(--color-danger);
    background: var(--color-danger-soft);
  }

  .kb-badges :global(.kb-pill.due-today),
  .kb-badges :global(.kb-pill.due-soon) {
    color: var(--color-warning);
    border-color: var(--color-warning);
    background: var(--color-warning-soft);
  }

  .kb-body {
    font-size: var(--font-size-sm);
    color: var(--text-color);
  }

  .kb-body.clamped {
    /* A line box times the number of lines: a clamp that works on rendered
       markdown, where `-webkit-line-clamp` would only ever measure one block. */
    max-height: calc(var(--kb-lines, 5) * var(--line-height) * 1em);
    overflow: hidden;
  }

  /* Fade the cut edge, so it reads as "there is more" rather than as a
     sentence that stops — but only when something really is cut off. */
  .kb-body.faded {
    mask-image: linear-gradient(to bottom, black calc(100% - 1.2em), transparent);
  }

  /* Card-sized typography for the rendered markdown. CardDescription owns the
     rules every copy needs; these are the ones only a card wants. */
  .kb-body :global(.kb-md.prose) {
    font-size: var(--font-size-sm);
  }

  .kb-body :global(.kb-md.prose h1),
  .kb-body :global(.kb-md.prose h2),
  .kb-body :global(.kb-md.prose h3),
  .kb-body :global(.kb-md.prose h4) {
    font-size: var(--font-size-base);
    margin: var(--space-2) 0 var(--space-1);
  }

  .kb-body :global(.kb-md.prose p),
  .kb-body :global(.kb-md.prose ul),
  .kb-body :global(.kb-md.prose ol) {
    margin: var(--space-1) 0;
  }

  .kb-body :global(.kb-md.prose pre) {
    padding: var(--space-2);
    font-size: 0.9em;
  }

  .kb-more {
    align-self: flex-start;
    font-size: var(--font-size-sm);
    text-decoration: underline;
  }

  .kb-more:hover {
    color: var(--color-primary-strong);
  }

  .kb-fail {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin: 0;
    font-size: var(--font-size-sm);
    color: var(--color-danger);
  }

  .kb-fail-text {
    flex: 1;
    min-width: 8rem;
  }

  .kb-spinner {
    width: 0.7em;
    height: 0.7em;
    margin-top: 0.35em;
    border: 2px solid var(--border-color);
    border-top-color: var(--color-primary);
    border-radius: var(--radius-full);
    animation: kb-spin 0.7s linear infinite;
  }

  @keyframes kb-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  @media (prefers-reduced-motion: reduce) {
    .kb-spinner {
      animation-duration: 3s;
    }

    .kb-card.ghost {
      transform: none;
    }
  }
</style>
