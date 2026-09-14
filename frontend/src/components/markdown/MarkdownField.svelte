<script lang="ts">
  /**
   * The one component every markdown field uses (D7, D10): rendered markdown
   * at rest, the full editor only while editing, and an explicit Save/Cancel.
   *
   * - At rest it shows `MarkdownPreview` (or the muted placeholder) and an
   *   **Edit** button; double-clicking the preview edits too. `readonly`
   *   removes both.
   * - **Edit** lazy-imports `MarkdownEditor` — Crepe, CodeMirror, mermaid and
   *   Excalidraw are only downloaded by someone who actually edits.
   * - **Save** reads the editor's live value (not the debounced one). An
   *   unchanged value just closes. With `getFresh`, the stored value is re-read
   *   first: if it no longer matches what the edit started from — someone
   *   changed it on another device meanwhile — the user is asked before it is
   *   overwritten. `onSave` is awaited; a failure keeps the editor open with
   *   the message.
   * - **Ctrl/Cmd+S** saves; **Escape** cancels (asking first if there are
   *   changes). Keys pressed inside one of the editor's own dialogs, or already
   *   handled by the editor (closing a completion popup), are left alone.
   *
   * Test hooks: `data-testid` `{testid}`, `{testid}-edit`, `{testid}-save`,
   * `{testid}-cancel`, `{testid}-preview`; the rendered preview carries
   * `data-rendered="true"` once it has finished drawing (the empty
   * placeholder carries it immediately). The editor's mode tabs are the
   * buttons named "Edit", "Source" and "Preview"; Source mode is CodeMirror
   * (`.cm-content`).
   */
  import MarkdownPreview from './MarkdownPreview.svelte';
  import type { MarkdownEditorApi } from './MarkdownEditor.svelte';

  type EditorComponent = typeof import('./MarkdownEditor.svelte').default;

  let {
    value,
    onSave,
    readonly = false,
    placeholder = 'Nothing written yet.',
    label = undefined,
    getFresh = undefined,
    minHeight = '12rem',
    class: className = '',
    testid = 'markdown',
    nonce = 0,
  }: {
    /** The stored markdown. Read when editing starts; updates the preview at rest. */
    value: string | null;
    /** Persist the edited markdown (typically one `repo.patch`). */
    onSave: (md: string) => Promise<void>;
    readonly?: boolean;
    /** Shown, muted, when there is nothing to render. */
    placeholder?: string;
    /** A heading for the field, shown beside the Edit button. */
    label?: string;
    /** Re-read the stored value at Save time, to catch a concurrent change. */
    getFresh?: () => Promise<string | null>;
    /** Minimum height of the editing surface. */
    minHeight?: string;
    class?: string;
    /** Prefix for the data-testid hooks. */
    testid?: string;
    /**
     * Passed to MarkdownPreview: bump it to re-render when what the markdown
     * points at changed (an asset arrived by sync). Unlike re-keying the
     * field, it never throws away an open edit.
     */
    nonce?: number;
  } = $props();

  let editing = $state(false);
  let Editor = $state<EditorComponent | null>(null);
  let ready = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  /** What the edit started from — the base a concurrent change is judged against. */
  let startValue = $state('');
  /** Shown after a save until the parent's `value` catches up. */
  let optimistic = $state<string | null>(null);
  let api: MarkdownEditorApi | null = null;

  const shown = $derived(optimistic ?? value ?? '');
  const empty = $derived(shown.trim() === '');

  $effect(() => {
    void value; // a new value from the parent supersedes the optimistic copy
    optimistic = null;
  });

  async function startEdit() {
    if (readonly || editing) return;
    startValue = shown;
    api = null;
    ready = false;
    error = null;
    editing = true;
    if (Editor) return;
    try {
      Editor = (await import('./MarkdownEditor.svelte')).default;
    } catch (err) {
      error = 'Could not load the editor: ' + (err instanceof Error ? err.message : String(err));
    }
  }

  function close() {
    editing = false;
    api = null;
    ready = false;
    error = null;
  }

  function cancel() {
    if (saving) return;
    close();
  }

  const dirty = () => api !== null && api.getValue() !== startValue;

  async function save() {
    if (saving) return;
    if (!api) {
      close();
      return;
    }
    const md = api.getValue();
    if (md === startValue) {
      close();
      return;
    }
    saving = true;
    error = null;
    try {
      if (getFresh) {
        const fresh = (await getFresh()) ?? '';
        if (
          fresh !== startValue &&
          fresh !== md &&
          !confirm('This was changed on another device while you were editing. Overwrite their version?')
        ) {
          return; // keep editing
        }
      }
      await onSave(md);
      optimistic = md;
      close();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (!editing) return;
    const target = event.target instanceof Element ? event.target : null;
    // The editor's dialogs (diagram, drawing, footnotes) own their keys.
    if (target?.closest('[role="dialog"]')) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
      return;
    }
    if (event.key === 'Escape' && !event.defaultPrevented) {
      if (dirty() && !confirm('Discard your changes?')) return;
      event.preventDefault();
      cancel();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="md-field {className}" data-testid={testid} onkeydown={onKeydown}>
  {#if label || (!readonly && !editing)}
    <div class="md-field-head">
      {#if label}<span class="md-field-label">{label}</span>{/if}
      {#if !readonly && !editing}
        <button
          type="button"
          class="btn btn-sm md-field-edit"
          data-testid="{testid}-edit"
          title={label ? `Edit ${label.toLowerCase()}` : 'Edit'}
          onclick={startEdit}>Edit</button
        >
      {/if}
    </div>
  {/if}

  {#if editing}
    {#if Editor}
      <Editor
        value={startValue}
        {minHeight}
        onReady={(handle) => {
          api = handle;
          ready = true;
        }}
      />
    {:else if !error}
      <p class="md-field-loading">Loading editor…</p>
    {/if}

    {#if error}
      <p class="banner banner-danger md-field-error" role="alert">{error}</p>
    {/if}

    <div class="md-field-actions">
      <span class="md-field-hint"><kbd>Ctrl</kbd>+<kbd>S</kbd> saves · <kbd>Esc</kbd> cancels</span>
      <button
        type="button"
        class="btn"
        data-testid="{testid}-cancel"
        disabled={saving}
        onclick={cancel}>Cancel</button
      >
      <button
        type="button"
        class="btn btn-primary"
        data-testid="{testid}-save"
        disabled={saving || !ready}
        onclick={save}>{saving ? 'Saving…' : 'Save'}</button
      >
    </div>
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="md-field-body"
      class:editable={!readonly}
      data-testid="{testid}-preview"
      ondblclick={() => void startEdit()}
    >
      {#if empty}
        <p class="md-field-placeholder" data-rendered="true">{placeholder}</p>
      {:else}
        <MarkdownPreview markdown={shown} {nonce} />
      {/if}
    </div>
  {/if}
</div>

<style>
  .md-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .md-field-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .md-field-label {
    font-weight: 600;
  }

  .md-field-edit {
    margin-left: auto;
  }

  .md-field-body {
    min-width: 0;
  }

  .md-field-placeholder,
  .md-field-loading {
    margin: 0;
    color: var(--text-muted-color);
    font-style: italic;
  }

  .md-field-error {
    margin: 0;
  }

  .md-field-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .md-field-hint {
    margin-right: auto;
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }
</style>
