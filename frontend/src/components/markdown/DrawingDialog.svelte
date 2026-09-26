<script lang="ts">
  /**
   * The Excalidraw canvas — a Svelte modal shell around a React root,
   * because Excalidraw ships only as a React component. React, Excalidraw
   * and its CSS all arrive through one lazy import when this dialog first
   * opens.
   *
   * Saving exports the scene to a PNG with `exportEmbedScene: true`, so the
   * drawing IS the image the content references AND the source it reopens
   * from. The caller decides what to do with the bytes.
   *
   * This dialog gives up two habits the others keep, because Excalidraw is
   * an application rather than a form (both from notey's copy, 10c-E):
   *
   *  - **Escape does not close it.** Excalidraw needs Escape itself — it is
   *    how you finish a multi-point line, drop a selection, or leave the
   *    current tool. Closing on it would take the key away from the canvas
   *    and throw the drawing out at the same time. The × and Cancel close.
   *    Escape is still `preventDefault`ed (on `document`; Excalidraw ignores
   *    the flag), so the card or create dialog around the editor, and the
   *    markdown field's edit, never react to it either.
   *  - **The keyboard is Excalidraw's for as long as this is open.** Its
   *    shortcuts are single letters and digits (`5` is the arrow, `l` the
   *    line), and by default it listens on its OWN container — so a key only
   *    reached it while focus was inside its React root, and otherwise typed
   *    into the text behind. `handleKeyboardGlobally` binds it to the
   *    document instead (right for a modal) and `autoFocus` puts the caret in
   *    the canvas; the editor behind is blurred before the lazy chunk is even
   *    awaited, and gets focus back on close.
   *
   * A backdrop click closes it only when the press STARTED on the backdrop,
   * so a stroke or a selection dragged out of the canvas cannot throw the
   * drawing away. In test mode the live Excalidraw API is
   * `window.__planeeDrawing` (tests/sync/editor-ui.spec.ts).
   *
   * Ported from retoken (af25bc6) src/components/DrawingDialog.svelte, with
   * notey's changes above; `md-drawing-*` test ids. Fonts are self-hosted:
   * see lib/excalidraw.ts.
   */
  import { onDestroy, onMount } from 'svelte';
  import { loadExcalidraw, sceneToBlob, blobToScene, type ExcalidrawModule } from '../../lib/excalidraw';
  import { isDarkScheme } from '../../lib/theme-scheme';
  import { isTestMode } from '../../lib/testMode';

  let {
    /** Existing drawing to reopen; null for a blank canvas. */
    initial = null,
    onSave,
    onCancel,
  }: {
    initial?: { blob: Blob; name?: string } | null;
    /** Receives the rendered PNG (with the scene embedded). */
    onSave: (blob: Blob) => Promise<void> | void;
    onCancel: () => void;
  } = $props();

  let host: HTMLDivElement;
  let root: { render: (node: unknown) => void; unmount: () => void } | null = null;
  let mod: ExcalidrawModule | null = null;
  /** Excalidraw's imperative handle — the live scene lives behind it. */
  let api: {
    getSceneElements: () => readonly unknown[];
    getAppState: () => Record<string, unknown>;
    getFiles: () => unknown;
  } | null = null;

  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let modal: HTMLDivElement | undefined;
  /** Where focus was before this took it, so it can be given back. */
  let cameFrom: HTMLElement | null = null;
  /** Whether the press that began this click landed on the backdrop. */
  let pressedBackdrop = false;

  /**
   * Escape is Excalidraw's; marking it handled keeps it from the dialogs
   * around this one. On `document`, bubble phase: late enough that
   * Excalidraw's Radix popovers (which dismiss on an Escape nobody has
   * handled, in the capture phase) still close, and registered before
   * Excalidraw's own document listener, which does not look at the flag.
   */
  function claimEscape(event: KeyboardEvent) {
    if (event.key === 'Escape') event.preventDefault();
  }

  onMount(() => {
    document.addEventListener('keydown', claimEscape);
    return () => document.removeEventListener('keydown', claimEscape);
  });

  onMount(async () => {
    // Before anything is awaited: the editor behind must stop being the
    // thing the keyboard talks to, or the first keystroke lands in it.
    // Focus goes to the dialog for now; Excalidraw takes it on mount.
    cameFrom = document.activeElement as HTMLElement | null;
    cameFrom?.blur?.();
    modal?.focus();
    try {
      const { excalidraw, react, reactDom } = await loadExcalidraw();
      mod = excalidraw;

      // Reopening: pull the embedded scene back out of the PNG.
      let scene: {
        elements: readonly unknown[];
        appState: Record<string, unknown>;
        files: unknown;
      } | null = null;
      if (initial) {
        try {
          scene = await blobToScene(excalidraw, initial.blob);
        } catch {
          error =
            'That image has no editable drawing inside it — it may have been exported elsewhere. Starting a blank canvas.';
        }
      }

      root = reactDom.createRoot(host);
      root.render(
        react.createElement(excalidraw.Excalidraw, {
          theme: isDarkScheme() ? 'dark' : 'light',
          // Only the initial scene; Excalidraw owns its state from here.
          initialData: scene
            ? {
                elements: scene.elements,
                appState: { ...scene.appState, collaborators: [] },
                files: scene.files,
              }
            : null,
          excalidrawAPI: (handle: typeof api) => {
            api = handle;
            // For the browser suite only: the live scene, so a test can see
            // a line being drawn and see Escape finish it.
            if (isTestMode()) (window as unknown as { __planeeDrawing?: unknown }).__planeeDrawing = handle;
          },
          // A modal owns the keyboard: bind to the document, not the
          // container, so a key counts wherever focus happens to sit.
          handleKeyboardGlobally: true,
          // And put focus in the canvas anyway, for what does care.
          autoFocus: true,
          // Saving and loading are the host application's business.
          UIOptions: {
            canvasActions: { loadScene: false, saveToActiveFile: false, export: false },
          },
        })
      );
      loading = false;
    } catch (err) {
      error = 'Could not load the drawing canvas: ' + (err instanceof Error ? err.message : String(err));
      loading = false;
    }
  });

  onDestroy(() => {
    // React must tear its own tree down before Svelte removes the host.
    root?.unmount();
    root = null;
    delete (window as unknown as { __planeeDrawing?: unknown }).__planeeDrawing;
    // Hand the keyboard back to whatever had it, if it is still there.
    if (cameFrom?.isConnected) cameFrom.focus?.();
  });

  async function save() {
    if (!mod || !api || saving) return;
    saving = true;
    error = null;
    try {
      const blob = await sceneToBlob(mod, {
        elements: api.getSceneElements(),
        appState: api.getAppState(),
        files: api.getFiles(),
      });
      await onSave(blob);
    } catch (err) {
      error = 'Could not save the drawing: ' + (err instanceof Error ? err.message : String(err));
      saving = false;
    }
  }
