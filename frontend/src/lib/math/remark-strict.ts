/**
 * Money is not maths — the one rule the preview and the editor canvas share.
 *
 * micromark's maths is looser than the rule planee renders by: it strips a
 * space from each side of an inline formula the way a code span does, so
 * `$12 and $15` parses as a formula reading "12 and". This walks the tree
 * remark-math just built and turns anything `looksLikeMath` rejects back
 * into the exact text it came from — taken from the source rather than
 * rebuilt from the node, which no longer knows where its spaces were.
 *
 * Use it straight AFTER remark-math: lib/markdown/render.ts does (the
 * preview and table cells), and lib/math/node.ts wraps it for Milkdown (the
 * canvas), so both agree about what is a price.
 *
 * Ported from notey's `strictMathPlugin` (src/lib/notebook/mathNode.ts), split
 * out so the unified pipeline can use it without Milkdown.
 */
import { visit } from 'unist-util-visit';
import { looksLikeMath } from './text';

interface MdastInlineMath {
  type: 'inlineMath';
  value?: string;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

interface Parent {
  children: unknown[];
}

/** The transformer: needs the markdown source, which is the vfile's value. */
export function strictMathTransformer(tree: unknown, file: unknown): void {
  const source = String(file ?? '');
  if (!source) return;
  visit(tree as never, 'inlineMath', (node: MdastInlineMath, index: number | undefined, parent: Parent | undefined) => {
    const from = node.position?.start?.offset;
    const to = node.position?.end?.offset;
    if (from === undefined || to === undefined || index === undefined || !parent) return;
    const raw = source.slice(from, to);
    if (looksLikeMath(raw, source.slice(to, to + 1))) return;
    parent.children.splice(index, 1, { type: 'text', value: raw, position: node.position });
  });
}

/** A unified plugin (no options). */
export default function remarkStrictMath() {
  return strictMathTransformer;
}
