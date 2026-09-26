<script module lang="ts">
  /** One row of the dialog's working copy. */
  export interface FootnoteRow {
    /** Stable across edits — the label changes, so it can't be the key. */
    id: number;
    /** The label this row arrived with; null for one added here. */
    original: string | null;
    label: string;
    text: string;
    /** References to this label in the document. */
    uses: number;
    /** Whether the document already carries the note itself. */
    defined: boolean;
    /** Cite it at the cursor on save. */
    cite: boolean;
  }

  /**
   * What the caller hands in. A label can be cited without being written —
   * `[^1]` typed into the prose before its note exists — which is a row to
   * fill in, not an error, so it comes through here like any other.
   */
  export interface FootnoteSeed {
    label: string;
    text: string;
    uses: number;
    defined: boolean;
  }

  /** How a save ended, which decides where the caret goes next. */
  export interface FootnoteSaveOptions {
    /**
     * The note the author was in the middle of when they asked to leave, if
     * any — the caller puts the caret at its first citation.
     */
    returnTo: string | null;
  }
</script>

<script lang="ts">
  /**
   * Where footnotes are written.
   *
   * A note is not part of the prose — it hangs off it — so the editing surface
   * shouldn't pretend otherwise. In the WYSIWYG canvas a definition is hidden
   * (and one typed by hand is moved here), and this is the place it can be
   * read, retitled, rewritten or thrown away, with what cites it in view.
   *
   * The list is a working copy: nothing reaches the document until **Save**,
   * so a half-typed label can't orphan a reference on its way through. Renames
   * and deletions carry the references with them — the caller does that with
   * `renameFootnote` / `removeFootnote`, which is why they are one operation
   * each rather than two.
   *
   * Ported from retoken (af25bc6) src/components/FootnoteDialog.svelte, with
   * notey's changes (10c-E): it closes on whichever key opened it
   * (`closeKey`, the rebindable footnote shortcut) instead of a hard-coded
   * Alt+0, and ignores keys until a task boundary after it mounts (`armed`);
   * `md-footnote-*` test ids. planee: its keys are handled on `document`
   * and `preventDefault`ed, so Escape here never closes the card or create
   * dialog around the editor, nor the markdown field's edit.
   */
  import { onDestroy, onMount } from 'svelte';
  import { slugifyLabel } from '../../lib/markdown/footnotes';
  import { DEFAULT_SHORTCUTS, matches, shortcutLabel } from '../../lib/markdown/shortcuts';

  let {
    notes,
    /** Open with this note's text under the caret — how the shortcut arrives. */
    focusLabel = undefined,
    /** The shortcut that opened this, which also closes it. */
    closeKey = DEFAULT_SHORTCUTS.footnotes,
    onSave,
    onCancel,
  }: {
    notes: FootnoteSeed[];
    focusLabel?: string;
    closeKey?: string;
    onSave: (rows: FootnoteRow[], options: FootnoteSaveOptions) => void;
    onCancel: () => void;
  } = $props();

  let nextId = notes.length;
  let rows = $state<FootnoteRow[]>(
    notes.map((note, i) => ({
      id: i,
      original: note.label,
      label: note.label,
      text: note.text,
      uses: note.uses,
      defined: note.defined,
      // Never by default for a row the document already knows: its citations
      // are where the author put them.
      cite: false,
    }))
  );

  /** First field of a row added while the dialog is open, to focus it. */
  let addedId = $state<number | null>(null);
  let host = $state<HTMLElement | undefined>();

  /**
   * Open straight into the note the caller named, caret at the end of its
   * text — arriving from a citation, the note is what you came to write.
   */
  let landed = false;
  /** The dialog itself: focus goes here when there is no note to land in, so
   *  the keyboard is the dialog's (a modal), not the text's behind it. */
  let modal = $state<HTMLDivElement | undefined>();
  $effect(() => {
    if (landed || !modal) return;
    landed = true;
    const row = focusLabel ? rows.find((candidate) => candidate.label === focusLabel) : undefined;
    const field = row ? host?.querySelector<HTMLTextAreaElement>(`textarea[data-row="${row.id}"]`) : null;
    if (!field) {
      modal.focus();
      return;
    }
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  });

  /**
   * The row the caret is in right now, if any. Read off the document rather
   * than tracked: "actively modifying this note" is exactly "focus is in it",
   * and nothing else has to stay in step with that.
   */
  function activeRow(): FootnoteRow | null {
    const active = document.activeElement;
    const element = active instanceof HTMLElement ? active.closest('[data-row-id]') : null;
    if (!(element instanceof HTMLElement)) return null;
    const id = Number(element.dataset.rowId);
    return rows.find((row) => row.id === id) ?? null;
  }

  const trimmed = (row: FootnoteRow) => row.label.trim();

  /**
   * Everything that would make the save produce something other than what the
   * list shows. Blank notes are allowed — a stub you fill in later is a
   * perfectly ordinary way to work — but a label has to be usable as one.
   */
  const problems = $derived.by(() => {
    const found = new Map<number, string>();
    const seen = new Map<string, number>();
    for (const row of rows) {
      const label = trimmed(row);
      if (!label) {
        found.set(row.id, 'Needs a label');
      } else if (/[\]\s]/.test(label)) {
        found.set(row.id, 'No spaces or `]` in a label');
      } else if (seen.has(label)) {
        found.set(row.id, 'Already used by another note');
      }
      if (label) seen.set(label, row.id);
    }
    return found;
  });

  const valid = $derived(problems.size === 0);

  /** A label nothing else in the list is using. */
  function freeLabel(): string {
    const taken = new Set(rows.map(trimmed));
    let n = rows.length + 1;
    while (taken.has(String(n))) n++;
    return String(n);
  }

  function add() {
    const id = nextId++;
    rows = [
      ...rows,
      { id, original: null, label: freeLabel(), text: '', uses: 0, defined: false, cite: true },
    ];
    addedId = id;
  }

  const remove = (id: number) => (rows = rows.filter((row) => row.id !== id));

  /** Keep a label writable as one: `Note G, 1843` is a title, not a label. */
  function tidyLabel(row: FootnoteRow) {
    const label = trimmed(row);
    if (label && /[\]\s]/.test(label)) row.label = slugifyLabel(label);
  }

  function save(returnTo: string | null = null) {
    if (!valid) return;
    onSave(
      rows.map((row) => ({ ...row, label: trimmed(row), text: row.text.trim() })),
      { returnTo }
    );
  }

  /*
   * The keystroke that OPENED this dialog is still being dispatched when
   * the document listener below is registered: Svelte flushes the mount at
   * the end of the delegated handler, and document is visited after the
   * island root, so that very shortcut would reach onKey and close the
   * dialog on the frame it opened — it never even painted. A timer, not a
   * timestamp: a task boundary is the one thing guaranteed to be after the
   * current dispatch. A key aimed INSIDE the dialog is never the opening one,
   * though, so it counts at once — a busy page (Excalidraw just unmounted)
   * can hold the timer back past a quick second press.
   */
  let armed = $state(false);
  onMount(() => {
    const id = setTimeout(() => (armed = true), 0);
    return () => clearTimeout(id);
  });

  /**
   * Where focus was when this opened. A save puts the caret at the citation
   * itself (the editor's returnFromFootnotes); anything else — Cancel,
   * Escape — hands focus back here rather than dropping it on the page.
   */
  const cameFrom = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);
  onDestroy(() => {
    const active = document.activeElement;
    const stranded = !active || active === document.body || (modal?.contains(active) ?? false);
    if (stranded && cameFrom?.isConnected) cameFrom.focus?.();
  });

  /**
   * On `document`, bubble phase: after whatever has focus has had its say,
   * and before the window listeners of the dialogs around the editor, which
   * skip a key that is marked handled. The dialog's own keys (the shortcut,
   * Ctrl+Enter) count even when something below marked them handled: the
   * canvas behind can still have focus for a moment after the shortcut
   * opened this, and ProseMirror claims Alt-combinations for itself.
   */
  function onKey(event: KeyboardEvent) {
    const inside = event.target instanceof Node && (modal?.contains(event.target) ?? false);
    if (!armed && !inside) return;
    if (event.key === 'Escape') {
      // One something inside already used (closing a native picker, say) is theirs.
      if (event.defaultPrevented) return;
      event.preventDefault();
      onCancel();
      return;
    }
    // Ctrl/Cmd+Enter saves, matching the other dialogs.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
      return;
    }
    // The key that opened this closes it again — whichever key that is, so
    // a rebound shortcut still works both ways. In a note, it hands you back
    // to where that note is cited; anywhere else it just puts the list away.
    if (matches(event, closeKey)) {
      event.preventDefault();
      const row = activeRow();
      save(row ? trimmed(row) : null);
    }
  }

  onMount(() => {
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
</script>

<div
  class="backdrop"
  role="presentation"
  onclick={(e) => e.target === e.currentTarget && onCancel()}
>
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="footnote-title"
    data-testid="md-footnote-dialog" data-md-dialog
    tabindex="-1"
    bind:this={modal}
  >
    <div class="head">
      <h3 id="footnote-title">Footnotes</h3>
      <button type="button" class="close" aria-label="Close" onclick={onCancel}>×</button>
    </div>

    <p class="muted small intro">
      Notes live at the foot of the document and stay out of the way while you write. Cite one in
      the text with <code>[^label]</code> — renaming or deleting a note here takes its citations
      with it.
    </p>

    {#if rows.length === 0}
      <p class="empty muted">No footnotes yet.</p>
    {:else}
      <ul class="notes" bind:this={host}>
        {#each rows as row (row.id)}
          <li class="note" class:invalid={problems.has(row.id)} data-row-id={row.id}>
            <div class="fields">
              <label class="label-field">
                <span class="visually-hidden">Label</span>
                <input
                  class="label-input"
                  data-testid="md-footnote-label"
                  value={row.label}
                  spellcheck="false"
                  autofocus={row.id === addedId}
                  aria-invalid={problems.has(row.id)}
                  oninput={(e) => (row.label = e.currentTarget.value)}
                  onblur={() => tidyLabel(row)}
                />
              </label>
              <label class="text-field">
                <span class="visually-hidden">Note</span>
                <textarea
                  rows="2"
                  placeholder="The note…"
                  data-testid="md-footnote-text"
                  data-row={row.id}
                  value={row.text}
                  oninput={(e) => (row.text = e.currentTarget.value)}
                ></textarea>
              </label>
              <button
                type="button"
                class="btn btn-sm btn-danger"
                title="Delete this note and its citations"
                onclick={() => remove(row.id)}>Delete</button
              >
            </div>

            <div class="meta">
              {#if problems.has(row.id)}
                <span class="problem">⚠ {problems.get(row.id)}</span>
              {:else if row.original === null}
                <span class="muted small">New — cited where the cursor is</span>
              {:else if !row.defined}
                <span class="warn small">
                  ⚠ Cited {row.uses}{row.uses === 1 ? ' time' : ' times'} but not written yet
                </span>
              {:else if row.uses === 0}
                <span class="warn small">⚠ Nothing cites this note, so it never renders</span>
              {:else}
                <span class="muted small">
                  Cited {row.uses}{row.uses === 1 ? ' time' : ' times'}
                </span>
              {/if}

              {#if row.original !== null}
                <label class="cite small">
                  <input
                    type="checkbox"
                    checked={row.cite}
                    onchange={(e) => (row.cite = e.currentTarget.checked)}
                  />
                  Cite at the cursor
                </label>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="actions">
      <button type="button" class="btn btn-sm add" onclick={add}>+ New footnote</button>
      <span class="muted small hint">
        <kbd>Ctrl</kbd>+<kbd>Enter</kbd> saves{#if closeKey}
          · <kbd>{shortcutLabel(closeKey)}</kbd> saves and goes back to the note you are in{/if}
      </span>
      <button type="button" class="btn" data-testid="md-footnote-cancel" onclick={onCancel}>Cancel</button>
      <button
        type="button"
        class="btn btn-primary"
        data-testid="md-footnote-save"
        onclick={() => save()}
        disabled={!valid}
      >
        Save footnotes
      </button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.55);
    display: grid;
    place-items: center;
    z-index: 70;
    padding: var(--space-4);
  }

  .modal:focus {
    outline: none;
  }

  .modal {
    background: var(--surface-raised-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-2);
    padding: var(--space-4);
    width: min(46rem, 100%);
    max-height: min(90vh, 100%);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .head h3 {
    margin: 0;
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

  .intro {
    margin: 0;
  }

  .intro code {
    font-size: 0.9em;
    padding: 0 0.3em;
    border-radius: var(--radius-sm);
    background: var(--surface-color);
  }

  .empty {
    margin: 0;
    padding: var(--space-4);
    border: 1px dashed var(--border-color);
    border-radius: var(--radius-md);
    text-align: center;
  }

  .notes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    overflow-y: auto;
    min-height: 0;
  }

  .note {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: var(--space-2);
    background: var(--surface-color);
  }

  .note.invalid {
    border-color: var(--color-danger);
  }

  .fields {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .label-field {
    flex: 0 0 9rem;
  }

  .text-field {
    flex: 1;
    min-width: 0;
  }

  .label-input {
    width: 100%;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
  }

  .text-field textarea {
    width: 100%;
    resize: vertical;
    min-height: 3.2rem;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-1);
    flex-wrap: wrap;
  }

  .cite {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--text-muted-color);
    margin-left: auto;
  }

  .cite input {
    width: auto;
  }

  .problem {
    color: var(--color-danger);
    font-size: var(--font-size-sm);
    font-weight: 600;
  }

  .warn {
    color: var(--color-warning);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .hint {
    margin-right: auto;
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
