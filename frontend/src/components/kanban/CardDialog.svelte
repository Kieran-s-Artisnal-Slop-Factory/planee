<!-- Ported from retoken (af25bc6) -->
<script lang="ts">
  /**
   * One card, popped out: the whole description rather than the five lines a
   * card has room for, and every operation the card itself offers.
   *
   * A kanban card is deliberately small, which makes it a poor place to read
   * anything. Clicking the title opens this instead — the same markdown, no
   * clamp, no scrolling past it to see the rest of the board — and the pencil
   * here is the same editor the card opens inline, so nothing is only editable
   * in one of the two places.
   *
   * Escape and a click on the backdrop close it, matching the other dialogs in
   * the repo. While the editor is open, Escape belongs to the editor: it
   * cancels the edit rather than throwing the dialog away with it — and the
   * same goes for anything in `body` that handles Escape itself (calls
   * `preventDefault`), such as a markdown editor.
   *
   * Three optional snippets let a host extend it without forking it: `badges`
   * (extra pills), `body` (replaces the description render — e.g. a markdown
   * field with its own Edit/Save/Cancel) and `actions` (extra buttons, given a
   * `close` callback). All three render in read-only boards too; the host
   * decides what they show there.
   */
  import type { Snippet } from 'svelte';
  import CardForm from './CardForm.svelte';
  import CardDescription from './CardDescription.svelte';
  import { fieldsOf, type Entry, type PatchFields } from '../../lib/kanban/board';
  import { dueState, formatDue, formatDueFull } from '../../lib/kanban/dates';
  import {
    priorityById,
    statusById,
    type CardRecord,
    type FieldRole,
    type KanbanModel,
  } from '../../lib/kanban/types';

  let {
    entry,
    model,
    locale = undefined,
    now = Date.now(),
    soonDays = 3,
    markdown = true,
    editable = true,
    deletable = true,
    editing = false,
    busy = false,
    error = undefined,
    onEdit,
    onCancelEdit,
    onSave,
    onDelete = undefined,
    onRetry = undefined,
    onDismiss = undefined,
    onClose,
    formFields = undefined,
    badges = undefined,
    body = undefined,
    actions = undefined,
    resolveImage = undefined,
    previewNonce = 0,
  }: {
    entry: Entry;
    model: KanbanModel;
    locale?: string | undefined;
    now?: number;
    soonDays?: number;
    markdown?: boolean;
    editable?: boolean;
    deletable?: boolean;
    /** Showing the editor rather than the rendered card. */
    editing?: boolean;
    busy?: boolean;
    error?: string | undefined;
    onEdit: () => void;
    onCancelEdit: () => void;
    onSave: (changed: PatchFields) => void;
    onDelete?: (() => void) | undefined;
    onRetry?: (() => void) | undefined;
    onDismiss?: (() => void) | undefined;
    onClose: () => void;
    /** Which fields the editor shows. */
    formFields?: readonly FieldRole[] | undefined;
    badges?: Snippet<[card: CardRecord]> | undefined;
    /** Rendered INSTEAD of the description, when given. */
    body?: Snippet<[card: CardRecord]> | undefined;
    actions?: Snippet<[card: CardRecord, close: () => void]> | undefined;
    resolveImage?: ((src: string) => string | undefined) | undefined;
    previewNonce?: number;
  } = $props();

  const uid = $props.id();
  const status = $derived(statusById(entry.status, model.statuses) ?? model.statuses[0]);
  const priority = $derived(priorityById(entry.priority, model.priorities));
  const due = $derived(entry.due);
  const dueTone = $derived(dueState(due, now, soonDays));

  let modal = $state<HTMLDivElement | undefined>();
  /**
   * Whether the press that ends in a backdrop click also STARTED on the
   * backdrop. A text selection dragged out of the dialog ends with a click on
   * the backdrop too, and that must not throw the dialog (and an open editor)
   * away.
   */
  let pressedBackdrop = false;

  // Opening a dialog and leaving focus behind it is how a keyboard reader ends
  // up tabbing through the page underneath.
  $effect(() => {
    modal?.focus();
  });

  function onKey(event: KeyboardEvent) {
    // The editor stops Escape from getting this far while it is open, so this
    // only ever closes a dialog that has nothing unsaved in it.
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div
  class="backdrop"
  role="presentation"
  onpointerdown={(event) => (pressedBackdrop = event.target === event.currentTarget)}
  onclick={(event) => {
    if (pressedBackdrop && event.target === event.currentTarget) onClose();
    pressedBackdrop = false;
  }}
>
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby={`${uid}-title`}
    tabindex="-1"
    bind:this={modal}
  >
    <div class="head">
      <h2 id={`${uid}-title`} class:untitled={!entry.title}>{entry.title || 'Untitled'}</h2>
      <button type="button" class="close" aria-label="Close" onclick={onClose}>×</button>
    </div>

    <div class="badges">
      {#if status}
        <span class="pill tone-{status.tone}">
          <span class="visually-hidden">{`${model.labels.status}: `}</span>{status.label}
        </span>
      {/if}
      {#if priority}
        <span class="pill tone-{priority.tone}">
          <span class="visually-hidden">{`${model.labels.priority}: `}</span>{priority.label}
        </span>
      {/if}
      {#if due}
        <span class="pill due-{dueTone}" title={formatDueFull(due, locale)}>
          <span aria-hidden="true">{dueTone === 'overdue' ? '⚠' : '◷'}</span>
          <span class="visually-hidden">
            {model.labels.due}{dueTone === 'overdue' ? ' (overdue)' : ''}:
          </span>
          {formatDue(due, locale, now)}
          <span class="exact">· {formatDueFull(due, locale)}</span>
        </span>
      {/if}
      {#if badges}{@render badges(entry.card)}{/if}
      {#if busy}<span class="muted small">Saving…</span>{/if}
    </div>

    {#if error}
      <p class="banner banner-danger fail">
        <span class="fail-text">⚠ {error}</span>
        {#if onRetry}
          <button type="button" class="btn btn-sm" onclick={() => onRetry?.()}>Retry</button>
        {/if}
        {#if onDismiss}
          <button type="button" class="btn btn-sm" onclick={() => onDismiss?.()}>Undo</button>
        {/if}
      </p>
    {/if}

    {#if editing}
      <div class="editor">
        <CardForm
          {model}
          fields={fieldsOf(entry)}
          {busy}
          {formFields}
          onSave={(changed) => onSave(changed)}
          onCancel={onCancelEdit}
          onDelete={deletable && onDelete ? onDelete : undefined}
        />
      </div>
    {:else}
      <div class="doc">
        {#if body}
          {@render body(entry.card)}
        {:else if entry.description}
          <CardDescription
            text={entry.description}
            {markdown}
            {resolveImage}
            nonce={previewNonce}
          />
        {:else}
          <p class="empty muted">
            No {model.labels.description.toLowerCase()} yet.
          </p>
        {/if}
      </div>

      <div class="actions">
        {#if editable}
          <button type="button" class="btn btn-primary" onclick={onEdit}>
            <span aria-hidden="true">✎</span> Edit
          </button>
        {/if}
        {#if deletable && onDelete}
          <button type="button" class="btn btn-danger" disabled={busy} onclick={() => onDelete?.()}>
            Delete
          </button>
        {/if}
        {#if actions}{@render actions(entry.card, onClose)}{/if}
        <button type="button" class="btn close-btn" onclick={onClose}>Close</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.55);
    display: grid;
    place-items: center;
    /* A bounded row: with the default auto row, the modal's percentage
       max-height resolves against its own content and never caps it, so a
       tall description (a drawing, a diagram, an open editor) pushed Save and
       Close off the bottom of the screen. */
    grid-template-rows: minmax(0, 1fr);
    z-index: 70;
    padding: var(--space-4);
  }

  .modal {
    min-height: 0;
    background: var(--surface-raised-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-2);
    padding: var(--space-4);
    width: min(44rem, 100%);
    max-height: min(90vh, 100%);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .head h2 {
    margin: 0;
    font-size: var(--font-size-xl);
    overflow-wrap: break-word;
    min-width: 0;
  }

  .head h2.untitled {
    color: var(--text-muted-color);
    font-style: italic;
  }

  .close {
    border: none;
    background: none;
    color: var(--text-muted-color);
    font-size: var(--font-size-xl);
    line-height: 1;
    cursor: pointer;
    padding: 0 var(--space-2);
  }

  .close:hover {
    color: var(--text-color);
  }

  .badges {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .badges :global(:is(.pill, .kb-pill)) {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0 var(--space-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    background: var(--surface-color);
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    font-weight: 600;
  }

  /* The same feedback tokens the card uses, so a status reads the same in
     both places. */
  .badges :global(:is(.pill, .kb-pill).tone-info) {
    color: var(--color-info);
    border-color: var(--color-info);
    background: var(--color-info-soft);
  }

  .badges :global(:is(.pill, .kb-pill).tone-success) {
    color: var(--color-success);
    border-color: var(--color-success);
    background: var(--color-success-soft);
  }

  .badges :global(:is(.pill, .kb-pill).tone-warning) {
    color: var(--color-warning);
    border-color: var(--color-warning);
    background: var(--color-warning-soft);
  }

  .badges :global(:is(.pill, .kb-pill).tone-danger) {
    color: var(--color-danger);
    border-color: var(--color-danger);
    background: var(--color-danger-soft);
  }

  .badges :global(:is(.pill, .kb-pill).tone-primary) {
    color: var(--color-primary-strong);
    border-color: var(--color-primary);
    background: var(--color-primary-soft);
  }

  .badges :global(:is(.pill, .kb-pill).due-overdue) {
    color: var(--color-danger);
    border-color: var(--color-danger);
    background: var(--color-danger-soft);
  }

  .badges :global(:is(.pill, .kb-pill).due-today),
  .badges :global(:is(.pill, .kb-pill).due-soon) {
    color: var(--color-warning);
    border-color: var(--color-warning);
    background: var(--color-warning-soft);
  }

  /* There is room here for the date in full, which the card never has. */
  .exact {
    font-weight: 400;
    opacity: 0.8;
  }

  @media (max-width: 480px) {
    .exact {
      display: none;
    }
  }

  .doc,
  .editor {
    overflow-y: auto;
    min-height: 0;
    padding-right: var(--space-1);
  }

  .empty {
    margin: 0;
    padding: var(--space-4);
    border: 1px dashed var(--border-color);
    border-radius: var(--radius-md);
    text-align: center;
  }

  .fail {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin: 0;
  }

  .fail-text {
    flex: 1;
    min-width: 8rem;
    color: var(--color-danger);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .close-btn {
    margin-left: auto;
  }

  .muted {
    color: var(--text-muted-color);
  }

  .small {
    font-size: var(--font-size-sm);
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
