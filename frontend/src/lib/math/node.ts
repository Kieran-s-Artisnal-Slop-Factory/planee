/**
 * Maths in the WYSIWYG canvas — planee's own, in place of Crepe's.
 *
 * Ported from notey src/lib/notebook/mathNode.ts. Changed: the money rule is
 * the shared ./remark-strict.ts (the preview uses the same one), and
 * `typeset` (./typeset.ts) filters the LaTeX and the markup (./sanitize.ts).
 *
 * Crepe ships a LaTeX feature and it is switched OFF (see mountCrepe). Two
 * reasons, and the first one is the whole point of this module:
 *
 *  1. **It draws with KaTeX and edits with a text box.** Everything else
 *     about maths here is MathLive: the formula dialog, the preview, the
 *     table cells. Two engines means a formula can look one way while you
 *     write it and another way once you stop, which is exactly the thing
 *     nobody can debug.
 *  2. **Its display maths is a code block.** Crepe turns `$$…$$` into a
 *     fenced block labelled LaTeX and renders a preview under it; a
 *     formula you can only edit as source is the problem, not the feature.
 *
 * So the nodes are ours. `remark-math` still does the parsing — it is the
 * same plugin Crepe used and the one remark-stringify needs to write `$…$`
 * and `$$…$$` back out — and the schema below is what turns its mdast nodes
 * into ProseMirror ones and back. Both nodes are ATOMS: there is no cursor
 * inside a formula in the canvas, because editing one is the dialog's job.
 *
 * Nothing here decides how a formula is DRAWN; `typeset` in ./typeset.ts
 * does, so the canvas and the preview cannot drift apart.
 */
import remarkMath from 'remark-math';
import { nodeRule } from '@milkdown/kit/prose';
import { NodeSelection, Plugin, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { $inputRule, $nodeSchema, $prose, $remark } from '@milkdown/kit/utils';
import { typeset } from './typeset';
import { strictMathTransformer } from './remark-strict';

export const MATH_INLINE = 'math_inline';
export const MATH_BLOCK = 'math_block';

/** A formula somebody asked to edit: what it says and how it is set. */
export interface MathTarget {
  latex: string;
  display: boolean;
  /** Where it is in the canvas, for putting the edited one back. */
  pos?: number;
}

/** What an empty formula shows, so it can still be clicked on. */
const EMPTY_LABEL = 'Empty formula';

/**
 * The element a formula lives in.
 *
 * `data-value` is the LaTeX and the parse rule reads it back, so a formula
 * survives being copied, dragged, or round-tripped through the DOM by
 * Milkdown's own insert path — none of which can see ProseMirror attrs.
 */
function mathDom(latex: string, display: boolean): HTMLElement {
  const dom = document.createElement(display ? 'div' : 'span');
  dom.dataset.type = display ? MATH_BLOCK : MATH_INLINE;
  dom.dataset.value = latex;
  dom.className = display ? 'math-node math-node-display' : 'math-node';
  dom.title = 'Double-click to edit this formula';
  if (latex.trim() === '') {
    dom.classList.add('math-node-empty');
    dom.textContent = EMPTY_LABEL;
  } else {
    typeset(dom, latex, display);
  }
  return dom;
}

const valueOf = (dom: HTMLElement | string) =>
  typeof dom === 'string' ? '' : (dom.dataset.value ?? '');

export const mathInlineSchema = $nodeSchema(MATH_INLINE, () => ({
  group: 'inline',
  inline: true,
  atom: true,
  draggable: true,
  attrs: { value: { default: '' } },
  parseDOM: [
    {
      tag: `span[data-type="${MATH_INLINE}"]`,
      getAttrs: (dom) => ({ value: valueOf(dom as HTMLElement) }),
    },
  ],
  toDOM: (node) => mathDom(node.attrs.value as string, false),
  parseMarkdown: {
    match: (node) => node.type === 'inlineMath',
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value as string });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === MATH_INLINE,
    runner: (state, node) => {
      state.addNode('inlineMath', undefined, node.attrs.value as string);
    },
  },
}));

