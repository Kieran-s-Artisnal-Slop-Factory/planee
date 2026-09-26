<script module lang="ts">
  /** What `onReady` hands the parent. */
  export interface MarkdownEditorApi {
    /** The live markdown, including edits the debounce hasn't reported yet. */
    getValue(): string;
    /** Report anything outstanding through `onChange` right now. */
    flush(): void;
  }

  export type EditorMode = 'wysiwyg' | 'source' | 'preview';
</script>

<script lang="ts">
  /**
   * A markdown editor with three views over one string (D8, D21):
   *
   *  - Edit    — Milkdown Crepe (ProseMirror + remark: markdown in, markdown
   *              out), with syntax-highlighted code blocks, in-canvas `$math$`
   *              typeset by MathLive (lib/math/node.ts, in place of Crepe's
   *              KaTeX feature) and live mermaid previews inside fences.
   *  - Source  — CodeMirror 6 over the exact same string. The bailout, since
   *              remark-stringify normalizes formatting on round-trip.
   *  - Preview — how the markdown renders everywhere else (MarkdownPreview).
   *
   * Plus four tools on the toolbar: **Formula** (a MathLive mathfield —
   * write the formula, not the LaTeX), **Diagram** (mermaid, with templates,
   * completions and a live preview), **Draw** (Excalidraw, saved as a PNG
   * with the scene embedded, so it reopens for editing) and **Footnotes**.
   * Each has a key this device can rebind in Settings (D22,
   * lib/markdown/shortcuts.ts), shown on its button; `openTool` opens any of
   * them from outside, and the command palette reaches the most recently
   * focused editor through lib/ui/commands.ts (`openEditorTool`).
   *
   * Footnotes are GFM (`text[^ada]` + `[^ada]: the note`). Milkdown parses
   * them but has no schema node for definitions, so a WYSIWYG round-trip
   * would silently drop every `[^label]: …` line. Every update from Crepe is
   * therefore repaired — `restoreDefinitions` puts back what it dropped and
   * `unescapeFootnotes` / `unescapeDollars` undo serializer escaping — and
   * definitions are harvested out of the canvas into their own dialog.
   *
   * Markdown is the canonical format; this component is a view over the
   * string and nothing more. Changes are debounced before `onChange` fires;
   * `flush()` / `getMarkdown()` (and `onReady`'s `getValue`) read the canvas
   * itself, so an explicit Save never waits on the debounce.
   *
   * Image bytes — pasted, dropped or drawn — go to the `assets` store, and the
   * markdown keeps the ref the store hands back (`assets/<uuid>.<ext>` for the
   * synced asset table, D9).
   *
   * Ported from notey src/components/notebook/MarkdownEditor.svelte (itself
   * retoken's, with keyboard tools, MathLive maths, footnote fixes, a themed
   * Source view and teardown guards), replacing planee's retoken port.
   * Kept from planee's: `assets` defaults to `dbAssets()` and is preloaded
   * before Crepe mounts so its synchronous image proxy can resolve every ref;
   * `onReady({ getValue, flush })` and an optional `onChange` (MarkdownField
   * uses them); Crepe's CSS is attached on mount (lib/markdown/styles.ts)
   * instead of imported; the mode buttons keep the accessible names "Edit",
   * "Source" and "Preview". Dropped: notey's wiki links (unescapeDoubleBrackets
   * stays, harmlessly) and its memory store. The tool keys come from this
   * device's settings unless `shortcuts` is passed.
   */
  import { onDestroy, onMount } from 'svelte';
  import { Crepe } from '@milkdown/crepe';
  // Aliased: Svelte reserves the `$` prefix for local names, so Milkdown's
  // `$inputRule` cannot be bound under its own.
  import {
    $inputRule as milkdownInputRule,
    getMarkdown as readMarkdown,
    insert,
    replaceAll,
  } from '@milkdown/kit/utils';
  import { InputRule } from '@milkdown/prose/inputrules';
  import { Selection } from '@milkdown/prose/state';
  import { editorViewCtx } from '@milkdown/kit/core';
  import { EditorView, GutterMarker, gutter, keymap } from '@codemirror/view';
  import { EditorState, type Text } from '@codemirror/state';
  import {
    autocompletion,
    completionKeymap,
    type CompletionContext,
    type CompletionResult,
  } from '@codemirror/autocomplete';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
  import { tags } from '@lezer/highlight';
  import { markdown } from '@codemirror/lang-markdown';
  import { dbAssets, type AssetStore } from '../../lib/assets';
  import { drawingFilename, isDrawingRef } from '../../lib/excalidraw';
  import { renderDiagram } from '../../lib/markdown/mermaid';
  import {
    appendDefinition,
    findDefinitions,
    findReferences,
    footnoteAt,
    footnoteMarkers,
    nextLabel,
    removeFootnote,
    renameFootnote,
    report,
    restoreDefinitions,
    setFootnoteText,
    startsDefinition,
    unescapeFootnotes,
    type FootnoteLink,
  } from '../../lib/markdown/footnotes';
  import { codeBlockLanguages } from '../../lib/markdown/code-languages';
  import {
    TOOLS,
    loadShortcuts,
    onShortcutsChange,
    shortcutLabel,
    toolFor,
    type Shortcuts,
    type ToolId,
  } from '../../lib/markdown/shortcuts';
  import { ensureMathCss } from '../../lib/math/fonts';
  import {
    cutMathAt,
    mathBlockSchema,
    mathEditPlugin,
    mathInlineInputRule,
    mathInlineSchema,
    remarkMathPlugin,
    strictMathPlugin,
    selectedMath,
    type MathTarget,
  } from '../../lib/math/node';
  import { mathAt, mathMarkdown, unescapeDollars } from '../../lib/math/text';
  import {
    OPEN_EDITOR_TOOL_EVENT,
    activeEditor,
    registerEditor,
    touchEditor,
    type EditorHandle,
    type OpenEditorToolDetail,
  } from '../../lib/ui/commands';
  import MarkdownPreview from './MarkdownPreview.svelte';
  import MathDialog from './MathDialog.svelte';
  import DiagramDialog from './DiagramDialog.svelte';
  import DrawingDialog from './DrawingDialog.svelte';
  import FootnoteDialog, { type FootnoteRow, type FootnoteSaveOptions } from './FootnoteDialog.svelte';
  // Crepe's theme, one part file at a time, `?inline` + attachStyle (Astro
  // would otherwise link these sheets on every page that can lazy-load this
  // editor). NOT `theme/common/style.css`: its `latex.css` @imports KaTeX's
  // whole stylesheet, which pulled twenty hashed KaTeX fonts into the build —
  // MathLive's vendored faces in public/math/ are the one copy now. Skipped
  // on purpose: latex (the feature is off — see mountCrepe), ai, diff and
  // top-bar (features planee never turns on).
  import prosemirrorCss from '@milkdown/crepe/theme/common/prosemirror.css?inline';
  import resetCss from '@milkdown/crepe/theme/common/reset.css?inline';
  import blockEditCss from '@milkdown/crepe/theme/common/block-edit.css?inline';
  import codeMirrorCss from '@milkdown/crepe/theme/common/code-mirror.css?inline';
  import cursorCss from '@milkdown/crepe/theme/common/cursor.css?inline';
  import imageBlockCss from '@milkdown/crepe/theme/common/image-block.css?inline';
  import linkTooltipCss from '@milkdown/crepe/theme/common/link-tooltip.css?inline';
  import listItemCss from '@milkdown/crepe/theme/common/list-item.css?inline';
  import placeholderCss from '@milkdown/crepe/theme/common/placeholder.css?inline';
  import toolbarCss from '@milkdown/crepe/theme/common/toolbar.css?inline';
  import tableCss from '@milkdown/crepe/theme/common/table.css?inline';
  import frameCss from '@milkdown/crepe/theme/frame.css?inline';
  import { attachStyle } from '../../lib/markdown/styles';

  type Mode = EditorMode;

  let {
    value = '',
    onChange = undefined,
    onReady = undefined,
    placeholder = 'Write…',
    /** Where image bytes live. Defaults to the synced asset table. */
    assets = dbAssets(),
    /** Milliseconds of quiet before onChange fires. */
    debounce = 400,
    /** Which view to open in. */
    mode: initialMode = 'wysiwyg',
    /** Minimum height of the editing surface. */
    minHeight = '18rem',
    /** The view changed, by button or `setMode`. */
    onMode = undefined,
    /** Which key opens which tool. Defaults to this device's (Settings). */
    shortcuts: shortcutsProp = undefined,
  }: {
    value?: string;
    onChange?: (md: string) => void;
    /** Called once on mount with a synchronous handle on the live value. */
    onReady?: (api: MarkdownEditorApi) => void;
    placeholder?: string;
    assets?: AssetStore;
    debounce?: number;
    mode?: Mode;
    minHeight?: string;
    onMode?: ((mode: Mode) => void) | undefined;
    shortcuts?: Shortcuts;
  } = $props();

  let mode = $state<Mode>(initialMode);
  // The mermaid workbench: null = closed; `initial` seeds it from an existing
  // fence and `range` marks what to replace in source mode.
  let diagram = $state<{ initial: string; range: { from: number; to: number } | null } | null>(null);
  /**
   * The formula editor: null = closed. `range` is set in Source view, where
   * the formula being edited is a stretch of text; `pos` in the canvas,
   * where it is a node.
   */
  let math = $state<(MathTarget & { range: { from: number; to: number } | null }) | null>(null);
  // The drawing canvas: undefined = closed. `src` set = reopening that
  // drawing; null = a blank canvas.
  let drawing = $state<{ src: string; blob: Blob } | null | undefined>(undefined);
  /**
   * Display URL → stored ref, for every image the store has resolved. Crepe's
   * DOM carries the display URL (a `blob:` URL for the asset table), and the
   * ✏ affordance needs the ref it came from.
   */
  const displayed = new Map<string, string>();
  /** Re-applies the ✏ affordance whenever Crepe re-renders an image block. */
  let blockObserver: MutationObserver | null = null;
  /**
   * Set once this component is on its way out. Mounting Crepe is async, so
   * an editor closed mid-mount lands back here with `root` already unbound —
   * everything after an await has to check.
   */
  let torn = false;
  /** The footnote workbench: notes are edited there, not in the canvas. */
  let footnotesOpen = $state(false);
  /** Which note it opens on, when it was opened from one. */
  let footnoteFocus = $state<string | undefined>(undefined);
  /** An image the store refused (over the 5 MB cap, say) — named, not swallowed. */
  let notice = $state<string | null>(null);

  /** This device's tool keys, kept current while Settings changes them. */
  let deviceShortcuts = $state<Shortcuts>(loadShortcuts());
  const shortcuts = $derived(shortcutsProp ?? deviceShortcuts);

  let editorEl: HTMLDivElement;
  let root: HTMLDivElement;
  let crepe: Crepe | null = null;
  let cm: EditorView | null = null;

  /** The live markdown; editors are rebuilt from it on every mode switch. */
  let current = value;
  /** Mirrors `current` for the preview pane (plain `current` isn't reactive). */
  let previewSource = $state(value);
  /** Bumped when bytes change under a ref that didn't move, so preview redraws. */
  let previewNonce = $state(0);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * remark-stringify (inside Crepe) escapes leading brackets, mangling
   * `[[wiki links]]` into `\[\[…]]`. Undo exactly that pattern — nothing
   * else — so they survive a WYSIWYG round-trip.
   */
  const unescapeDoubleBrackets = (md: string) => md.replace(/\\(\[)\\?(\[[^\]\n]+\]\])/g, '$1$2');

  /** Repair everything remark-stringify mangles on a WYSIWYG round-trip. */
  const unmangle = (md: string) => unescapeDollars(unescapeFootnotes(unescapeDoubleBrackets(md)));

  /**
   * Set when the component — not the author — is about to edit the ProseMirror
   * document, which is how a footnote gets filed away out of the canvas. The
   * markdown means the same either way, so that update refreshes the screen
   * without being reported as something to save.
   *
   * Cleared by the update it belongs to rather than after the dispatch:
   * Milkdown debounces `markdownUpdated` by 200 ms, so the flag has to outlive
   * the transaction. An author keystroke landing inside that window is
   * coalesced into the same update and goes unreported too — `flush` is what
   * makes sure it is still saved.
   */
  let tidying = false;
  /** The last markdown handed to `onChange`, so `flush` knows what is owed. */
  let lastSaved = value;

  function emit(md: string, options: { silent?: boolean } = {}) {
    current = md;
    previewSource = md;
    if (options.silent) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      lastSaved = md;
      onChange?.(md);
    }, debounce);
  }

  /**
   * Report anything outstanding right now (mode switch / unmount / the parent
   * about to save) — whether it is a debounce still counting down, a change
   * that was never scheduled, or a keystroke Milkdown is still holding in its
   * own 200 ms window.
   */
  export function flush(): void {
    if (mode === 'wysiwyg') syncFromCanvas();
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
    if (current === lastSaved) return;
    lastSaved = current;
    onChange?.(current);
  }

  /** The markdown as it stands this instant, debounces notwithstanding. */
  export function getMarkdown(): string {
    if (mode === 'wysiwyg') syncFromCanvas();
    return current;
  }

  /** Put the caret in whichever editor is live. */
  export function focus(): void {
    if (mode === 'source') {
      cm?.focus();
      return;
    }
    if (mode !== 'wysiwyg' || !crepe) return;
    try {
      crepe.editor.action((ctx) => ctx.get(editorViewCtx).focus());
    } catch {
      // Not mounted yet; nothing to focus.
    }
  }

  /** Put the caret at the end of the document and focus it. */
  export function focusEnd(): void {
    if (mode === 'preview') return;
    if (mode === 'source') {
      if (!cm) return;
      const at = cm.state.doc.length;
      cm.dispatch({ selection: { anchor: at }, scrollIntoView: true });
      cm.focus();
      return;
    }
    if (!crepe) return;
    try {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const end = Selection.atEnd(view.state.doc);
        view.dispatch(view.state.tr.setSelection(end).scrollIntoView());
        view.focus();
      });
    } catch {
      // Not mounted yet; nothing to place.
    }
  }

  /**
   * A new document from outside — the parent switched documents without
   * remounting. Skipped when the prop is merely echoing what this component
   * just reported (`lastSaved`), and when it is an older echo that has since
   * been typed past (`current`); resetting in either case would eat keystrokes.
   */
  $effect(() => {
    const next = value;
    if (next === current || next === lastSaved) return;
    current = next;
    previewSource = next;
    lastSaved = next;
    if (mode === 'source' && cm) {
      cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: next } });
    } else if (mode === 'wysiwyg' && crepe) {
      try {
        crepe.editor.action(replaceAll(next));
        queueMicrotask(harvestFootnotes);
      } catch {
        // Mid-mount: `mountCrepe` reads `current`, so it picks the new text up.
      }
    }
  });

  /** Store a pasted or dropped image; the returned ref goes in the markdown. */
  async function uploadImage(file: File): Promise<string> {
    try {
      const src = await assets.save(file, file.name || 'pasted.png');
      notice = null;
      return src;
    } catch (err) {
      // The 5 MB cap, most likely. Name it; an empty src leaves Crepe's own
      // "upload an image" placeholder rather than a broken picture.
      notice = err instanceof Error ? err.message : String(err);
      return '';
    }
  }

  /** Display proxy: a stored ref → something the browser can show. */
  function proxyImage(url: string): string {
    const shown = assets.resolve?.(url) ?? url;
    if (shown !== url) {
      // The editor outlives many documents; keep the map bounded rather than
      // growing for the life of the page. An evicted entry costs one ✏ button
      // until Crepe next re-renders that block through here.
      if (displayed.size >= 200) displayed.clear();
      displayed.set(shown, url);
    }
    return shown;
  }

  /* ── Diagrams ──────────────────────────────────────────────────────── */

  /**
   * The ```mermaid fence containing `pos`, or null. Used in source mode so
   * the Diagram button edits the block you're standing in instead of
   * inserting a second one.
   */
  function mermaidFenceAt(text: string, pos: number): { from: number; to: number; code: string } | null {
    const lines = text.split('\n');
    let offset = 0;
    let open: { start: number; bodyStart: number } | null = null;
    for (const line of lines) {
      const end = offset + line.length;
      if (open === null) {
        if (/^\s*```\s*mermaid\s*$/i.test(line)) open = { start: offset, bodyStart: end + 1 };
      } else if (/^\s*```\s*$/.test(line)) {
        if (pos >= open.start && pos <= end) {
          return {
            from: open.start,
            to: end,
            code: text.slice(open.bodyStart, Math.max(open.bodyStart, offset - 1)),
          };
        }
        open = null;
      }
      offset = end + 1;
    }
    return null;
  }

  /* ── Formulas ──────────────────────────────────────────────────────── */

  /**
   * Open the formula editor — on the formula you are standing in, if you
   * are standing in one. In the canvas a formula is a node and the selected
   * one is the answer (double-clicking one selects it and opens this on its
   * own); in Source it is a stretch of text, found by reading around the
   * cursor.
   */
  function openMath(): void {
    if (mode === 'source' && cm) {
      const found = mathAt(cm.state.doc.toString(), cm.state.selection.main.head);
      math = found
        ? { latex: found.latex, display: found.display, range: { from: found.from, to: found.to } }
        : { latex: '', display: false, range: null };
      return;
    }
    math = { ...(selectedMathTarget() ?? { latex: '', display: false }), range: null };
  }

  /** The formula selected in the canvas, or null. */
  function selectedMathTarget(): MathTarget | null {
    if (!crepe) return null;
    try {
      let found: MathTarget | null = null;
      crepe.editor.action((ctx) => {
        found = selectedMath(ctx.get(editorViewCtx));
      });
      return found;
    } catch {
      // Editor not ready — treat as "nothing selected".
      return null;
    }
  }

  /**
   * Write the formula back as markdown. Editing one in the canvas is a cut
   * and an insert: the old node comes out at the position the dialog was
   * opened on, which leaves the caret there for the new one to land in.
   */
  function saveMath(latex: string, display: boolean): void {
    const target = math;
    math = null;
    if (target?.pos !== undefined && crepe) {
      try {
        crepe.editor.action((ctx) => cutMathAt(ctx.get(editorViewCtx), target.pos!, display));
      } catch {
        // Editor gone or the node moved — insert at the caret instead.
      }
    }
    replaceOrInsert(mathMarkdown(latex, display), target?.range ?? null, { inline: !display });
  }

  /** Open the workbench — editing the fence at the cursor when there is one. */
  function openDiagram() {
    if (mode === 'source' && cm) {
      const found = mermaidFenceAt(cm.state.doc.toString(), cm.state.selection.main.head);
      diagram = found ? { initial: found.code, range: { from: found.from, to: found.to } } : { initial: '', range: null };
      return;
    }
    diagram = { initial: '', range: null };
  }

  /** Write the diagram back as a fence: replace the edited one, or insert. */
  function saveDiagram(code: string) {
    const fence = '```mermaid\n' + code + '\n```';
    const target = diagram;
    diagram = null;
    replaceOrInsert(fence, target?.range ?? null);
  }

  /* ── Drawings ──────────────────────────────────────────────────────── */

  /**
   * The drawing image ref the cursor sits in, or null — so the Draw button
   * reopens the drawing you're standing on instead of adding another.
   * Matches `![alt](path)` where the path is a `*.excalidraw.png`.
   */
  function drawingRefAt(text: string, pos: number): string | null {
    for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (pos >= start && pos <= end && isDrawingRef(m[1]!)) return m[1]!;
    }
    return null;
  }

  /** The drawing currently selected in Crepe (a selected image node), or null. */
  function selectedCrepeDrawing(): string | null {
    if (!crepe) return null;
    let found: string | null = null;
    try {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const node = (view.state.selection as { node?: { attrs?: Record<string, unknown> } }).node;
        const src = node?.attrs?.src;
        if (typeof src !== 'string') return;
        // The DOM carries the display URL; map it back to the stored ref.
        const ref = displayed.get(src) ?? src;
        if (isDrawingRef(ref)) found = ref;
      });
    } catch {
      // No selection / editor not ready — treat as "nothing selected".
    }
    return found;
  }

  /** Open the canvas — reopening the drawing at the cursor when there is one. */
  async function openDrawing() {
    notice = null;
    const ref =
      mode === 'source' && cm
        ? drawingRefAt(cm.state.doc.toString(), cm.state.selection.main.head)
        : selectedCrepeDrawing();

    if (!ref) {
      drawing = null; // a blank canvas
      return;
    }
    if (!assets.load) {
      notice = 'This asset store cannot read images back, so drawings open blank.';
      drawing = null;
      return;
    }
    const blob = await assets.load(ref);
    drawing = blob ? { src: ref, blob } : null;
  }

  /**
   * Persist the exported PNG. Editing an existing drawing overwrites it in
   * place when the store allows (every reference to it updates at once);
   * otherwise — and for a new drawing — the image is stored and its ref
   * inserted at the cursor.
   */
  async function saveDrawing(blob: Blob) {
    const target = drawing;
    drawing = undefined;

    try {
      if (target && assets.replace) {
        // The old display URL may be revoked under the same ref, so any <img>
        // still pointing at it (Crepe's DOM) has to be re-pointed by hand —
        // otherwise the editor shows a broken image until it next re-renders.
        const stale = assets.resolve?.(target.src);
        await assets.replace(target.src, blob);
        const fresh = proxyImage(target.src);
        if (stale && fresh && stale !== fresh && root) {
          for (const img of root.querySelectorAll('img')) {
            if (img.getAttribute('src') === stale) img.setAttribute('src', fresh);
          }
        }
        previewNonce++;
        return;
      }

      const src = await assets.save(blob, drawingFilename());
      notice = null;
      replaceOrInsert(`![Drawing](${src})`, null);
    } catch (err) {
      // The cap, most likely — a dense drawing at 2× can be a big PNG.
      notice = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Put a ✏ button beside Crepe's caption button on every image that is a
   * re-editable drawing, so editing one is a single obvious click rather
   * than "select it, then find the toolbar".
   */
  function decorateDrawings() {
    if (!root) return;
    for (const block of root.querySelectorAll<HTMLElement>('.milkdown-image-block')) {
      const img = block.querySelector('img');
      const operations = block.querySelector('.operation');
      if (!img || !operations || operations.querySelector('.drawing-edit')) continue;

      const shown = img.getAttribute('src') ?? '';
      const ref = displayed.get(shown) ?? shown;
      if (!isDrawingRef(ref)) continue;

      const button = document.createElement('div');
      button.className = 'operation-item drawing-edit';
      button.title = 'Edit this drawing';
      button.setAttribute('data-testid', 'md-drawing-edit');
      button.textContent = '✏';
      button.addEventListener('mousedown', (e) => {
        // Beat ProseMirror to the event: it would move the selection and
        // blur the block out from under us.
        e.preventDefault();
        e.stopPropagation();
        void (async () => {
          const blob = await assets.load?.(ref);
          drawing = blob ? { src: ref, blob } : null;
        })();
      });
      operations.appendChild(button);
    }
  }

  /* ── Footnotes ─────────────────────────────────────────────────────── */

  /**
   * Complete a footnote label after `[^`, offering every label the document
   * already defines with its note text as the detail. Not offered on a
   * definition line: `[^` at the start of a line is you naming a new
   * footnote, not referring to an existing one.
   */
  function footnoteCompletions(context: CompletionContext): CompletionResult | null {
    const token = context.matchBefore(/\[\^[^\]\s]*/);
    if (!token || (token.from === token.to && !context.explicit)) return null;

    const line = context.state.doc.lineAt(token.from);
    if (token.from - line.from <= 3 && /^\s{0,3}\[\^/.test(line.text)) return null;

    const definitions = findDefinitions(context.state.doc.toString());
    if (definitions.length === 0) return null;

    // Complete inside an already-closed `[^…]` without adding a second `]`.
    const closed = context.state.sliceDoc(context.pos, context.pos + 1) === ']';

    return {
      from: token.from + 2,
      options: definitions.map((definition) => ({
        label: definition.label,
        detail: 'footnote',
        info: definition.text || undefined,
        apply: closed ? definition.label : `${definition.label}]`,
      })),
      validFor: /^[^\]\s]*$/,
    };
  }

  /** What one marker's click will do, as its tooltip line. */
  const describeLink = (link: FootnoteLink): string => {
    if (link.target === null) {
      return link.role === 'ref' ? `[^${link.label}] has no definition` : `[^${link.label}] is never referenced`;
    }
    return link.role === 'ref'
      ? `Go to the definition of [^${link.label}]`
      : `Go to where [^${link.label}] is cited`;
  };

  /** The superscript count on a marker standing for more than one footnote. */
  function countBadge(n: number): HTMLElement {
    const sup = document.createElement('sup');
    sup.className = 'count';
    sup.textContent = String(n);
    return sup;
  }

  /**
   * A gutter marker beside every line carrying a footnote, which jumps to the
   * other half of the pair: a reference goes to its definition, a definition
   * goes back to where it was cited. A line citing several notes gets one
   * marker standing for all of them (counted; each click steps to the next);
   * an orphan gets a marker in the warning colour with nowhere to jump.
   */
  class FootnoteGutterMarker extends GutterMarker {
    // Declared and assigned, not a constructor parameter property: Svelte's
    // compiler parses the script itself and doesn't implement those.
    readonly links: FootnoteLink[];
    constructor(links: FootnoteLink[]) {
      super();
      this.links = links;
    }
    override eq(other: FootnoteGutterMarker): boolean {
      if (other.links.length !== this.links.length) return false;
      return this.links.every((link, i) => {
        const theirs = other.links[i]!;
        return theirs.label === link.label && theirs.role === link.role && theirs.target === link.target;
      });
    }
    override toDOM(): HTMLElement {
      const first = this.links[0];
      // The spacer only reserves the gutter's width — it must not look
      // clickable or announce itself to a screen reader.
      if (!first) {
        const spacer = document.createElement('span');
        spacer.className = 'cm-footnote-marker spacer';
        spacer.append('⁋', countBadge(2));
        spacer.setAttribute('aria-hidden', 'true');
        return spacer;
      }
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'cm-footnote-marker';
      el.append(first.role === 'ref' ? '⁋' : '↳');
      if (this.links.length > 1) el.append(countBadge(this.links.length));
      // Warning colour only when the whole line is dead ends.
      if (this.links.every((link) => link.target === null)) el.classList.add('orphan');
      const description = this.links.map(describeLink).join('\n');
      el.title = description;
      el.setAttribute('aria-label', description);
      return el;
    }
  }

  /**
   * The gutter asks line by line, so the scan is memoized per document —
   * `state.doc` is a fresh object after every edit, which makes it the key.
   */
  const markerCache = new WeakMap<Text, Map<number, FootnoteGutterMarker>>();
  function markersFor(view: EditorView): Map<number, FootnoteGutterMarker> {
    const doc = view.state.doc;
    const cached = markerCache.get(doc);
    if (cached) return cached;
    const byLine = new Map<number, FootnoteGutterMarker>();
    for (const { line, links } of footnoteMarkers(doc.toString())) {
      byLine.set(line, new FootnoteGutterMarker(links));
    }
    markerCache.set(doc, byLine);
    return byLine;
  }

  /**
   * Where the next click on a multi-footnote line goes. Keyed by what the line
   * carries rather than by its number, so inserting a paragraph above doesn't
   * hand the marker a different line's position in the cycle.
   */
  let footnoteCycle: { key: string; index: number } | null = null;
  const cycleKey = (links: FootnoteLink[]) => links.map((link) => `${link.role}:${link.label}`).join('|');

  const footnoteGutter = () =>
    gutter({
      class: 'cm-footnote-gutter',
      lineMarker(view, block) {
        // `block.from` is a document offset; the gutter is keyed by line.
        const line = view.state.doc.lineAt(block.from).number - 1;
        return markersFor(view).get(line) ?? null;
      },
      initialSpacer: () => new FootnoteGutterMarker([]),
      domEventHandlers: {
        mousedown(view, block) {
          const line = view.state.doc.lineAt(block.from).number - 1;
          const links = markersFor(view).get(line)?.links ?? [];
          // Orphans are skipped rather than counted: a click that lands
          // nowhere would look like a broken button.
          const jumpable = links.filter((link) => link.target !== null);
          if (jumpable.length === 0) return false;
          const key = cycleKey(links);
          const index = footnoteCycle?.key === key ? (footnoteCycle.index + 1) % jumpable.length : 0;
          footnoteCycle = { key, index };
          const target = jumpable[index]!.target!;
          view.dispatch({
            selection: { anchor: target },
            // Centred: the counterpart is usually far away.
            effects: EditorView.scrollIntoView(target, { y: 'center' }),
          });
          view.focus();
          return true;
        },
      },
    });

  /**
   * The document's notes, as the dialog shows them: first definition per
   * label (which is the one that renders), with how often it is cited.
   * Derived from `previewSource`, which every keystroke in either editor
   * updates — so the count on the toolbar moves as you write.
   */
  const footnoteNotes = $derived.by(() => {
    const { definitions, references } = report(previewSource);
    const uses = new Map<string, number>();
    for (const reference of references) {
      uses.set(reference.label, (uses.get(reference.label) ?? 0) + 1);
    }

    const written = new Set<string>();
    const notes: Array<{ label: string; text: string; uses: number; defined: boolean }> = [];
    for (const definition of definitions) {
      if (written.has(definition.label)) continue;
      written.add(definition.label);
      notes.push({
        label: definition.label,
        text: definition.text,
        uses: uses.get(definition.label) ?? 0,
        defined: true,
      });
    }

    // A citation whose note nobody has written yet is a footnote in progress:
    // it gets a row, empty, waiting for the text — and it must not be cited a
    // second time on the way out.
    const pending: typeof notes = [];
    for (const [label, count] of uses) {
      if (!written.has(label)) pending.push({ label, text: '', uses: count, defined: false });
    }
    return [...pending, ...notes];
  });

  /**
   * Take footnote definitions out of the WYSIWYG canvas: the
   * `footnote_definition` node a real definition parses into, and a paragraph
   * someone typed one into by hand — the latter only once the caret has
   * moved off it, so you can finish typing one first. Not an undo step.
   */
  function harvestFootnotes() {
    if (!crepe) return;
    try {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { doc, selection } = view.state;
        const found: Array<{ from: number; to: number }> = [];
        doc.forEach((node, offset) => {
          const to = offset + node.nodeSize;
          // Never pull a block out from under the caret.
          if (selection.from < to && selection.to > offset) return;
          const isNote =
            node.type.name === 'footnote_definition' ||
            (node.isTextblock && startsDefinition(node.textBetween(0, node.content.size, '\n', '\n')));
          if (isNote) found.push({ from: offset, to });
        });
        if (found.length === 0) return;

        const tr = view.state.tr;
        // Back to front: deleting an earlier block would shift the rest.
        for (const range of found.reverse()) tr.delete(range.from, range.to);
        tr.setMeta('addToHistory', false);
        tidying = true;
        view.dispatch(tr);
      });
    } catch {
      // View not ready or mid-teardown; the next update tries again.
    }
  }

  /**
   * The footnote the caret is on, or null. In Source that is a text range;
   * in the canvas a citation is an atom node, selected by a click or sitting
   * against the caret, so both readings count.
   */
  function footnoteAtCursor(): string | null {
    if (mode === 'source' && cm) {
      return footnoteAt(cm.state.doc.toString(), cm.state.selection.main.head);
    }
    if (!crepe) return null;
    let label: string | null = null;
    try {
      crepe.editor.action((ctx) => {
        const { selection } = ctx.get(editorViewCtx).state;
        const selected = (selection as { node?: { type: { name: string }; attrs: { label?: string } } }).node;
        const candidates = [selected, selection.$from.nodeBefore, selection.$from.nodeAfter];
        for (const node of candidates) {
          if (node?.type.name === 'footnote_reference') {
            label = String(node.attrs['label'] ?? '');
            return;
          }
        }
      });
    } catch {
      // View not ready — nothing is under a caret that doesn't exist.
    }
    return label;
  }

  /**
   * The footnote key — one key between a citation and the note behind it.
   * On a citation (or in a note, in Source) it opens that note ready to
   * write. Anywhere else it cites the next number, creates the note, and
   * opens that. The same key in the dialog comes back.
   */
  function toggleFootnotes() {
    if (mode === 'preview') return;
    // Everything below rebuilds the document from `current`, and in the
    // canvas `current` lags by Milkdown's own ~200 ms — so a sentence typed
    // and footnoted in one movement was lost. Read the canvas back first.
    syncFromCanvas();
    const existing = footnoteAtCursor();
    if (existing) {
      footnoteFocus = existing;
      footnotesOpen = true;
      return;
    }
    // `nextLabel` numbers from 1 and skips what is taken.
    const label = nextLabel(current);
    applyFootnotes(appendDefinition(current, label, ''), [label], false);
    footnoteFocus = label;
    footnotesOpen = true;
  }

  /** Put the caret where a note is cited, or hand focus back as it was. */
  function returnFromFootnotes(label: string | null) {
    const reference = label ? findReferences(current).find((candidate) => candidate.label === label) : undefined;

    if (mode === 'source' && cm) {
      if (reference) {
        const at = Math.min(reference.to, cm.state.doc.length);
        cm.dispatch({
          selection: { anchor: at },
          effects: EditorView.scrollIntoView(at, { y: 'center' }),
        });
      }
      cm.focus();
      return;
    }
    if (!crepe) return;
    try {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.focus();
        if (!label) return;
        let at: number | null = null;
        view.state.doc.descendants((node, pos) => {
          if (at !== null) return false;
          if (node.type.name === 'footnote_reference' && node.attrs['label'] === label) {
            // After the citation: where you would carry on writing.
            at = pos + node.nodeSize;
            return false;
          }
          return true;
        });
        if (at === null) return;
        const selection = Selection.near(view.state.doc.resolve(at));
        view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
      });
    } catch {
      // View not ready; focus is the most it could have done anyway.
    }
  }

  /**
   * Write the dialog's list back into the document: removals and renames
   * first (so the text edits and additions address labels that still
   * exist), each one function from the model that keeps a definition and its
   * citations in step.
   */
  function saveFootnotes(rows: FootnoteRow[], options: FootnoteSaveOptions = { returnTo: null }) {
    footnotesOpen = false;
    footnoteFocus = undefined;
    const kept = new Set(rows.map((row) => row.original).filter((label) => label !== null));

    // This rewrites the whole document from `current`, so `current` has to
    // BE the document first.
    syncFromCanvas();
    let md = current;
    // Citations live in the prose, so touching one means the canvas has to be
    // told; a note's own text never appears there.
    let touchedProse = false;

    for (const note of footnoteNotes) {
      if (!kept.has(note.label)) {
        md = removeFootnote(md, note.label);
        touchedProse = true;
      }
    }
    for (const row of rows) {
      if (row.original !== null && row.original !== row.label) {
        md = renameFootnote(md, row.original, row.label);
        touchedProse = true;
      }
    }
    for (const row of rows) {
      // `defined` and not `original`: a row can be known to the document by
      // its citations while its note has still to be written.
      md = row.defined ? setFootnoteText(md, row.label, row.text) : appendDefinition(md, row.label, row.text);
    }

    applyFootnotes(md, rows.filter((row) => row.cite).map((row) => row.label), touchedProse);
    // After the document has the change: the citation to land on may be one
    // that was just written.
    returnFromFootnotes(options.returnTo);
  }

  /** Land the rewritten document — and any new citations — in the live editor. */
  function applyFootnotes(md: string, cite: string[], touchedProse: boolean) {
    if (mode === 'source' && cm) {
      const references = cite.map((label) => `[^${label}]`).join('');
      // Keep a citation out of the notes block: with the caret at the end of
      // the document, "here" means the end of the prose, not inside a note.
      const limit = findDefinitions(md)[0]?.from ?? md.length;
      // `to`, not `head`: a citation goes after what it cites, whichever end
      // of a selection the caret happens to be at.
      const at = Math.min(cm.state.selection.main.to, limit);
      const text = md.slice(0, at) + references + md.slice(at);
      // One transaction, so one undo takes the whole change back.
      cm.dispatch({
        changes: { from: 0, to: cm.state.doc.length, insert: text },
        selection: { anchor: at + references.length },
      });
      cm.focus();
      return;
    }

    if (touchedProse && crepe) {
      // A rename or a deletion rewrites citations that ARE in the canvas;
      // replacing the document is the one way to do that which can't drift.
      emit(md, { silent: true });
      crepe.editor.action(replaceAll(md));
    } else {
      // Only the notes changed, and the canvas never showed them.
      emit(md);
    }
    for (const label of cite) citeFootnote(label);
    if (cite.length > 0) syncFromCanvas();
  }

  /**
   * Read the canvas back into the markdown now rather than in 200 ms.
   * Silent, because the debounced update is still coming and is the one that
   * reports the change.
   */
  function syncFromCanvas() {
    if (!crepe) return;
    try {
      const md = crepe.editor.action(readMarkdown());
      if (typeof md === 'string') {
        emit(restoreDefinitions(current, unmangle(md)), { silent: true });
      }
    } catch {
      // View not ready; the debounced update will catch up.
    }
  }

  /**
   * `[^label]` becomes a citation as it is typed. The GFM preset has the node
   * but no input rule, and GFM only reads `[^x]` as a reference when its
   * definition is in the same parse — which it no longer is. Skipped inside
   * an inline code span, where `[^1]` is a sample of the syntax.
   */
  const footnoteReferenceRule = milkdownInputRule(
    () =>
      new InputRule(/\[\^([^\]\s]+)\]$/, (state, match, start, end) => {
        const reference = state.schema.nodes['footnote_reference'];
        if (!reference) return null;
        if (state.doc.resolve(start).marks().some((mark) => mark.type.spec.code)) return null;
        return state.tr.replaceWith(start, end, reference.create({ label: match[1] }));
      })
  );

  /**
   * Put a citation at the cursor in the canvas, built as a node. Where the
   * schema has no such node the markdown goes in as text instead.
   */
  function citeFootnote(label: string) {
    if (!crepe) return;
    let placed = false;
    try {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const reference = view.state.schema.nodes['footnote_reference'];
        if (!reference) return;
        view.focus();
        // A citation goes AFTER what it cites. Collapsing to the end of the
        // selection first is not a nicety: `replaceSelectionWith` replaces,
        // so citing a sentence somebody had selected DELETED that sentence.
        const tr = view.state.tr;
        tr.setSelection(Selection.near(tr.doc.resolve(view.state.selection.to)));
        view.dispatch(tr.replaceSelectionWith(reference.create({ label }), false));
        placed = true;
      });
    } catch {
      // View not ready; the text form below still works.
    }
    if (!placed) replaceOrInsert(`[^${label}]`, null, { inline: true });
  }

  /** Footnotes that will silently do nothing, named while there's time. */
  const footnoteIssues = $derived.by(() => {
    const { orphans, unused, duplicates } = report(previewSource);
    const parts: string[] = [];
    if (orphans.length) parts.push(`no definition for ${orphans.map((l) => `[^${l}]`).join(', ')}`);
    if (unused.length) parts.push(`never referenced: ${unused.map((l) => `[^${l}]`).join(', ')}`);
    if (duplicates.length) parts.push(`defined twice: ${duplicates.map((l) => `[^${l}]`).join(', ')}`);
    return parts.join(' · ');
  });

  /* ── Writing back into whichever editor is live ────────────────────── */

  /**
   * Put `text` into the document: replacing `range` in source mode when one
   * was given, otherwise at the cursor. Milkdown's `insert` writes at the
   * current selection, and an unfocused editor has none — focusing the view
   * first gives it a real selection to write at.
   */
  function replaceOrInsert(text: string, range: { from: number; to: number } | null, options: { inline?: boolean } = {}) {
    if (mode === 'source' && cm) {
      const target = range ?? { from: cm.state.selection.main.from, to: cm.state.selection.main.to };
      cm.dispatch({ changes: { ...target, insert: text } });
      cm.focus();
      return;
    }
    if (!crepe) return;
    try {
      crepe.editor.action((ctx) => ctx.get(editorViewCtx).focus());
    } catch {
      // View not ready — `insert` still works if a selection exists.
    }
    // Block by default: a fence or an image is its own paragraph. `inline`
    // keeps a fragment in the sentence it was written into.
    crepe.editor.action(insert(text, options.inline ?? false));
  }

  /* ── Mounting ──────────────────────────────────────────────────────── */

  async function mountCrepe() {
    // Crepe asks for display URLs synchronously as it renders the document.
    try {
      await assets.preload?.(current);
    } catch {
      // Unresolvable images show as broken; the text is still editable.
    }
    if (torn || mode !== 'wysiwyg' || !root) return;
    const instance = new Crepe({
      root,
      defaultValue: current,
      features: {
        // Ours instead — MathLive everywhere, and display maths that is a
        // formula rather than a code block. See lib/math/node.ts.
        [Crepe.Feature.Latex]: false,
      },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: placeholder },
        [Crepe.Feature.ImageBlock]: {
          onUpload: uploadImage,
          proxyDomURL: proxyImage,
        },
        [Crepe.Feature.CodeMirror]: {
          // Crepe ships NO languages by default, so code blocks would have
          // neither highlighting nor a populated language picker.
          languages: codeBlockLanguages,
          // In-editor diagram preview: mermaid blocks show the picture
          // without leaving Edit mode.
          renderPreview: (
            language: string,
            content: string,
            applyPreview: (v: null | string | HTMLElement) => void
          ) => {
            if (language.toLowerCase() !== 'mermaid' || !content.trim()) return null;
            renderDiagram(content)
              .then((svg) => {
                const wrap = document.createElement('div');
                wrap.className = 'mermaid-preview';
                wrap.innerHTML = svg;
                applyPreview(wrap);
              })
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message.split('\n')[0]! : String(err);
                applyPreview(`Diagram error: ${message}`);
              });
            return 'Rendering diagram…';
          },
        },
      },
    });
    crepe = instance;
    instance.editor.use(footnoteReferenceRule);
    // remark-math first: the schema's parse/serialize runners are written
    // against the mdast nodes it produces.
    instance.editor
      .use(remarkMathPlugin)
      .use(strictMathPlugin)
      .use(mathInlineSchema)
      .use(mathBlockSchema)
      .use(mathInlineInputRule)
      .use(mathEditPlugin((target) => (math = { ...target, range: null })));
    instance.on((listener) => {
      // `current` is still the pre-update markdown here, which is what the
      // footnote repair diffs against.
      listener.markdownUpdated((_ctx, md) => {
        const silent = tidying;
        tidying = false;
        emit(restoreDefinitions(current, unmangle(md)), { silent });
        // Not inline: this dispatches, and ProseMirror is mid-update.
        queueMicrotask(harvestFootnotes);
      });
      // A note typed by hand is filed away when the caret leaves it.
      listener.selectionUpdated(() => queueMicrotask(harvestFootnotes));
    });
    await instance.create();
    // Torn down or switched away while that was happening: destroyEditor
    // took this instance (and is destroying it), so there is nothing to
    // decorate or watch.
    if (crepe !== instance) return;
    if (torn || !root) {
      crepe = null;
      void instance.destroy();
      return;
    }
    // Definitions in the loaded document are notes, not blocks to edit here.
    harvestFootnotes();

    // Crepe re-renders image blocks on its own schedule (mount, selection,
    // undo), so re-apply the ✏ affordance whenever the tree changes.
    decorateDrawings();
    blockObserver = new MutationObserver(() => decorateDrawings());
    blockObserver.observe(root, { childList: true, subtree: true });
  }

  /** Source mode chrome, on the theme's --editor-* tokens. */
  const sourceChrome = EditorView.theme({
    '&': {
      backgroundColor: 'transparent',
      color: 'var(--text-color)',
      fontSize: 'var(--font-size-base)',
      minHeight: 'var(--editor-min-height)',
    },
    '.cm-content': {
      caretColor: 'var(--editor-cursor)',
      fontFamily: 'var(--font-mono)',
      padding: 'var(--space-3)',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--editor-cursor)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: 'var(--editor-selection)' },
    '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': {
      backgroundColor: 'var(--editor-gutter-bg)',
      color: 'var(--editor-gutter-fg)',
      borderRight: '1px solid var(--border-color)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--editor-tooltip-bg)',
      color: 'var(--editor-tooltip-fg)',
      border: '1px solid var(--editor-tooltip-border)',
      borderRadius: 'var(--radius-sm)',
      boxShadow: 'var(--shadow-2)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--font-size-sm)',
      maxHeight: '15em',
    },
    '.cm-tooltip-autocomplete > ul > li': { padding: '2px 6px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--editor-tooltip-selected-bg)',
      color: 'var(--editor-tooltip-selected-fg)',
    },
    '.cm-completionMatchedText': {
      color: 'var(--editor-match-fg)',
      textDecoration: 'none',
      fontWeight: '700',
    },
    '.cm-completionDetail': { color: 'var(--text-muted-color)', fontStyle: 'italic' },
    '.cm-completionInfo': {
      backgroundColor: 'var(--editor-tooltip-bg)',
      color: 'var(--editor-tooltip-fg)',
      border: '1px solid var(--editor-tooltip-border)',
      maxWidth: '24rem',
    },
  });

  /** Markdown's own structure, lightly inked: the text stays the text. */
  const sourceHighlight = HighlightStyle.define([
    { tag: tags.heading, color: 'var(--syntax-type)', fontWeight: '700' },
    { tag: tags.strong, fontWeight: '700' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: [tags.link, tags.url], color: 'var(--color-primary)' },
    { tag: tags.monospace, color: 'var(--syntax-keyword)' },
    { tag: tags.quote, color: 'var(--syntax-comment)' },
    { tag: [tags.processingInstruction, tags.meta, tags.labelName], color: 'var(--syntax-punctuation)' },
    { tag: tags.contentSeparator, color: 'var(--syntax-punctuation)' },
  ]);

  function mountCodeMirror() {
    cm = new EditorView({
      parent: root,
      state: EditorState.create({
        doc: current,
        extensions: [
          history(),
          // completionKeymap first: Enter/Tab must reach the popup before the
          // default keymap turns them into a newline or an indent.
          keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
          markdown(),
          sourceChrome,
          syntaxHighlighting(sourceHighlight),
          // `override` rather than adding a source: markdown ships no
          // completions, and this keeps the popup to footnotes only.
          autocompletion({ override: [footnoteCompletions] }),
          footnoteGutter(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': 'Markdown source' }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) emit(update.state.doc.toString());
          }),
        ],
      }),
    });
  }

  async function destroyEditor() {
    flush();
    blockObserver?.disconnect();
    blockObserver = null;
    if (crepe) {
      const instance = crepe;
      crepe = null;
      await instance.destroy();
    }
    if (cm) {
      cm.destroy();
      cm = null;
    }
    if (root) root.innerHTML = '';
  }

  /** Switch views; the live markdown carries over. */
  export async function setMode(next: Mode): Promise<void> {
    if (mode === next) return;
    await destroyEditor();
    if (torn) return;
    mode = next;
    onMode?.(next);
    if (next === 'wysiwyg') await mountCrepe();
    else if (next === 'source') mountCodeMirror();
    // preview renders from `previewSource` — no editor instance
  }

  /**
   * Open a tool from anywhere: the toolbar, a key, or the command palette.
   * Preview has no editor to insert into, and the toolbar buttons are
   * disabled there for the same reason.
   */
  export function openTool(tool: ToolId): void {
    if (mode === 'preview') return;
    if (tool === 'formula') openMath();
    else if (tool === 'diagram') openDiagram();
    else if (tool === 'drawing') void openDrawing();
    else toggleFootnotes();
  }

  /** Which tool dialog, if any, is up. */
  const dialogOpen = () => footnotesOpen || diagram !== null || math !== null || drawing !== undefined;

  /**
   * The tool keys are claimed on the CAPTURE phase of the editor element, not
   * with an onkeydown: a real keypress inside the ProseMirror canvas never
   * reached a bubble handler (the editors consume Alt-combinations on the way
   * up). Capture runs before either editor sees the key. A dialog that is
   * already open keeps its own keys — the footnote dialog closes on the same
   * key that opened it, and the others would reopen on top of themselves.
   */
  function onEditorKeydown(event: KeyboardEvent): void {
    if (dialogOpen()) return;
    const tool = toolFor(event, shortcuts);
    if (!tool) return;
    event.preventDefault();
    event.stopPropagation();
    openTool(tool);
  }

  /** This editor, as the command palette sees it (lib/ui/commands.ts). */
  const handle: EditorHandle = { canInsert: () => mode !== 'preview' && !torn };

  onMount(() => {
    attachStyle(
      'milkdown-crepe',
      [
        prosemirrorCss,
        resetCss,
        blockEditCss,
        codeMirrorCss,
        cursorCss,
        imageBlockCss,
        linkTooltipCss,
        listItemCss,
        placeholderCss,
        toolbarCss,
        tableCss,
        frameCss,
      ].join('\n')
    );
    // MathLive's layout rules, for the canvas and the preview alike — the
    // vendored copy, which borrows its faces from the font stylesheet.
    ensureMathCss();
    if (initialMode === 'wysiwyg') void mountCrepe();
    else if (initialMode === 'source') mountCodeMirror();
    onReady?.({ getValue: getMarkdown, flush });

    editorEl.addEventListener('keydown', onEditorKeydown, true);
    const onFocus = () => touchEditor(handle);
    editorEl.addEventListener('focusin', onFocus);
    const unregister = registerEditor(handle);
    const onTool = (event: Event) => {
      if (activeEditor() !== handle) return;
      const detail = (event as CustomEvent<OpenEditorToolDetail>).detail;
      if (detail && !dialogOpen()) openTool(detail.tool);
    };
    window.addEventListener(OPEN_EDITOR_TOOL_EVENT, onTool);
    const stopShortcuts = onShortcutsChange((next) => (deviceShortcuts = next));
    return () => {
      editorEl?.removeEventListener('keydown', onEditorKeydown, true);
      editorEl?.removeEventListener('focusin', onFocus);
      unregister();
      window.removeEventListener(OPEN_EDITOR_TOOL_EVENT, onTool);
      stopShortcuts();
    };
  });

  onDestroy(() => {
    torn = true;
    void destroyEditor();
  });

  /** `Write a formula (Alt+F)` — a button's tooltip, key and all. */
  const withKey = (id: ToolId, title: string) =>
    shortcuts[id] ? `${title} (${shortcutLabel(shortcuts[id])})` : title;

  const TOOL_TITLES: Record<ToolId, string> = {
    formula: 'Write a formula — visually, not as LaTeX; double-click a formula to edit it',
    diagram: 'Insert or edit a mermaid diagram',
    drawing: 'Draw — an Excalidraw canvas; select an existing drawing first to edit it',
    footnotes: 'Footnotes — write, retitle and remove the notes at the foot of the document',
  };

  function onToolButton(tool: ToolId) {
    // The footnote button opens the list as it stands; its key also cites.
    if (tool === 'footnotes') footnotesOpen = true;
    else openTool(tool);
  }