</script>

<!-- No Escape to close on purpose: the canvas needs that key (see above). -->
<div
  class="backdrop"
  role="presentation"
  onmousedown={(e) => (pressedBackdrop = e.target === e.currentTarget)}
  onclick={(e) => {
    const dismiss = pressedBackdrop && e.target === e.currentTarget && !saving;
    pressedBackdrop = false;
    if (dismiss) onCancel();
  }}
>
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="drawing-title"
    data-testid="md-drawing-dialog" data-md-dialog
    tabindex="-1"
    bind:this={modal}
  >
    <div class="head">
      <h3 id="drawing-title">{initial ? 'Edit drawing' : 'New drawing'}</h3>
      <button type="button" class="close" aria-label="Close" onclick={onCancel}>×</button>
    </div>

    {#if error}
      <p class="banner banner-danger err" role="alert" data-testid="md-drawing-error">{error}</p>
    {/if}

    <div class="canvas-wrap">
      {#if loading}
        <p class="muted loading" data-testid="md-drawing-loading">Loading the canvas…</p>
      {/if}
      <div class="canvas" data-testid="md-drawing-canvas" bind:this={host}></div>
    </div>

    <div class="actions">
      <span class="muted small">
        Saved as a PNG with the drawing embedded — it reopens here for editing, and a published
        page just shows the image. Escape belongs to the canvas; close with Cancel.
      </span>
      <button type="button" class="btn" data-testid="md-drawing-cancel" onclick={onCancel} disabled={saving}
        >Cancel</button
      >
      <button
        type="button"
        class="btn btn-primary"
        data-testid="md-drawing-save"
        onclick={save}
        disabled={loading || saving}
      >
        {saving ? 'Saving…' : initial ? 'Update drawing' : 'Insert drawing'}
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
    width: min(72rem, 100%);
    height: min(90vh, 100%);
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

  .modal:focus {
    outline: none;
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

  /* Excalidraw fills its container, so the container needs real height. */
  .canvas-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .canvas {
    width: 100%;
    height: 100%;
  }

  .loading {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    z-index: 1;
  }

  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .actions .small {
    margin-right: auto;
    max-width: 34rem;
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