export const mathBlockSchema = $nodeSchema(MATH_BLOCK, () => ({
  group: 'block',
  atom: true,
  draggable: true,
  // A formula is one thing: a selection that starts in the paragraph above
  // should not reach half way into it.
  isolating: true,
  attrs: { value: { default: '' } },
  parseDOM: [
    {
      tag: `div[data-type="${MATH_BLOCK}"]`,
      getAttrs: (dom) => ({ value: valueOf(dom as HTMLElement) }),
    },
  ],
  toDOM: (node) => mathDom(node.attrs.value as string, true),
  parseMarkdown: {
    match: (node) => node.type === 'math',
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value as string });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === MATH_BLOCK,
    runner: (state, node) => {
      state.addNode('math', undefined, node.attrs.value as string);
    },
  },
}));

/** `$…$` as you type it, for anyone who would rather write LaTeX. */
export const mathInlineInputRule = $inputRule((ctx) =>
  nodeRule(/\$(?![\s$])((?:[^$\n])+?)(?<!\s)\$$/, mathInlineSchema.type(ctx), {
    // remark-math's own rule, to the letter: no space just inside either
    // delimiter. Without it, typing the second `$` of "$12 and $15" turns
    // the money into a formula.
    getAttr: (match) => ({ value: match[1] ?? '' }),
  })
);

/** remark-math parses `$…$` and `$$…$$`, and writes them back out again. */
export const remarkMathPlugin = $remark('remarkMath', () => remarkMath);

/**
 * Put back the "maths" that is really money.
 *
 * micromark strips a space from each side of an inline formula, so
 * `$12 and $15` parses as a formula reading "12 and". ./remark-strict.ts
 * turns anything the strict rule rejects back into the exact text it came
 * from — the same pass the preview runs, so the two agree about prices.
 *
 * Used AFTER remark-math; the order plugins are `use`d is the order they run.
 */
export const strictMathPlugin = $remark('strictInlineMath', () => () => strictMathTransformer);

/**
 * Double-click a formula to edit it.
 *
 * Double, not single: one click selects the node, which is how a formula is
 * deleted or dragged, and a dialog that opened on that would make both
 * impossible. `title` on the element says so, since the gesture is only
 * discoverable once you know.
 */
export function mathEditPlugin(onEdit: (target: MathTarget) => void) {
  return $prose(
    () =>
      new Plugin({
        props: {
          handleDoubleClickOn: (view, _pos, node, nodePos, event) => {
            const target = asMath(node, nodePos);
            if (!target) return false;
            event.preventDefault();
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos)));
            onEdit(target);
            return true;
          },
        },
      })
  );
}

function asMath(node: ProseNode, pos?: number): MathTarget | null {
  const name = node.type.name;
  if (name !== MATH_INLINE && name !== MATH_BLOCK) return null;
  return { latex: node.attrs.value as string, display: name === MATH_BLOCK, pos };
}

/**
 * The formula selected in the canvas, or null — what the toolbar button
 * edits instead of inserting a second one beside it.
 */
export function selectedMath(view: EditorView): MathTarget | null {
  const selection = view.state.selection;
  if (!(selection instanceof NodeSelection)) return null;
  return asMath(selection.node, selection.from);
}

/**
 * Take the formula at `pos` out and leave the caret where it was.
 *
 * The edited formula is then written back through the ordinary insert
 * path, which is the one that knows how to place an inline fragment in a
 * sentence and a block on its own line — including when the two swap over,
 * which the "on its own line" switch does.
 *
 * By POSITION, not by selection: the double-click that opens the dialog
 * also sets a node selection, but the browser's own double-click sets a DOM
 * selection of its own, and ProseMirror reads that back as a text selection
 * the moment the editor is focused again. The position is not affected by
 * any of that, and nothing else can edit the document while a modal is up.
 */
export function cutMathAt(view: EditorView, pos: number, toBlock = false): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !asMath(node)) return false;
  let to = pos + node.nodeSize;
  // Going from "in the sentence" to "on its own line" splits the paragraph,
  // and the half after the formula would start with the space that used to
  // separate them — which remark writes out as `&#x20;` because a leading
  // space in markdown is not a space. Take it with the formula.
  if (toBlock && view.state.doc.textBetween(to, Math.min(to + 1, view.state.doc.content.size)) === ' ') {
    to += 1;
  }
  const tr = view.state.tr.delete(pos, to);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size))));
  view.dispatch(tr);
  return true;
}
