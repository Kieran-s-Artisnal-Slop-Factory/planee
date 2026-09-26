/**
 * Finding and writing maths in markdown SOURCE.
 *
 * The formula editor works in all three views. In the canvas, maths is a
 * ProseMirror node and the editor asks the node what it holds; in Source
 * view there is nothing but a string, so the formula the cursor is standing
 * in has to be found by reading it — which is what this is.
 *
 * Pure string work, deliberately: this is the part that is easy to get
 * subtly wrong (a `$12–$15` price is not a formula) and easy to test.
 *
 * Ported from notey src/lib/notebook/mathText.ts; only the comments naming
 * notey's renderer changed (planee's is lib/markdown/render.ts, which applies
 * the same money rule through ./remark-strict.ts).
 */

export interface MathSpan {
  /** Offsets of the whole construct, delimiters included. */
  from: number;
  to: number;
  /** What is between the delimiters, trimmed of the block form's newlines. */
  latex: string;
  /** `$$…$$` and ```math — set on its own line rather than in the sentence. */
  display: boolean;
}

/** ```math … ``` — the fenced spelling lib/markdown/render.ts also renders. */
const FENCE_OPEN = /^\s{0,3}(?:```|~~~)\s*math\s*$/i;
const FENCE_CLOSE = /^\s{0,3}(?:```|~~~)\s*$/;
/** `$$` alone on a line opens (and closes) a display block. */
const DOLLAR_LINE = /^\s{0,3}\$\$\s*$/;

/**
 * Inline maths, the same two shapes remark-math reads.
 *
 * remark-math's rule, kept to the letter: the content may not begin or end
 * with a space, and a closing `$` followed by a digit is a currency amount,
 * not a delimiter — which is what keeps "$12 and $15" out of here.
 */
const INLINE =
  /\$\$(?![\s$])((?:[^$\n])+?)(?<!\s)\$\$|\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/g;

/**
 * The maths `pos` is inside, or null.
 *
 * Block forms are looked for first: a `$$` on its own line is the opener of
 * a block, never one half of an inline pair.
 */
export function mathAt(text: string, pos: number): MathSpan | null {
  return blockAt(text, pos) ?? inlineAt(text, pos);
}

function blockAt(text: string, pos: number): MathSpan | null {
  const lines = text.split('\n');
  let offset = 0;
  let open: { start: number; bodyStart: number; fenced: boolean } | null = null;
  for (const line of lines) {
    const end = offset + line.length;
    if (open === null) {
      if (FENCE_OPEN.test(line)) open = { start: offset, bodyStart: end + 1, fenced: true };
      else if (DOLLAR_LINE.test(line)) open = { start: offset, bodyStart: end + 1, fenced: false };
    } else if (open.fenced ? FENCE_CLOSE.test(line) : DOLLAR_LINE.test(line)) {
      if (pos >= open.start && pos <= end) {
        return {
          from: open.start,
          to: end,
          latex: text.slice(open.bodyStart, Math.max(open.bodyStart, offset - 1)),
          display: true,
        };
      }
      open = null;
    }
    offset = end + 1;
  }
  return null;
}

function inlineAt(text: string, pos: number): MathSpan | null {
  // Only the line the cursor is on: the inline forms never cross one, and
  // scanning the whole document would let a stray `$` pair up across
  // paragraphs.
  const lineStart = text.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
  const lineEnd = text.indexOf('\n', pos) === -1 ? text.length : text.indexOf('\n', pos);
  const line = text.slice(lineStart, lineEnd);
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(line); m; m = INLINE.exec(line)) {
    const from = lineStart + m.index;
    const to = from + m[0].length;
    if (pos < from || pos > to) continue;
    const display = m[1] !== undefined;
    return { from, to, latex: (display ? m[1] : m[2]) ?? '', display };
  }
  return null;
}

/**
 * Is this `$…$` from the source really maths?
 *
 * micromark's maths is looser than the rule this app renders by: it strips a
 * space from each side the way a code span does, so `$12 and $15` parses as
 * the formula "12 and". planee refuses that (no whitespace just inside a
 * delimiter, no digit straight after a closing `$`) in the preview and the
 * canvas alike, through this — otherwise prices turn into algebra.
 *
 * @param raw  the construct as it appears in the source, delimiters included
 * @param next the character straight after it, if any
 */
export function looksLikeMath(raw: string, next = ''): boolean {
  const parts = /^(\$\$?)([\s\S]*)\1$/.exec(raw);
  if (!parts) return false;
  const body = parts[2] ?? '';
  if (body === '' || /^\s/.test(body) || /\s$/.test(body)) return false;
  // A closing single `$` followed by a digit is the second price in a pair.
  return !(parts[1] === '$' && /\d/.test(next));
}

/**
 * Undo the `\$` remark-stringify writes for every dollar in prose.
 *
 * With maths switched on, the serializer escapes `$` so that text can never
 * be read back as a formula — so "costs $7" comes out of the canvas as
 * "costs \\$7", and a file that has been through the canvas once is not the
 * file that went in. The rendered result is the same either way, which is
 * what makes it easy to miss and unpleasant to find.
 *
 * Code is left exactly as it is: `\$` inside a fence or a code span is
 * something somebody typed on purpose (`\$PATH` in a shell line), because
 * the serializer does not escape in there. Indented code blocks are not
 * recognised — Crepe writes fences.
 */
export function unescapeDollars(md: string): string {
  return md.replace(
    /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|\\\$/g,
    (_match, code: string | undefined) => code ?? '$'
  );
}

/** The largest matrix the size picker offers, each way. */
export const MATRIX_MAX = 10;

/**
 * An empty `rows` × `cols` matrix, as MathLive insertion LaTeX.
 *
 * `#0` in the first cell is where the caret lands; every other cell is a
 * `#?` placeholder, which Tab steps through — so a 3 × 3 is filled in by
 * typing and tabbing, never by clicking. Sizes are clamped to 1…MATRIX_MAX
 * and rounded, so a stray value from the inputs still makes a matrix.
 */
export function matrixLatex(rows: number, cols: number): string {
  const clamp = (n: number) =>
    Math.min(MATRIX_MAX, Math.max(1, Number.isFinite(n) ? Math.round(n) : 1));
  const r = clamp(rows);
  const c = clamp(cols);
  const lines: string[] = [];
  for (let i = 0; i < r; i++) {
    const cells: string[] = [];
    for (let j = 0; j < c; j++) cells.push(i === 0 && j === 0 ? '#0' : '#?');
    lines.push(cells.join(' & '));
  }
  return `\\begin{pmatrix}${lines.join(' \\\\ ')}\\end{pmatrix}`;
}

/**
 * A formula as markdown.
 *
 * A display formula gets its own lines because that is what makes it a
 * block; anything with a newline in it is display whether it was asked for
 * or not, since `$…$` cannot hold one.
 */
export function mathMarkdown(latex: string, display: boolean): string {
  const body = latex.trim();
  if (display || body.includes('\n')) return `$$\n${body}\n$$`;
  return `$${body}$`;
}