</script>

<div class="editor" data-testid="md-editor" style={`--editor-min-height: ${minHeight}`} bind:this={editorEl}>
  <div class="editor-toolbar" role="toolbar" aria-label="Editor tools">
    {#each TOOLS as tool (tool.id)}
      <button
        type="button"
        class="tool"
        data-testid="md-tool-{tool.id}"
        title={withKey(tool.id, TOOL_TITLES[tool.id])}
        disabled={mode === 'preview'}
        onclick={() => onToolButton(tool.id)}
      >
        <span aria-hidden="true">{tool.glyph}</span>
        {tool.label}
        {#if tool.id === 'footnotes' && footnoteNotes.length > 0}<span class="count">{footnoteNotes.length}</span>{/if}
        {#if shortcuts[tool.id]}<kbd data-testid="md-key-{tool.id}">{shortcutLabel(shortcuts[tool.id])}</kbd>{/if}
      </button>
    {/each}
    <span class="toolbar-gap"></span>
    <button
      type="button"
      class="mode"
      class:active={mode === 'wysiwyg'}
      aria-pressed={mode === 'wysiwyg'}
      aria-label="Edit"
      data-testid="md-mode-wysiwyg"
      title="Rich editing"
      onclick={() => void setMode('wysiwyg')}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M12.854.146a.5.5 0 0 0-.707 0L10.5 1.793 14.207 5.5l1.647-1.646a.5.5 0 0 0 0-.708zm.646 6.061L9.793 2.5 3.293 9H3.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.207zm-7.468 7.468A.5.5 0 0 1 6 13.5V13h-.5a.5.5 0 0 1-.5-.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.5-.5V10h-.5a.5.5 0 0 1-.175-.032l-.179.178a.5.5 0 0 0-.11.168l-2 5a.5.5 0 0 0 .65.65l5-2a.5.5 0 0 0 .168-.11z"
        />
      </svg>
    </button>
    <button
      type="button"
      class="mode"
      class:active={mode === 'source'}
      aria-pressed={mode === 'source'}
      aria-label="Source"
      data-testid="md-mode-source"
      title="Raw markdown"
      onclick={() => void setMode('source')}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M0 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2zm11.5 1a.5.5 0 0 0-.5.5v3.793L9.854 8.146a.5.5 0 1 0-.708.708l2 2a.5.5 0 0 0 .708 0l2-2a.5.5 0 0 0-.708-.708L12 9.293V5.5a.5.5 0 0 0-.5-.5M3.56 7.01h.056l1.428 3.239h.774l1.42-3.24h.056V11h1.073V5.001h-1.2l-1.71 3.894h-.039l-1.71-3.894H2.5V11h1.06z"
        />
      </svg>
    </button>
    <button
      type="button"
      class="mode"
      class:active={mode === 'preview'}
      aria-pressed={mode === 'preview'}
      aria-label="Preview"
      data-testid="md-mode-preview"
      title="How it renders"
      onclick={() => void setMode('preview')}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8 1.783C7.015.936 5.587.81 4.287.94c-1.514.153-3.042.672-3.994 1.105A.5.5 0 0 0 0 2.5v11a.5.5 0 0 0 .707.455c.882-.4 2.303-.881 3.68-1.02 1.409-.142 2.59.087 3.223.877a.5.5 0 0 0 .78 0c.633-.79 1.814-1.019 3.222-.877 1.378.139 2.8.62 3.681 1.02A.5.5 0 0 0 16 13.5v-11a.5.5 0 0 0-.293-.455c-.952-.433-2.48-.952-3.994-1.105C10.413.809 8.985.936 8 1.783"
        />
      </svg>
    </button>
  </div>

  {#if notice}
    <p class="banner banner-danger notice" role="status" data-testid="md-editor-notice">{notice}</p>
  {/if}

  {#if footnoteIssues}
    <p class="footnote-issues" data-testid="md-footnote-issues">⚠ Footnotes — {footnoteIssues}</p>
  {/if}

  <div
    class="editor-root"
    class:source={mode === 'source'}
    class:hidden={mode === 'preview'}
    data-testid={mode === 'source' ? 'md-source' : 'md-canvas'}
    bind:this={root}
  ></div>

  {#if mode === 'preview'}
    <div class="preview-pane">
      <MarkdownPreview markdown={previewSource} resolveImage={assets.resolve?.bind(assets)} nonce={previewNonce} />
    </div>
  {/if}
</div>

{#if math}
  <MathDialog initial={math.latex} display={math.display} onSave={saveMath} onCancel={() => (math = null)} />
{/if}

{#if diagram}
  <DiagramDialog initial={diagram.initial} onSave={saveDiagram} onCancel={() => (diagram = null)} />
{/if}

{#if drawing !== undefined}
  <DrawingDialog initial={drawing} onSave={saveDrawing} onCancel={() => (drawing = undefined)} />
{/if}

{#if footnotesOpen}
  <FootnoteDialog
    closeKey={shortcuts.footnotes}
    notes={footnoteNotes}
    focusLabel={footnoteFocus}
    onSave={saveFootnotes}
    onCancel={() => {
      footnotesOpen = false;
      footnoteFocus = undefined;
    }}
  />
{/if}

<style>
  .editor {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    overflow: hidden;
  }

  .editor-toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2);
    border-bottom: 1px solid var(--border-color);
    flex-wrap: wrap;
  }

  .toolbar-gap {
    flex: 1;
  }

  .editor-toolbar button {
    display: inline-flex;
    align-items: center;
    gap: 0.3em;
    border: none;
    background: none;
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    font-weight: 600;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-md);
    cursor: pointer;
  }

  .editor-toolbar button:hover {
    color: var(--text-color);
  }

  .editor-toolbar button.tool:not(:disabled):hover {
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
  }

  .editor-toolbar button.active {
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
  }

  .editor-toolbar button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  /* The key that opens each tool, on the button itself: a shortcut nobody
     can see is a shortcut nobody uses. It IS the device's setting, so a
     rebinding in Settings shows up here at once. */
  .editor-toolbar kbd {
    margin-left: 0.15em;
    padding: 0 0.35em;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 0.8em;
    font-weight: 400;
    opacity: 0.75;
  }

  .editor-toolbar button:disabled kbd {
    /* Preview has nothing to insert into, so the key does nothing either. */
    opacity: 0.4;
  }

  /* A narrow screen is a touch screen, where there is no key to press and
     the room is better spent on the buttons. */
  @media (max-width: 44rem) {
    .editor-toolbar kbd {
      display: none;
    }
  }

  /* How many notes the document carries — the only thing on screen that says
     so, now that the notes themselves are out of the canvas. */
  .editor-toolbar .count {
    display: inline-block;
    min-width: 1.25em;
    padding: 0 0.3em;
    border-radius: var(--radius-full);
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
    font-size: 0.85em;
    text-align: center;
  }

  .notice {
    margin: var(--space-2);
    font-size: var(--font-size-sm);
  }

  /* Advisory, not an error — a footnote that goes nowhere still publishes. */
  .footnote-issues {
    margin: 0;
    padding: var(--space-1) var(--space-3);
    border-bottom: 1px solid var(--border-color);
    border-left: 3px solid var(--color-warning);
    background: var(--color-warning-soft);
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }

  /* The footnote gutter: one clickable marker per line carrying a footnote —
     counted when the line carries more than one. */
  .editor-root.source :global(.cm-footnote-gutter) {
    background: transparent;
    border: none;
    min-width: 1.4em;
  }

  .editor-root.source :global(.cm-footnote-marker) {
    background: none;
    border: none;
    padding: 0 0.2em;
    cursor: pointer;
    line-height: inherit;
    color: var(--color-primary);
    font-size: var(--font-size-sm);
  }

  .editor-root.source :global(.cm-footnote-marker:hover) {
    color: var(--color-primary-strong);
  }

  /* `line-height: 0` keeps the superscript from stretching the gutter row. */
  .editor-root.source :global(.cm-footnote-marker .count) {
    font-size: 0.7em;
    line-height: 0;
    margin-left: 0.05em;
  }

  /* Nothing to jump to — a reference with no note, or a note nobody cites. */
  .editor-root.source :global(.cm-footnote-marker.orphan) {
    color: var(--color-warning);
    cursor: help;
  }

  /* Width reservation only — never a target. */
  .editor-root.source :global(.cm-footnote-marker.spacer) {
    visibility: hidden;
    cursor: default;
  }

  .editor-root {
    min-height: var(--editor-min-height);
  }

  .editor-root.source {
    background: var(--editor-bg);
  }

  /* Preview renders its own pane; the empty mount must not leave a gap. */
  .editor-root.hidden {
    display: none;
  }

  .preview-pane {
    padding: var(--space-4);
    background: var(--bg-color);
    min-height: var(--editor-min-height);
  }

  /*
   * Crepe pins an explicit pixel HEIGHT on block images while leaving the
   * width to `max-width: 100%`, then sets `object-fit: cover` — so the
   * moment those two disagree (a wide drawing in a narrow pane) the picture
   * is silently cropped. Let the aspect ratio drive the height instead.
   */
  .editor-root :global(.milkdown .milkdown-image-block > .image-wrapper img) {
    height: auto !important;
    object-fit: contain;
  }

  /* Block images sit centred in the column, matching a published page. */
  .editor-root :global(.milkdown .milkdown-image-block > .image-wrapper) {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  /* The ✏ affordance injected next to Crepe's caption button. */
  .editor-root :global(.milkdown-image-block .operation-item.drawing-edit) {
    cursor: pointer;
    font-size: var(--font-size-sm);
    line-height: 1;
  }

  /* In-editor mermaid preview (Crepe code-block renderPreview). */
  .editor-root :global(.mermaid-preview) {
    display: grid;
    place-items: center;
    padding: var(--space-3);
  }

  .editor-root :global(.mermaid-preview svg) {
    max-width: 100%;
    height: auto;
  }

  /* In-canvas maths (lib/math/node.ts). Both forms are atoms with nothing to
     put a caret in, so they say "click me" instead: a tint under the
     pointer, and ProseMirror's own ring when one is selected. */
  .editor-root :global(.milkdown .math-node) {
    padding: 0 0.15em;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .editor-root :global(.milkdown span.math-node) {
    display: inline-block;
    vertical-align: bottom;
  }

  .editor-root :global(.milkdown .math-node-display) {
    display: block;
    text-align: center;
    overflow-x: auto;
    margin: var(--space-3) 0;
  }

  .editor-root :global(.milkdown .math-node:hover) {
    background: var(--color-primary-soft);
  }

  .editor-root :global(.milkdown .math-node.ProseMirror-selectednode) {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .editor-root :global(.milkdown .math-node-empty) {
    color: var(--text-muted-color);
    font-style: italic;
    font-size: var(--font-size-sm);
  }

  /*
   * Map Crepe's own design tokens onto the theme so the editor follows
   * whatever palette is active — frame.css ships fixed light-palette values
   * that go unreadable on a dark theme. `--crepe-color-outline` paints every
   * chrome icon (toolbar, block handle, slash menu, language picker) plus
   * carets, so it is an ink rather than the hairline; `--crepe-color-hover`
   * has to differ visibly from the surface it sits on.
   */
  .editor-root :global(.milkdown) {
    background: transparent;
    color: var(--text-color);
    --crepe-color-background: transparent;
    --crepe-color-on-background: var(--text-color);
    --crepe-color-surface: var(--surface-raised-color);
    --crepe-color-surface-low: var(--bg-color);
    --crepe-color-on-surface: var(--text-color);
    --crepe-color-on-surface-variant: var(--text-muted-color);
    --crepe-color-outline: var(--text-muted-color);
    --crepe-color-primary: var(--color-primary);
    --crepe-color-secondary: var(--color-primary-soft);
    --crepe-color-on-secondary: var(--color-primary-strong);
    --crepe-color-inverse: var(--text-color);
    --crepe-color-on-inverse: var(--bg-color);
    --crepe-color-inline-code: var(--color-danger);
    --crepe-color-error: var(--color-danger);
    --crepe-color-hover: color-mix(in srgb, var(--color-primary) 14%, var(--surface-raised-color));
    --crepe-color-selected: var(--color-primary-soft);
    --crepe-color-inline-area: var(--bg-color);
    --crepe-font-title: var(--font-body);
    --crepe-font-default: var(--font-body);
    --crepe-font-code: var(--font-mono);
    --crepe-shadow-1: var(--shadow-2);
    --crepe-shadow-2: var(--shadow-2);
  }

  /* Floating chrome gets a drawn edge: a popover with no border on a sheet
     with a faint shadow disappears. */
  .editor-root :global(.milkdown .milkdown-toolbar),
  .editor-root :global(.milkdown .milkdown-slash-menu),
  .editor-root :global(.milkdown .milkdown-link-preview),
  .editor-root :global(.milkdown .milkdown-link-edit),
  .editor-root :global(.milkdown .milkdown-code-block .list-wrapper) {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
  }

  /* Crepe fades the placeholder to 40 % of the text ink (~2.5:1). */
  .editor-root :global(.milkdown .crepe-placeholder::before) {
    color: var(--text-muted-color);
  }

  .editor-root :global(.milkdown .milkdown-slash-menu .tab-group) {
    border-bottom-color: var(--border-color);
  }

  .editor-root :global(.milkdown .milkdown-toolbar .divider),
  .editor-root :global(.milkdown .milkdown-slash-menu .menu-groups .menu-group + .menu-group::before) {
    background: var(--border-color);
  }
</style>
