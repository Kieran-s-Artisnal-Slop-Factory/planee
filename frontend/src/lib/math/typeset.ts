/**
 * Typeset the maths the render pipeline left as source (D21).
 *
 * lib/markdown/render.ts emits `<span class="math math-inline" data-math="…">`
 * and `<div class="math math-display" data-math="…" data-display>` with the
 * LaTeX as plain text, and imports nothing heavy; this module is the other
 * half. MathLive's `ssr` entry (~390 KB, the LaTeX engine without the editor)
 * is `import()`ed on first use, so a page that never shows a formula never
 * pays for it, and its layout stylesheet rides on the vendored font bundle
 * (./fonts.ts) — nothing is fetched from a CDN.
 *
 * The same engine draws the formula dialog's `<math-field>` and the editor
 * canvas's formula nodes (./node.ts), so a formula looks the same while it is
 * written, while it is edited and once it is saved.
 *
 * Every formula goes through ./sanitize.ts twice: the LaTeX before MathLive
 * sees it, the markup before it reaches the page.
 *
 * Ported from notey src/lib/notebook/math.ts. Changed: the sanitize passes;
 * markup is inserted as a cleaned fragment instead of `innerHTML`; a render
 * that throws shows its source with `math-error` instead of leaving the node
 * half-drawn; `data-display` is read as well as the `math-display` class.
 *
 * Browser-only: it rewrites the DOM in place. Covered by
 * tests/sync/editor-ui.spec.ts, with the filtering itself unit-tested in
 * sanitize.test.ts.
 */
import { ensureMathCss } from './fonts';
import { safeMathFragment, sanitizeLatex } from './sanitize';

/** `convertLatexToMarkup`, once it has arrived. */
type Convert = (latex: string) => string;

let convert: Convert | null = null;
let loading: Promise<Convert> | null = null;

/**
 * MathLive's renderer, loaded once.
 *
 * The `ssr` entry, not the main one: it is the LaTeX engine without the
 * editor, half the size, and it touches no DOM. The editor is a separate
 * chunk that only opens with the formula dialog.
 */
export function loadMathEngine(): Promise<Convert> {
  if (convert) return Promise.resolve(convert);
  loading ??= import('mathlive/ssr').then((m) => {
    convert = (latex) => m.convertLatexToMarkup(latex);
    return convert;
  });
  // A chunk that failed to load (offline before the precache finished) can
  // be retried by the next render.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/**
 * Inline maths sits on the line, so it is set in TEXT style — sums and
 * integrals keep their limits beside them instead of stacking above and
 * below and pushing the line apart. MathLive's own default is display
 * style, which is right for `$$…$$` and wrong in a sentence.
 *
 * A formula that says `\displaystyle` for itself still wins: both are
 * switches, and the later one is the one in force.
 */
const styled = (latex: string, display: boolean) => (display ? latex : `\\textstyle ${latex}`);

/** Draw `latex` into `el` with a loaded engine: filtered in, filtered out. */
function draw(el: HTMLElement, latex: string, display: boolean, render: Convert): void {
  const { latex: safe, removed } = sanitizeLatex(latex);
  let markup: string;
  try {
    markup = render(styled(safe, display));
  } catch (error) {
    // MathLive draws what it cannot parse as red markup rather than
    // throwing; this is the net under that net.
    el.textContent = latex;
    el.classList.add('math-error');
    el.title = error instanceof Error ? error.message : String(error);
    return;
  }
  el.replaceChildren(safeMathFragment(markup, el.ownerDocument));
  if (removed.length > 0) {
    el.classList.add('math-filtered');
    el.title = `Not shown: ${[...new Set(removed)].join(', ')} (not allowed in formulas)`;
  }
}

/**
 * Draw `latex` into `el`, now if the engine is loaded and as soon as it is
 * otherwise.
 *
 * The wait is why the source text goes in first: a formula that is briefly
 * its own LaTeX reads as "not typeset yet", while an empty box reads as a
 * bug.
 */
export function typeset(el: HTMLElement, latex: string, display: boolean): void {
  ensureMathCss();
  if (convert) {
    draw(el, latex, display, convert);
    return;
  }
  el.textContent = latex;
  void loadMathEngine()
    .then((render) => draw(el, latex, display, render))
    .catch(() => {
      // Offline with the chunk not cached yet: the source stays readable.
    });
}

/**
 * Render every `[data-math]` element under `root` exactly once.
 *
 * A node that has been rendered is marked `data-math-rendered`, so calling
 * this again after a partial re-render only touches the new formulas.
 */
export async function renderMathIn(root: ParentNode): Promise<void> {
  const nodes = root.querySelectorAll<HTMLElement>('[data-math]:not([data-math-rendered])');
  if (nodes.length === 0) return;
  ensureMathCss();
  const render = await loadMathEngine();
  for (const node of nodes) {
    // Guard again after the await: a concurrent call may have got here first.
    if (node.hasAttribute('data-math-rendered')) continue;
    node.setAttribute('data-math-rendered', '');
    const source = node.getAttribute('data-math') ?? '';
    const display = node.hasAttribute('data-display') || node.classList.contains('math-display');
    draw(node, source, display, render);
  }
}
