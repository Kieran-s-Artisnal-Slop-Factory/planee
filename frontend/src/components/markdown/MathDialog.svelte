<script lang="ts">
  /**
   * The formula editor — a MathLive `<math-field>` in a dialog (D21).
   *
   * You write the formula as it will look, and the LaTeX is what falls out.
   * The two halves are shown one above the other and edit each other,
   * because knowing `\frac` is faster than clicking when you do know it, and
   * useless when you don't.
   *
   * Ported from notey src/components/notebook/MathDialog.svelte. Changed:
   *  - Every formula that goes into the mathfield — the one being edited, a
   *    LaTeX box edit, anything typed in MathLive's own LaTeX mode — passes
   *    through `sanitizeLatex` first (lib/math/sanitize.ts), so `\style`,
   *    `\cssId`, `\href` and friends never render here either; a line says
   *    what was taken out.
   *  - Escape is handled on `document` and `preventDefault`ed, so it closes
   *    this dialog and nothing else: not the board's card dialog or the FAB's
   *    create dialog around the editor (their window listeners skip a handled
   *    Escape), and not the markdown field's edit. Inside the mathfield
   *    Escape is still MathLive's (it leaves `\command` entry and marks the
   *    key handled itself).
   *  - planee's dialog styling and `md-math-*` test ids.
   *
   * Three settings are load-bearing:
   *
   * **`soundsDirectory = null`** skips 227 KB of keypress `.wav` files that
   * are not vendored (`public/math/PROVENANCE.txt`). Left unset, MathLive
   * requests them from a directory that does not exist.
   *
   * **`fontsDirectory = null`** hands the faces to the stylesheet instead.
   * `ensureFontCss` loads the one with `--ML__static-fonts:true` in it, which
   * tells MathLive's loader to stand down: no CDN, no probing, and the
   * browser pulls the faces a formula actually uses from `/math/fonts/`.
   *
   * **The inline shortcuts are LEFT ON.** "sqrt" becomes a radical, "pi"
   * becomes π, "sum" becomes Σ with its limits — the reason this is easier
   * than typing LaTeX.
   */
  import { onDestroy, onMount, untrack } from 'svelte';
  import { ensureFontCss } from '../../lib/math/fonts';
  import { sanitizeLatex } from '../../lib/math/sanitize';
  import { MATRIX_MAX, matrixLatex } from '../../lib/math/text';

  let {
    initial = '',
    display = false,
    onSave,
    onCancel,
  }: {
    /** Existing LaTeX when editing; '' for a new formula. */
    initial?: string;
    /** Whether it is set on its own line (`$$…$$`) or in the sentence. */
    display?: boolean;
    onSave: (latex: string, display: boolean) => void;
    onCancel: () => void;
  } = $props();

  interface Field extends HTMLElement {
    value: string;
    executeCommand(command: string | [string, ...unknown[]]): boolean;
  }

  // Captured once: the dialog edits its own copy from here on.
  const opening = untrack(() => sanitizeLatex(initial));
  const editing = untrack(() => initial.trim() !== '');
  let host: HTMLDivElement | undefined = $state();
  let modal: HTMLDivElement | undefined = $state();
  let field: Field | undefined;
  let latex = $state(opening.latex);
  let asBlock = $state(untrack(() => display));
  let ready = $state(false);
  let error = $state<string | null>(null);
  /** Commands `sanitizeLatex` took out, named so the author knows why. */
  let filtered = $state<string[]>(opening.removed);
  let destroyed = false;
  /** Set while WE are writing into the field, so its `input` does not echo. */
  let writing = false;
  /** Where focus was before this opened, to put it back on close. */
  let cameFrom: HTMLElement | null = null;
  /** A mousedown that started on the backdrop, so a drag out cannot dismiss. */
  let pressedBackdrop = false;

  /** In an attribute, every `{` would start a Svelte expression. */
  const LATEX_HINT = '\\frac{1}{2}';

  /**
   * The few insertions worth a button. Everything else is on MathLive's own
   * keyboard (the ⌨ in the field) or a typed shortcut. `#0` is where the
   * caret lands, `#?` is a placeholder to tab through.
   */
  const SHELF: { label: string; latex: string; title: string }[] = [
    { label: '¹⁄ₓ', latex: '\\frac{#0}{#?}', title: 'Fraction' },
    { label: '√', latex: '\\sqrt{#0}', title: 'Square root' },
    { label: 'xⁿ', latex: '#0^{#?}', title: 'Power' },
    { label: 'xₙ', latex: '#0_{#?}', title: 'Subscript' },
    { label: 'Σ', latex: '\\sum_{#?}^{#?}#0', title: 'Sum' },
    { label: '∫', latex: '\\int_{#?}^{#?}#0', title: 'Integral' },
    { label: '(  )', latex: '\\left(#0\\right)', title: 'Brackets that grow' },
  ];

  /**
   * The matrix button asks for a size before it inserts anything: rows
   * first, then columns, the way a matrix is named (a 2 × 3 has 2 rows).
   */
  let sizing = $state(false);
  let rows = $state(2);
  let cols = $state(2);
  let rowsField: HTMLInputElement | undefined = $state();

  function openSizer(): void {
    sizing = !sizing;
    if (sizing) queueMicrotask(() => rowsField?.select());
  }

  function insertMatrix(): void {
    sizing = false;
    insert(matrixLatex(rows, cols));
  }

  function onSizeKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    insertMatrix();
  }

  /** Remember what a sanitising pass took out (no duplicates). */
  function note(removed: string[]): void {
    if (removed.length === 0) return;
    filtered = [...new Set([...filtered, ...removed])];
  }

  /** Write `next` into the field without bouncing it back out. */
  function writeField(next: string): void {
    if (!field || field.value === next) return;
    writing = true;
    field.value = next;
    writing = false;
  }

  onMount(async () => {
    // Before anything is awaited: the text behind must stop being the thing
    // the keyboard talks to, or the first keystroke lands in it.
    cameFrom = document.activeElement as HTMLElement | null;
    cameFrom?.blur?.();
    modal?.focus();
    ensureFontCss();
    try {
      const { MathfieldElement } = await import('mathlive');
      if (destroyed) return;
      MathfieldElement.soundsDirectory = null;
      MathfieldElement.fontsDirectory = null;

      const created = new MathfieldElement() as unknown as Field;
      created.setAttribute('data-testid', 'md-math-field');
      created.setAttribute('aria-label', 'Formula');
      created.addEventListener('input', () => {
        if (writing) return;
        // MathLive's own LaTeX mode can type `\style{…}` too: refuse it here.
        const clean = sanitizeLatex(created.value);
        if (clean.removed.length > 0) {
          note(clean.removed);
          writeField(clean.latex);
        }
        latex = clean.latex;
      });
      // MathLive builds the field AFTER it is attached (`mount`), and hands
      // focus to its own keyboard sink a frame or two after THAT — measured
      // at ~35 ms, during which a key goes to the dialog and is lost. So the
      // "Loading…" line stays until the keyboard has actually arrived.
      created.addEventListener(
        'mount',
        () => {
          if (destroyed) return;
          field = created;
          // Anything typed into the LaTeX box while it was being built.
          writeField(latex);
          const active = document.activeElement;
          const unclaimed = !active || active === document.body || active === modal;
          if (!unclaimed) {
            // They have already clicked into something else; leave it.
            ready = true;
            return;
          }
          const arrived = () => {
            if (!destroyed) ready = true;
          };
          created.addEventListener('focusin', arrived, { once: true });
          // Never strand the dialog on "Loading…" if focus goes elsewhere.
          setTimeout(arrived, 500);
          created.focus();
        },
        { once: true }
      );
      host?.append(created);
      created.value = latex;
    } catch (err) {
      if (!destroyed) {
        error = err instanceof Error ? err.message : 'The formula editor failed to load.';
      }
    }
  });

  onDestroy(() => {
    destroyed = true;
    if (cameFrom?.isConnected) cameFrom.focus?.();
  });

  /** Typed into the LaTeX box: push it in without bouncing it back out. */
  function pushLatex(next: string): void {
    const clean = sanitizeLatex(next);
    note(clean.removed);
    latex = clean.latex;
    writeField(clean.latex);
  }

  function insert(snippet: string): void {
    if (!field) return;
    field.focus();
    field.executeCommand(['insert', snippet, { focus: true, feedback: false }]);
    latex = field.value;
  }

  const inField = (node: EventTarget | Element | null) =>
    !!field && !!node && (node === field || field.contains(node as Node));

  /**
   * One step back at a time: an open size picker goes first, before anything
   * — the mathfield included — sees the key (window, capture phase).
   */
  function onEscapeCapture(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !sizing) return;
    event.preventDefault();
    event.stopPropagation();
    sizing = false;
    field?.focus();
  }

  /**
   * Then the dialog (document, bubble phase — after whatever has focus has
   * had its say, before the window listeners of the dialogs around this).
   * Escape inside the mathfield is MathLive's: it leaves the `\command` entry
   * mode and marks the key handled, so it is left alone. Anything else not
   * yet handled closes this dialog and is `preventDefault`ed, which is what
   * tells the card dialog, the create dialog and the markdown field around
   * this one that it has been dealt with.
   */
  function onEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    if (inField(event.target)) return;
    onCancel();
  }

  onMount(() => {
    window.addEventListener('keydown', onEscapeCapture, true);
    document.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('keydown', onEscapeCapture, true);
      document.removeEventListener('keydown', onEscape);
    };
  });

  function save(): void {
    const body = sanitizeLatex(latex).latex.trim();
    if (!body) return;
    onSave(body, asBlock);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="backdrop"
  role="presentation"
  onmousedown={(e) => (pressedBackdrop = e.target === e.currentTarget)}
  onclick={(e) => {
    if (e.target === e.currentTarget && pressedBackdrop) onCancel();
    pressedBackdrop = false;
  }}
>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="math-dialog-title"
    tabindex="-1"
    bind:this={modal}
    data-testid="md-math-dialog" data-md-dialog
  >
    <div class="head">
      <h3 id="math-dialog-title">{editing ? 'Edit formula' : 'New formula'}</h3>
      <button type="button" class="close" aria-label="Close" onclick={onCancel}>×</button>
    </div>

    <div class="shelf">
      {#each SHELF as item (item.latex)}
        <button
          type="button"
          class="chip"
          title={item.title}
          aria-label={item.title}
          disabled={!ready}
          onclick={() => insert(item.latex)}>{item.label}</button
        >
      {/each}
      <button
        type="button"
        class="chip"
        class:on={sizing}
        title="Matrix — choose its size"
        aria-label="Matrix"
        aria-expanded={sizing}
        data-testid="md-math-matrix"
        disabled={!ready}
        onclick={openSizer}>[ ]</button
      >
      <span class="muted small">
        …or just type: <code>sqrt</code>, <code>pi</code>, <code>sum</code> and <code>/</code> become what they
        mean.
      </span>
    </div>

    {#if sizing}
      <div class="sizer" data-testid="md-math-matrix-size">
        <label>
          Rows
          <input
            type="number"
            min="1"
            max={MATRIX_MAX}
            data-testid="md-math-matrix-rows"
            bind:this={rowsField}
            bind:value={rows}
            onkeydown={onSizeKey}
          />
        </label>
        <span aria-hidden="true">×</span>
        <label>
          Columns
          <input
            type="number"
            min="1"
            max={MATRIX_MAX}
            data-testid="md-math-matrix-cols"
            bind:value={cols}
            onkeydown={onSizeKey}
          />
        </label>
        <button type="button" class="btn btn-sm btn-primary" data-testid="md-math-matrix-insert" onclick={insertMatrix}
          >Insert {rows || 1} × {cols || 1} matrix</button
        >
        <button type="button" class="btn btn-sm" onclick={() => (sizing = false)}>Cancel</button>
      </div>
    {/if}

    <div class="field" bind:this={host}>
      {#if !ready && !error}
        <p class="muted small" data-testid="md-math-loading">Loading the formula editor…</p>
      {/if}
      {#if error}
        <p class="banner banner-danger err" role="alert" data-testid="md-math-error">{error}</p>
      {/if}
    </div>

    <label class="latex">
      <span class="muted small">LaTeX</span>
      <input
        type="text"
        class="latex-input"
        data-testid="md-math-latex"
        spellcheck="false"
        placeholder={LATEX_HINT}
        value={latex}
        oninput={(e) => pushLatex(e.currentTarget.value)}
      />
    </label>

    {#if filtered.length > 0}
      <p class="filtered small" role="status" data-testid="md-math-filtered">
        Removed {filtered.join(', ')} — commands that style the page are not allowed in formulas.
      </p>
    {/if}

    <div class="actions">
      <label class="block-toggle">
        <input type="checkbox" data-testid="md-math-display" bind:checked={asBlock} />
        On its own line
      </label>
      <span class="muted small">{asBlock ? 'Written as $$…$$' : 'Written as $…$, in the sentence'}</span>
      <button type="button" class="btn" data-testid="md-math-cancel" onclick={onCancel}>Cancel</button>
      <button
        type="button"
        class="btn btn-primary"
        data-testid="md-math-save"
        onclick={save}
        disabled={!latex.trim()}
      >
        {editing ? 'Update formula' : 'Insert formula'}
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

  .modal {
    background: var(--surface-raised-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-2);
    padding: var(--space-4);
    width: min(48rem, 100%);
    max-height: min(90vh, 100%);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .modal:focus {
    outline: none;
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

  .shelf {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .chip {
    min-width: 2.4rem;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    background: var(--surface-color);
    color: var(--text-color);
    cursor: pointer;
    font-size: var(--font-size-base);
    line-height: 1.4;
  }

  .chip:hover:not(:disabled) {
    border-color: var(--color-primary);
  }

  .chip.on {
    border-color: var(--color-primary);
    background: var(--color-primary-soft);
  }

  .chip:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .sizer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2);
    border: 1px dashed var(--border-color);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
  }

  .sizer label {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .sizer input {
    width: 3.5rem;
    padding: var(--space-1);
    font-family: var(--font-mono);
  }

  .field {
    min-height: 5rem;
    display: flex;
    align-items: center;
  }

  /* The custom element is not in this component's markup, so it needs the
     global escape to be styled at all. */
  .field :global(math-field) {
    display: block;
    width: 100%;
    padding: var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    background: var(--surface-color);
    color: var(--text-color);
    font-size: var(--font-size-xl);
  }

  .field :global(math-field:focus-within) {
    border-color: var(--color-primary);
    outline: none;
  }

  .latex {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .latex-input {
    flex: 1;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
  }

  .filtered {
    margin: 0;
    padding: var(--space-1) var(--space-3);
    border-left: 3px solid var(--color-warning);
    background: var(--color-warning-soft);
    color: var(--text-color);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .block-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--font-size-sm);
  }

  .actions .btn:first-of-type {
    margin-left: auto;
  }

  .muted {
    color: var(--text-muted-color);
  }

  .small {
    font-size: var(--font-size-sm);
  }

  .err {
    margin: 0;
  }
</style>
