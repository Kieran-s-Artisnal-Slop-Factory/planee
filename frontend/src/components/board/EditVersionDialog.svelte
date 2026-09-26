<script lang="ts">
  /**
   * Edit a version's number and notes (D27): Ctrl+Shift+E on the board, or its
   * "Edit version" button. Only open versions — a completed one is read-only
   * until it is reopened (D6).
   *
   * - The number must not be empty. A number another version of the project
   *   already has is warned about as you type and needs a confirm to save.
   * - The notes are a MarkdownField kept in the draft (its own Save/Cancel,
   *   Ctrl+S), written with the number when the dialog saves.
   * - Save writes the CHANGED fields only, as one `patch` (via `onSave`,
   *   lib/board/actions.ts patchVersion). Before writing it re-reads the row
   *   (`getFresh`): a field changed on another device since the dialog opened
   *   asks before it is overwritten (D10). Nothing changed: it just closes.
   * - Escape or a backdrop click closes it — never while the notes are being
   *   edited (their own Cancel/Escape handles that), and after a confirm when
   *   the number was changed.
   *
   * A non-modal `<dialog open>` with aria-modal, like the FAB's: the app's
   * keybinds stand down while it is open (lib/ui/keybinds.ts MODAL_SELECTOR),
   * and a `role="dialog"` ancestor is never mistaken for one of the markdown
   * editor's own dialogs. z 80, with the complete dialog.
   *
   * Test hooks: edit-version-dialog, edit-version-number,
   * edit-version-duplicate, edit-version-error, edit-version-save,
   * edit-version-cancel, edit-version-description (MarkdownField prefix).
   */
  import { onMount, untrack } from 'svelte';
  import type { Version } from '../../lib/db/types';
  import MarkdownField from '../markdown/MarkdownField.svelte';
  import { isMarkdownEditing, watchMarkdownEditing } from '../forms/markdownEditing';

  type VersionChanges = { number?: string; description?: string | null };

  let {
    version,
    versions,
    nonce = 0,
    getFresh,
    onSave,
    onClose,
  }: {
    version: Version;
    /** The project's versions, for the duplicate-number warning. */
    versions: readonly Version[];
    /** MarkdownField preview nonce (assets arriving by sync). */
    nonce?: number;
    /** The stored row, re-read at Save time. */
    getFresh: () => Promise<Version | undefined>;
    onSave: (changes: VersionChanges) => Promise<void>;
    onClose: () => void;
  } = $props();

  const uid = $props.id();
  /** What the dialog opened with: the base both "changed" and "changed elsewhere" are judged against. */
  const opened = untrack(() => ({ number: version.number, description: version.description ?? '' }));

  let number = $state(opened.number);
  let description = $state(opened.description);
  let error = $state<string | null>(null);
  let saving = $state(false);
  let markdownEditing = $state(false);
  let dialogEl = $state<HTMLDialogElement>();
  let numberEl = $state<HTMLInputElement>();
  let pressedBackdrop = false;
  let returnFocus: HTMLElement | null = null;

  $effect(() => watchMarkdownEditing(dialogEl ?? null, (editing) => (markdownEditing = editing)));

  const trimmed = $derived(number.trim());
  const duplicate = $derived(
    trimmed !== '' && versions.some((v) => v.id !== version.id && !v.deleted_at && v.number.trim() === trimmed)
  );

  onMount(() => {
    const active = document.activeElement;
    returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    numberEl?.focus();
    numberEl?.select();
    return () => {
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  });

  function changes(): VersionChanges {
    const out: VersionChanges = {};
    if (trimmed !== opened.number) out.number = trimmed;
    if (description !== opened.description) out.description = description === '' ? null : description;
    return out;
  }

  async function save(event?: SubmitEvent) {
    event?.preventDefault();
    if (saving) return;
    error = null;
    if (markdownEditing) {
      error = 'Save or cancel the notes first.';
      return;
    }
    if (!trimmed) {
      error = 'A version needs a number.';
      numberEl?.focus();
      return;
    }
    if (duplicate && !confirm(`Another version of this project is already numbered ${trimmed}. Save anyway?`)) return;
    const patch = changes();
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    saving = true;
    try {
      const fresh = await getFresh();
      if (!fresh) throw new Error('This version was deleted — reload to see the current board.');
      const clashes: string[] = [];
      if (patch.number !== undefined && fresh.number !== opened.number && fresh.number !== patch.number) {
        clashes.push('number');
      }
      const freshNotes = fresh.description ?? '';
      if (patch.description !== undefined && freshNotes !== opened.description && freshNotes !== description) {
        clashes.push('notes');
      }
      if (
        clashes.length > 0 &&
        !confirm(`This version's ${clashes.join(' and ')} changed on another device while you were editing. Overwrite?`)
      ) {
        return;
      }
      await onSave(patch);
      onClose();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  function requestClose() {
    if (saving || isMarkdownEditing(dialogEl)) return;
    if (Object.keys(changes()).length > 0 && !confirm('Discard your changes to this version?')) return;
    onClose();
  }

  function onWindowKey(event: KeyboardEvent) {
    // An Escape already handled (the notes' editor cancelling, the palette
    // closing over this dialog) is not ours.
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    requestClose();
  }
</script>

<svelte:window onkeydown={onWindowKey} />

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
    class="modal edit-version"
    data-testid="edit-version-dialog"
    aria-modal="true"
    aria-labelledby="{uid}-title"
    bind:this={dialogEl}
  >
    <form class="stack" onsubmit={save}>
      <h2 id="{uid}-title">Edit version {opened.number}</h2>
      <div>
        <label for="{uid}-number">Number</label>
        <input
          id="{uid}-number"
          data-testid="edit-version-number"
          bind:this={numberEl}
          bind:value={number}
          autocomplete="off"
          spellcheck="false"
          aria-invalid={!trimmed || duplicate}
          aria-describedby={duplicate ? `${uid}-dup` : undefined}
        />
        {#if duplicate}
          <p class="warn" id="{uid}-dup" data-testid="edit-version-duplicate">
            Another version of this project is already numbered {trimmed}.
          </p>
        {/if}
      </div>
      <div class="notes">
        <MarkdownField
          label="Notes"
          testid="edit-version-description"
          value={description === '' ? null : description}
          placeholder="No notes for this version."
          minHeight="10rem"
          {nonce}
          onSave={async (md) => {
            description = md;
          }}
        />
      </div>
      {#if error}
        <p class="banner banner-danger" role="alert" data-testid="edit-version-error">{error}</p>
      {/if}
      <div class="modal-actions">
        {#if markdownEditing}
          <span class="hint">Save or cancel the notes first.</span>
        {/if}
        <button type="button" class="btn" data-testid="edit-version-cancel" disabled={saving} onclick={requestClose}>
          Cancel
        </button>
        <button
          type="submit"
          class="btn btn-primary"
          data-testid="edit-version-save"
          disabled={saving || markdownEditing || !trimmed}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  </dialog>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: grid;
    place-items: center;
    padding: var(--space-4);
    background: rgb(0 0 0 / 0.55);
  }

  /* A non-modal <dialog open>: undo the UA's absolute centring, keep the
     theme's .modal look. No transform: the editor's own dialogs are fixed
     inside it and must stay relative to the viewport. */
  .edit-version {
    position: relative;
    inset: auto;
    margin: 0;
    width: min(44rem, 100%);
    max-height: calc(100vh - 2 * var(--space-4));
    max-height: calc(100dvh - 2 * var(--space-4));
    overflow-y: auto;
  }

  h2 {
    margin: 0;
    font-size: var(--font-size-xl);
  }

  input {
    max-width: 14rem;
    font-variant-numeric: tabular-nums;
  }

  .notes {
    padding: var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
  }

  .warn {
    margin: var(--space-1) 0 0;
    color: var(--color-warning);
    font-size: var(--font-size-sm);
  }

  .hint {
    margin-right: auto;
    align-self: center;
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }

  .banner {
    margin: 0;
  }
</style>
