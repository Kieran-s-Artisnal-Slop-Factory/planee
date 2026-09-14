<script module lang="ts">
  /** What `onReady` hands the parent. */
  export interface MarkdownEditorApi {
    /** The live markdown, including edits the debounce hasn't reported yet. */
    getValue(): string;
    /** Report anything outstanding through `onChange` right now. */
    flush(): void;
  }
</script>

<script lang="ts">
  /**
   * A markdown editor with three views over one string:
   *
   *  - Edit    — Milkdown Crepe (ProseMirror + remark: markdown in, markdown
   *              out), with syntax-highlighted code blocks and live mermaid
   *              previews inside them.
   *  - Source  — CodeMirror 6 over the exact same string. The bailout,
   *              since remark-stringify normalizes formatting on round-trip.
   *  - Preview — how a published page would render it.
   *
   * Plus three tools on the toolbar: **Diagram** (mermaid, with templates,
   * completions and a live preview), **Draw** (Excalidraw, saved as a PNG
   * that reopens for editing), and **Footnote**.
   *
   * Footnotes are GFM (`text[^ada]` + `[^ada]: the note`), which remark-gfm
   * already renders — so the work here is authoring them: the button inserts
   * a matched reference and definition and puts the caret in the note, and
   * typing `[^` in Source offers every label already defined, with its text.
   * A status line names references with no definition and definitions nothing
   * refers to, since both fail silently in the output.
   *
   * Milkdown parses GFM footnotes but has no schema node for them, so
   * authoring happens in Source and the button switches you there. A WYSIWYG
   * round-trip would otherwise lose work: references come back intact, but
   * every `[^label]: …` definition is silently dropped, orphaning them. So
   * every update from Crepe is repaired — `restoreDefinitions` puts back what
   * it dropped (nobody can delete one on purpose there; it isn't rendered),
   * and `unescapeFootnotes` undoes serializer escaping.
   *
   * Markdown is the canonical format; this component is a view over the
   * string and nothing more. Changes are debounced before `onChange` fires,
   * so a parent can treat `onChange` as "autosave now".
   *
   * Image bytes — pasted, dropped or drawn — go to the `assets` store, and
   * the markdown keeps whatever relative ref the store hands back.
   *
   * Ported from retoken (af25bc6) src/components/MarkdownEditor.svelte.
   * Changes:
   *  - `assets` defaults to `dbAssets()` (the synced asset table) instead of
   *    a page-lifetime memory store, and the editor awaits `assets.preload`
   *    before mounting Crepe so its synchronous image proxy can resolve every
   *    `assets/<uuid>.<ext>` ref already in the document.
   *  - A refused upload (over 5 MB) shows its message in the tool banner
   *    instead of an unhandled rejection.
   *  - `onReady({ getValue, flush })` hands the parent a synchronous read of
   *    the live markdown, so an explicit Save doesn't depend on the debounce
   *    having fired (MarkdownField uses it). `onChange` is optional.
   *  - Crepe's CSS is attached on mount (lib/markdown/styles.ts) instead of
   *    imported, so pages that merely could open the editor don't link it.
   *  - Import paths.
   */
  import { onDestroy, onMount } from 'svelte';
  import { Crepe } from '@milkdown/crepe';
  // Aliased: Svelte reserves the `$` prefix for local names, so Milkdown's
  // `$inputRule` cannot be bound under its own.
  import {
    $inputRule as milkdownInputRule,
    getMarkdown,
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
  import MarkdownPreview from './MarkdownPreview.svelte';
  import DiagramDialog from './DiagramDialog.svelte';
  import DrawingDialog from './DrawingDialog.svelte';
  import FootnoteDialog, {
    isFootnoteKey,
    type FootnoteRow,
    type FootnoteSaveOptions,
  } from './FootnoteDialog.svelte';
  // `?inline` + attachStyle, not a plain CSS import: Astro would otherwise
  // link these sheets on every page that can lazy-load this editor.
  import crepeCommonCss from '@milkdown/crepe/theme/common/style.css?inline';
  import crepeFrameCss from '@milkdown/crepe/theme/frame.css?inline';
  import { attachStyle } from '../../lib/markdown/styles';

  type Mode = 'wysiwyg' | 'source' | 'preview';

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
  } = $props();

  let mode = $state<Mode>(initialMode);
  // The mermaid workbench: null = closed; `initial` seeds it from an existing
  // fence and `range` marks what to replace in source mode.
  let diagram = $state<{ initial: string; range: { from: number; to: number } | null } | null>(null);
  // The drawing canvas: null = closed. `src` set = reopening that drawing;
  // null = a new one to insert.
  let drawing = $state<{ src: string; blob: Blob } | null | undefined>(undefined);
  /** The footnote workbench: notes are edited there, not in the canvas. */
  let footnotesOpen = $state(false);
  /** Which note it opens on, when it was opened from one. */
  let footnoteFocus = $state<string | undefined>(undefined);
  let toolError = $state<string | null>(null);

  let root: HTMLDivElement;
  let crepe: Crepe | null = null;
  let cm: EditorView | null = null;
  let blockObserver: MutationObserver | null = null;

  /** The live markdown; editors are rebuilt from it on every mode switch. */
  let current = value;
  /** Mirrors `current` for the preview pane (plain `current` isn't reactive). */
  let previewSource = $state(value);
  /** Bumped when bytes change under a ref that didn't move, so preview redraws. */
  let previewNonce = $state(0);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Display URL → the ref as written in the markdown. Crepe swaps refs for
   * displayable URLs before they reach the DOM, so this is how a rendered
   * <img> is recognised as, say, a drawing we can reopen.
   */
  const displayed = new Map<string, string>();

  /**
   * remark-stringify (inside Crepe) escapes leading brackets, mangling
   * `[[wiki links]]` into `\[\[…]]`. Undo exactly that pattern — nothing
   * else — so they survive a WYSIWYG round-trip.
   */
  const unescapeDoubleBrackets = (md: string) => md.replace(/\\(\[)\\?(\[[^\]\n]+\]\])/g, '$1$2');

  /** Repair everything remark-stringify mangles on a WYSIWYG round-trip. */
  const unmangle = (md: string) => unescapeFootnotes(unescapeDoubleBrackets(md));

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
   * Report anything outstanding right now (mode switch / unmount) — whether it
   * is a debounce still counting down or a change that was never scheduled.
   */
  function flush() {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
    if (current === lastSaved) return;
    lastSaved = current;
    onChange?.(current);
  }

  /** Store a pasted or dropped image; the returned ref goes in the markdown. */
  async function uploadImage(file: File): Promise<string> {
    toolError = null;
    try {
      return await assets.save(file, file.name || 'pasted.png');
    } catch (err) {
      // Crepe ignores an empty src, so the refusal is only this message.
      toolError = err instanceof Error ? err.message : String(err);
      return '';
    }
  }

  /** Display proxy: a stored ref → something the browser can show. */
  function proxyImage(url: string): string {
    const resolved = assets.resolve?.(url) ?? url;
    displayed.set(resolved, url);
    return resolved;
  }

  /* ── Diagrams ──────────────────────────────────────────────────────── */

  /**
   * The ```mermaid fence containing `pos`, or null. Used in source mode so
   * the Diagram button edits the block you're standing in instead of
   * inserting a second one.
   */
  function mermaidFenceAt(
    text: string,
    pos: number
  ): { from: number; to: number; code: string } | null {
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

  /** Open the workbench — editing the fence at the cursor when there is one. */
  function openDiagram() {
    if (mode === 'source' && cm) {
      const found = mermaidFenceAt(cm.state.doc.toString(), cm.state.selection.main.head);
      diagram = found
        ? { initial: found.code, range: { from: found.from, to: found.to } }
        : { initial: '', range: null };
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
    toolError = null;
    const ref =
      mode === 'source' && cm
        ? drawingRefAt(cm.state.doc.toString(), cm.state.selection.main.head)
        : selectedCrepeDrawing();

    if (!ref) {
      drawing = null; // a blank canvas
      return;
    }
    if (!assets.load) {
      toolError = 'This asset store cannot read images back, so drawings open blank.';
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

    if (target && assets.replace) {
      // The old display URL may be about to be revoked, so any <img> still
      // pointing at it (Crepe's DOM) has to be re-pointed by hand —
      // otherwise the editor shows a broken image until it next re-renders.
      const stale = assets.resolve?.(target.src);
      try {
        await assets.replace(target.src, blob);
      } catch (err) {
        toolError = err instanceof Error ? err.message : String(err);
        return;
      }
      const fresh = proxyImage(target.src);
      if (stale && fresh && stale !== fresh && root) {
        for (const img of root.querySelectorAll('img')) {
          if (img.getAttribute('src') === stale) img.setAttribute('src', fresh);
        }
      }
      previewNonce++;
      return;
    }

    let src: string;
    try {
      src = await assets.save(blob, drawingFilename());
    } catch (err) {
      toolError = err instanceof Error ? err.message : String(err);
      return;
    }
    replaceOrInsert(`![Drawing](${src})`, null);
  }

  /* ── Footnotes ─────────────────────────────────────────────────────── */

  /**
   * Complete a footnote label after `[^`, offering every label the document
   * already defines with its note text as the detail — the point being that
   * you can cite something a page and a half up without going to look for
   * what you called it.
   *
   * Not offered on a definition line: `[^` at the start of a line is you
   * naming a new footnote, not referring to an existing one.
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
      return link.role === 'ref'
        ? `[^${link.label}] has no definition`
        : `[^${link.label}] is never referenced`;
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
   * goes back to where it was cited. Those are the two moves you actually make
   * while writing — "what did I say in that note?" and "where did I cite
   * this?" — and both otherwise mean scrolling and searching.
   *
   * A gutter has room for one marker per line, but a line can cite two notes
   * (or define one while citing another). The marker then stands for all of
   * them: it carries their count, its tooltip lists them, and each click steps
   * to the next — so the second footnote on a line isn't unreachable.
   *
   * An orphan (a reference with no definition, or the reverse) still gets a
   * marker, in the warning colour and with nowhere to jump, so the problem is
   * visible in the margin rather than only in the status line.
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
        return (
          theirs.label === link.label && theirs.role === link.role && theirs.target === link.target
        );
      });
    }
    override toDOM(): HTMLElement {
      const first = this.links[0];
      // The spacer only reserves the gutter's width — it must not look
      // clickable or announce itself to a screen reader. It carries a count
      // too, so the width reserved fits the widest marker rather than the
      // narrowest.
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
      // Warning colour only when the whole line is dead ends; one reachable
      // note among them is still worth a click.
      if (this.links.every((link) => link.target === null)) el.classList.add('orphan');
      el.title = this.links.map(describeLink).join('\n');
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
  const cycleKey = (links: FootnoteLink[]) =>
    links.map((link) => `${link.role}:${link.label}`).join('|');

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
          const index =
            footnoteCycle?.key === key ? (footnoteCycle.index + 1) % jumpable.length : 0;
          footnoteCycle = { key, index };
          const target = jumpable[index]!.target!;
          view.dispatch({
            selection: { anchor: target },
            // Centred rather than merely scrolled into view: the counterpart
            // is usually far away, and landing at the very edge is disorienting.
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
   *
   * Derived from `previewSource`, which every keystroke in either editor
   * updates — so a note typed into the canvas is in this list by the time the
   * dialog opens, and the count on the toolbar moves as you write.
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

    // A citation whose note nobody has written yet is a footnote in progress,
    // not an error to report elsewhere: it gets a row, empty, waiting for the
    // text — and it must not be cited a second time on the way out.
    const pending: typeof notes = [];
    for (const [label, count] of uses) {
      if (!written.has(label)) pending.push({ label, text: '', uses: count, defined: false });
    }
    return [...pending, ...notes];
  });

  /**
   * Take footnote definitions out of the WYSIWYG canvas.
   *
   * A note isn't prose — it hangs off it — and Crepe drops it on the way back
   * out to markdown anyway (`restoreDefinitions` is the repair). Rendering it
   * as a block in the middle of the document is therefore both noise and a
   * lie about what editing it there would achieve, so the block goes and the
   * note lives in the markdown and the dialog instead.
   *
   * Two shapes qualify: the `footnote_definition` node a real definition
   * parses into, and a paragraph someone typed one into by hand. The caret
   * rule is what makes the second bearable — a note is only filed away once
   * you have moved off it, so you can finish typing one first.
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
            (node.isTextblock &&
              startsDefinition(node.textBetween(0, node.content.size, '\n', '\n')));
          if (isNote) found.push({ from: offset, to });
        });
        if (found.length === 0) return;

        const tr = view.state.tr;
        // Back to front: deleting an earlier block would shift the rest.
        for (const range of found.reverse()) tr.delete(range.from, range.to);
        // Not an undo step: the note is still in the document, so stepping
        // back through where it was drawn would undo nothing an author did.
        tr.setMeta('addToHistory', false);
        tidying = true;
        view.dispatch(tr);
      });
    } catch {
      // View not ready or mid-teardown; the next update tries again.
    }
  }

  /**
   * The footnote the caret is on, or null.
   *
   * In *Source* that is a text range, so the model answers it. In the canvas a
   * citation is an atom node: clicking one selects it, and typing beside one
   * leaves the caret against its edge, so both readings count.
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
        const selected = (selection as { node?: { type: { name: string }; attrs: { label?: string } } })
          .node;
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
   * **Alt+0** — one key between a citation and the note behind it.
   *
   * On a citation (or in a note, in *Source*) it opens that note ready to
   * write. Anywhere else it cites the next number, creates the note, and opens
   * that — because "footnote this" is one intention, not three steps. The same
   * key in the dialog comes back, which is why it is a toggle rather than an
   * insert key.
   */
  function toggleFootnotes() {
    if (mode === 'preview') return;
    const existing = footnoteAtCursor();
    if (existing) {
      footnoteFocus = existing;
      footnotesOpen = true;
      return;
    }
    // `nextLabel` numbers from 1 and skips what is taken, so three notes give
    // a fourth rather than a collision.
    const label = nextLabel(current);
    applyFootnotes(appendDefinition(current, label, ''), [label], false);
    footnoteFocus = label;
    footnotesOpen = true;
  }

  /** Put the caret where a note is cited, or hand focus back as it was. */
  function returnFromFootnotes(label: string | null) {
    const reference = label
      ? findReferences(current).find((candidate) => candidate.label === label)
      : undefined;

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
   * Write the dialog's list back into the document.
   *
   * Order matters: removals and renames first, so the text edits and additions
   * that follow are addressing labels that still exist. Each of those steps is
   * one function from the model, and each keeps the definition and its
   * citations in step — that pairing is the whole reason they aren't done by
   * hand here.
   */
  function saveFootnotes(rows: FootnoteRow[], options: FootnoteSaveOptions = { returnTo: null }) {
    footnotesOpen = false;
    footnoteFocus = undefined;
    const kept = new Set(rows.map((row) => row.original).filter((label) => label !== null));

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
        // Renames the citations too, which is the point — and works for a row
        // that is nothing but citations yet.
        md = renameFootnote(md, row.original, row.label);
        touchedProse = true;
      }
    }
    for (const row of rows) {
      // `defined` and not `original`: a row can be known to the document by
      // its citations while its note has still to be written.
      md = row.defined
        ? setFootnoteText(md, row.label, row.text)
        : appendDefinition(md, row.label, row.text);
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
      const at = Math.min(cm.state.selection.main.head, limit);
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
      // A rename or a deletion rewrites citations that ARE in the canvas.
      // Replacing the document is the one way to do that which can't drift
      // from the markdown — the editor stays mounted, and the caret was
      // already given up to the dialog.
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
   *
   * Milkdown debounces `markdownUpdated`, which is right for typing and wrong
   * for an edit this component just made on purpose: the dialog opening on a
   * note would otherwise be told nothing cites it, a fifth of a second before
   * the citation it just inserted arrives. Silent, because the debounced
   * update is still coming and is the one that reports the change.
   */
  function syncFromCanvas() {
    if (!crepe) return;
    try {
      const md = crepe.editor.action(getMarkdown());
      if (typeof md === 'string') {
        emit(restoreDefinitions(current, unmangle(md)), { silent: true });
      }
    } catch {
      // View not ready; the debounced update will catch up.
    }
  }

  /**
   * `[^label]` becomes a citation as it is typed.
   *
   * The GFM preset gives Crepe the node but no input rule for it, so a
   * reference written by hand stayed literal text until something reparsed the
   * document — which meant a trip through *Source* and back to see it. Nor can
   * the parser be asked to do it on the spot: GFM only reads `[^x]` as a
   * reference when its definition is in the same parse, and definitions no
   * longer live in the canvas. So the node is built here.
   *
   * ProseMirror skips input rules inside a code block; the mark check does the
   * same for an inline code span, where `[^1]` is a sample of the syntax
   * rather than a use of it.
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
   * Put a citation at the cursor in the canvas.
   *
   * Built as a node rather than parsed from `[^label]`: on its own that is
   * literal text to GFM — a reference only becomes one when its definition is
   * in the same parse, and the definitions live outside the canvas. Where the
   * schema has no such node the markdown goes in as text instead, which the
   * serializer's escaping is undone for on the way out, exactly as it is for
   * a reference typed by hand.
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
        view.dispatch(view.state.tr.replaceSelectionWith(reference.create({ label }), false));
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
   * was given, otherwise at the cursor.
   *
   * Milkdown's `insert` writes at the current selection — and a freshly
   * mounted editor (or one the author never clicked into, e.g. straight
   * after a mode switch) has no focus, so the insert silently does nothing
   * and the work is lost. Focusing the view first gives it a real selection
   * to write at.
   */
  function replaceOrInsert(
    text: string,
    range: { from: number; to: number } | null,
    options: { inline?: boolean } = {}
  ) {
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

  async function mountCrepe() {
    // Crepe asks for display URLs synchronously as it renders the document.
    try {
      await assets.preload?.(current);
    } catch {
      // Unresolvable images show as broken; the text is still editable.
    }
    if (mode !== 'wysiwyg' || !root) return;
    crepe = new Crepe({
      root,
      defaultValue: current,
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
          // In-editor diagram preview: Crepe renders a preview for languages
          // it knows, so mermaid blocks show the picture without leaving
          // Edit mode.
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
    crepe.editor.use(footnoteReferenceRule);
    crepe.on((listener) => {
      // `current` is still the pre-update markdown here, which is what the
      // footnote repair diffs against.
      listener.markdownUpdated((_ctx, md) => {
        const silent = tidying;
        tidying = false;
        emit(restoreDefinitions(current, unmangle(md)), { silent });
        // Not inline: this dispatches, and ProseMirror is mid-update.
        queueMicrotask(harvestFootnotes);
      });
      // A note typed by hand is filed away when the caret leaves it, which is
      // a selection change and not a document one.
      listener.selectionUpdated(() => queueMicrotask(harvestFootnotes));
    });
    await crepe.create();
    // Definitions in the loaded document are notes, not blocks to edit here.
    harvestFootnotes();

    // Crepe re-renders image blocks on its own schedule (mount, selection,
    // undo), so re-apply the ✏ affordance whenever the tree changes.
    decorateDrawings();
    blockObserver = new MutationObserver(() => decorateDrawings());
    blockObserver.observe(root, { childList: true, subtree: true });
  }

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
          // `override` rather than adding a source: markdown ships no
          // completions, and this keeps the popup to footnotes only.
          autocompletion({ override: [footnoteCompletions] }),
          footnoteGutter(),
          EditorView.lineWrapping,
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
      await crepe.destroy();
      crepe = null;
    }
    if (cm) {
      cm.destroy();
      cm = null;
    }
    if (root) root.innerHTML = '';
  }

  async function setMode(next: Mode) {
    if (mode === next) return;
    await destroyEditor();
    mode = next;
    if (next === 'wysiwyg') await mountCrepe();
    else if (next === 'source') mountCodeMirror();
    // preview renders from `previewSource` — no editor instance
  }

  onMount(() => {
    attachStyle('milkdown-crepe', `${crepeCommonCss}
${crepeFrameCss}`);
    if (initialMode === 'wysiwyg') void mountCrepe();
    else if (initialMode === 'source') mountCodeMirror();
    onReady?.({
      getValue: () => {
        // Milkdown reports canvas edits 200 ms late; read the canvas itself.
        if (mode === 'wysiwyg') syncFromCanvas();
        return current;
      },
      flush,
    });
  });

  onDestroy(() => {
    void destroyEditor();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="editor"
  style={`--editor-min-height: ${minHeight}`}
  onkeydown={(event) => {
    // Both editors let the key bubble; the dialog has its own handler, and
    // owns the shortcut while it is open.
    if (footnotesOpen || !isFootnoteKey(event)) return;
    event.preventDefault();
    toggleFootnotes();
  }}
>
  <div class="editor-toolbar">
    <button
      type="button"
      class="tool"
      title="Insert or edit a mermaid diagram"
      disabled={mode === 'preview'}
      onclick={openDiagram}
    >
      ◇ Diagram
    </button>
    <button
      type="button"
      class="tool"
      title="Draw — select an existing drawing first to edit it"
      disabled={mode === 'preview'}
      onclick={openDrawing}
    >
      ✏ Draw
    </button>
    <button
      type="button"
      class="tool"
      title="Footnotes — write, retitle and remove the notes at the foot of the document"
      disabled={mode === 'preview'}
      onclick={() => (footnotesOpen = true)}
    >
      ⁋ Footnotes
      {#if footnoteNotes.length > 0}<span class="count">{footnoteNotes.length}</span>{/if}
    </button>
    <span class="toolbar-gap"></span>
    <button
      type="button"
      class:active={mode === 'wysiwyg'}
      title="Rich-text editing"
      onclick={() => setMode('wysiwyg')}
    >
      Edit
    </button>
    <button
      type="button"
      class:active={mode === 'source'}
      title="Raw markdown"
      onclick={() => setMode('source')}
    >
      Source
    </button>
    <button
      type="button"
      class:active={mode === 'preview'}
      title="How a published page renders it"
      onclick={() => setMode('preview')}
    >
      Preview
    </button>
  </div>

  {#if toolError}
    <p class="banner banner-danger tool-error">{toolError}</p>
  {/if}

  {#if footnoteIssues}
    <p class="footnote-issues">⚠ Footnotes — {footnoteIssues}</p>
  {/if}

  <div
    class="editor-root"
    class:source={mode === 'source'}
    class:hidden={mode === 'preview'}
    bind:this={root}
  ></div>

  {#if mode === 'preview'}
    <div class="preview-pane">
      <MarkdownPreview
        markdown={previewSource}
        resolveImage={assets.resolve?.bind(assets)}
        nonce={previewNonce}
      />
    </div>
  {/if}
</div>

{#if diagram}
  <DiagramDialog
    initial={diagram.initial}
    onSave={saveDiagram}
    onCancel={() => (diagram = null)}
  />
{/if}

{#if drawing !== undefined}
  <DrawingDialog
    initial={drawing}
    onSave={saveDrawing}
    onCancel={() => (drawing = undefined)}
  />
{/if}

{#if footnotesOpen}
  <FootnoteDialog
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
  }

  .toolbar-gap {
    flex: 1;
  }

  .editor-toolbar button {
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

  /* How many notes the document carries — the only thing on screen that says
     so, now that the notes themselves are out of the canvas. */
  .editor-toolbar .count {
    display: inline-block;
    min-width: 1.25em;
    margin-left: 0.15em;
    padding: 0 0.3em;
    border-radius: var(--radius-full);
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
    font-size: 0.85em;
    text-align: center;
  }

  .tool-error {
    margin: var(--space-2);
    font-size: var(--font-size-sm);
  }

  /* Advisory, not an error — a footnote that goes nowhere still publishes. */
  .footnote-issues {
    padding: var(--space-1) var(--space-3);
    border-bottom: 1px solid var(--border-color);
    background: var(--color-warning-soft);
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }

  /* The `[^` completion popup — CodeEditor.svelte themes its own; this
     editor mounts CodeMirror directly, so it needs the same tokens. */
  .editor-root.source :global(.cm-tooltip) {
    background: var(--editor-tooltip-bg);
    color: var(--editor-tooltip-fg);
    border: 1px solid var(--editor-tooltip-border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-2);
  }

  .editor-root.source :global(.cm-tooltip-autocomplete > ul) {
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    max-height: 15em;
  }

  .editor-root.source :global(.cm-tooltip-autocomplete > ul > li) {
    padding: 2px 6px;
    color: var(--editor-tooltip-fg);
  }

  .editor-root.source :global(.cm-tooltip-autocomplete > ul > li[aria-selected]) {
    background: var(--editor-tooltip-selected-bg);
    color: var(--editor-tooltip-selected-fg);
  }

  .editor-root.source :global(.cm-completionDetail) {
    color: var(--text-muted-color);
    font-style: italic;
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

  /* How many footnotes the marker stands for. `line-height: 0` keeps the
     superscript from stretching the gutter row out of step with the text. */
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

  .editor-root.source :global(.cm-completionInfo) {
    background: var(--editor-tooltip-bg);
    color: var(--editor-tooltip-fg);
    border: 1px solid var(--editor-tooltip-border);
    border-radius: var(--radius-sm);
    max-width: 24rem;
  }

  .editor-root {
    min-height: var(--editor-min-height);
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

  /* Crepe brings its own padding; give CodeMirror matching breathing room. */
  .editor-root.source :global(.cm-editor) {
    min-height: var(--editor-min-height);
    font-size: var(--font-size-base);
    background: transparent;
    color: var(--text-color);
  }

  .editor-root.source :global(.cm-content) {
    padding: var(--space-3);
    font-family: var(--font-mono);
  }

  .editor-root.source :global(.cm-editor.cm-focused) {
    outline: none;
  }

  .editor-root.source :global(.cm-cursor) {
    border-left-color: var(--editor-cursor);
  }

  .editor-root.source :global(.cm-activeLine) {
    background: var(--editor-active-line);
  }

  .editor-root.source :global(.cm-selectionBackground),
  .editor-root.source :global(.cm-editor ::selection) {
    background: var(--editor-selection);
  }

  /*
   * Map Crepe's own design tokens onto the theme so the editor follows
   * whatever palette is active — frame.css ships fixed light-palette values
   * that go unreadable on a dark theme.
   */
  .editor-root :global(.milkdown) {
    background: transparent;
    color: var(--text-color);
    --crepe-color-background: transparent;
    --crepe-color-on-background: var(--text-color);
    --crepe-color-surface: var(--surface-color);
    --crepe-color-surface-low: var(--bg-color);
    --crepe-color-on-surface: var(--text-color);
    --crepe-color-on-surface-variant: var(--text-muted-color);
    --crepe-color-outline: var(--border-color);
    --crepe-color-primary: var(--color-primary);
    --crepe-color-secondary: var(--color-primary-soft);
    --crepe-color-on-secondary: var(--color-primary-strong);
    --crepe-color-inverse: var(--text-color);
    --crepe-color-on-inverse: var(--bg-color);
    --crepe-color-inline-code: var(--color-danger);
    --crepe-color-error: var(--color-danger);
    --crepe-color-hover: var(--surface-raised-color);
    --crepe-color-selected: var(--color-primary-soft);
    --crepe-color-inline-area: var(--bg-color);
    --crepe-font-title: var(--font-body);
    --crepe-font-default: var(--font-body);
    --crepe-font-code: var(--font-mono);
  }
</style>
