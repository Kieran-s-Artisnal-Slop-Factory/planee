<!-- Ported from retoken (af25bc6) -->
<script lang="ts">
  /**
   * The card editor: one form for adding a card and for editing one, because
   * they ask for exactly the same five things.
   *
   * It reports only what changed, so a caller's `onUpdate` gets a patch of the
   * fields the reader actually touched rather than a whole card to diff. The
   * description is a plain textarea here — the markdown is written as markdown
   * and rendered at rest by the card, which is the whole point of the pencil.
   *
   * Escape cancels and Ctrl/Cmd+Enter saves, matching the dialogs elsewhere in
   * the repo.
   */
  import { untrack } from 'svelte';
  import { FORM_FIELDS, formResult, formStart, type PatchFields } from '../../lib/kanban/board';
  import type { FieldRole, KanbanModel } from '../../lib/kanban/types';

  let {
    model,
    fields,
    mode = 'edit',
    busy = false,
    formFields = FORM_FIELDS,
    onSave,
    onCancel,
    onDelete = undefined,
  }: {
    model: KanbanModel;
    /** The values to start from. */
    fields: PatchFields;
    mode?: 'edit' | 'create';
    busy?: boolean;
    /**
     * Which fields the form shows (and reports). The title is always shown.
     * Planee leaves `description` out: it is edited in the dialog instead.
     */
    formFields?: readonly FieldRole[];
    /** Called with only the fields that changed (all of them, when adding). */
    onSave: (changed: PatchFields) => void;
    onCancel: () => void;
    onDelete?: (() => void) | undefined;
  } = $props();

  /**
   * What the form opened with. Snapshotted, so the reported difference is
   * always "what you were shown" against "what you left" — an update that
   * arrives from elsewhere mid-edit doesn't turn into a field the reader never
   * touched being reported as changed. `formStart` resolves the status the
   * select will show, so an untouched select never counts as a change.
   */
  const opened: PatchFields = untrack(() => formStart(fields, model));

  let title = $state(opened.title ?? '');
  let status = $state(opened.status ?? '');
  let due = $state(opened.due ?? '');
  let priority = $state(opened.priority ?? '');
  let description = $state(opened.description ?? '');
  /** An empty title is only a mistake once the reader has been in the field. */
  let touched = $state(false);

  const shows = (role: FieldRole) => formFields.includes(role);

  const current = $derived<PatchFields>({
    title: title.trim(),
    status,
    due: due || null,
    priority: priority || null,
    description,
  });

  /** A card with no title is a card nobody can find again. */
  const valid = $derived(current.title !== '');

  function save() {
    if (!valid || busy) return;
    // Adding reports everything; editing reports the difference, so a caller
    // storing a patch is never told about fields nobody touched.
    onSave(formResult(mode, opened, current, formFields));
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    }
  }
</script>

<!-- Escape and Ctrl+Enter are handled for every field at once, here. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form
  class="cf"
  onsubmit={(event) => {
    event.preventDefault();
    save();
  }}
  onkeydown={onKey}
>
  <label class="cf-title">
    <span class="visually-hidden">{model.labels.title}</span>
    <!-- The form only exists because the reader just asked for it, and typing
         the title is the next thing they will do. -->
    <!-- svelte-ignore a11y_autofocus -->
    <input
      type="text"
      autofocus
      placeholder={mode === 'create' ? 'New card…' : model.labels.title}
      bind:value={title}
      onblur={() => (touched = true)}
      aria-invalid={touched && !valid}
    />
  </label>

  {#if shows('status') || shows('due') || shows('priority')}
    <div class="cf-row">
      {#if shows('status')}
        <label>
          <span>{model.labels.status}</span>
          <select bind:value={status}>
            {#each model.statuses as option (option.id)}
              <option value={option.id}>{option.label}</option>
            {/each}
          </select>
        </label>
      {/if}

      {#if shows('due')}
        <label>
          <span>{model.labels.due}</span>
          <input type="date" bind:value={due} />
        </label>
      {/if}

      {#if shows('priority')}
        <label>
          <span>{model.labels.priority}</span>
          <select bind:value={priority}>
            <option value="">—</option>
            {#each model.priorities as option (option.id)}
              <option value={option.id}>{option.label}</option>
            {/each}
          </select>
        </label>
      {/if}
    </div>
  {/if}

  {#if shows('description')}
    <label>
      <span>{model.labels.description} <span class="cf-hint">markdown</span></span>
      <textarea rows="4" placeholder="Markdown — **bold**, lists, `code`…" bind:value={description}
      ></textarea>
    </label>
  {/if}

  <div class="cf-actions">
    {#if onDelete}
      <button type="button" class="btn btn-sm btn-danger" disabled={busy} onclick={onDelete}>
        Delete
      </button>
    {/if}
    <span class="cf-keys muted small"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> saves</span>
    <button type="button" class="btn btn-sm" onclick={onCancel}>Cancel</button>
    <button type="submit" class="btn btn-sm btn-primary" disabled={!valid || busy}>
      {mode === 'create' ? 'Add card' : 'Save'}
    </button>
  </div>
</form>

<style>
  .cf {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .cf-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
    gap: var(--space-2);
  }

  .cf label {
    margin: 0;
  }

  .cf label > span {
    display: block;
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    margin-bottom: var(--space-1);
  }

  .cf input,
  .cf select,
  .cf textarea {
    padding: var(--space-1) var(--space-2);
    font-size: var(--font-size-sm);
  }

  .cf-title input {
    font-weight: 700;
    font-size: var(--font-size-base);
  }

  .cf-title input[aria-invalid='true'] {
    border-color: var(--color-danger);
  }

  .cf textarea {
    resize: vertical;
    min-height: 4.5rem;
    font-family: var(--font-mono);
  }

  .cf-hint {
    display: inline;
    font-family: var(--font-mono);
    font-size: 0.85em;
    opacity: 0.7;
  }

  .cf-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .cf-keys {
    margin-left: auto;
  }

  /* The shortcut hint is the first thing to go when there is no room — and on
     a touch screen there is no Ctrl key to press anyway. */
  @media (max-width: 720px) {
    .cf-keys {
      display: none;
    }
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
