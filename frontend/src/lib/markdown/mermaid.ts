/**
 * Mermaid rendering for every surface that shows a diagram: the markdown
 * preview, the diagram workbench, and Crepe's in-editor code-block preview.
 *
 * mermaid itself (~1 MB) is imported lazily on first use, so a page that
 * never shows a diagram never pays for it.
 *
 * Ported from retoken (af25bc6) src/lib/markdown/mermaid.ts. Changes:
 *  - `securityLevel: 'strict'` is set explicitly (D8): diagram source is user
 *    content that syncs between devices, so labels are encoded and click
 *    handlers/`javascript:` links are disabled regardless of mermaid's default.
 *  - Render ids are `planee-mermaid-<instance>-<n>`: the counter is shared by
 *    every preview on the page (one module instance) and the random instance
 *    tag keeps a second copy of the module (HMR, a stray duplicate chunk)
 *    from reusing an id that is still in the DOM.
 *  - `isDarkScheme` comes from lib/theme-scheme.ts.
 */

import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { isDarkScheme } from '../theme-scheme';

/** mermaid's public surface, kept minimal so we don't depend on its types. */
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  parse(text: string): Promise<unknown>;
  render(id: string, text: string): Promise<{ svg: string }>;
}

let apiPromise: Promise<MermaidApi> | null = null;
let appliedTheme: 'default' | 'dark' | null = null;
let idCounter = 0;
/** Distinguishes this module instance's render ids from any other copy's. */
const instance = Math.random().toString(36).slice(2, 8);

/**
 * The mermaid module, initialized for the current scheme. Re-initializes
 * when the scheme flipped since last time — mermaid's theme is global.
 */
export async function getMermaid(): Promise<MermaidApi> {
  apiPromise ??= import('mermaid').then((m) => m.default as unknown as MermaidApi);
  const mermaid = await apiPromise;
  const theme = isDarkScheme() ? 'dark' : 'default';
  if (theme !== appliedTheme) {
    mermaid.initialize({
      // We always drive rendering ourselves.
      startOnLoad: false,
      theme,
      // User content: encode tags in labels, no click/callback interactivity.
      securityLevel: 'strict',
      // Without this, a diagram that fails to parse makes mermaid append its
      // own "Syntax error in text" bomb graphic to <body> — which piles up at
      // the bottom of the page, far from the diagram that caused it. Errors
      // are surfaced in place instead (renderInto / the workbench).
      suppressErrorRendering: true,
    });
    appliedTheme = theme;
  }
  return mermaid;
}

/**
 * Validate diagram source: null when it parses, else mermaid's own message
 * (first line only — the rest is usually an ASCII drawing of the offending
 * token).
 */
export async function validateDiagram(code: string): Promise<string | null> {
  if (!code.trim()) return null;
  try {
    const mermaid = await getMermaid();
    await mermaid.parse(code);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message.split('\n')[0]!.trim() || 'Invalid diagram';
  }
}

/** Render diagram source to an SVG string; throws mermaid's parse error. */
export async function renderDiagram(code: string): Promise<string> {
  const mermaid = await getMermaid();
  const { svg } = await mermaid.render(`planee-mermaid-${instance}-${++idCounter}`, code);
  return svg;
}

/**
 * Render each `<pre class="mermaid">` in place, replacing its text with the
 * SVG. Done per node (rather than mermaid's own `run()`) so a broken diagram
 * reports itself WHERE IT IS — the source stays visible and the message
 * rides on `data-error` for CSS to show.
 */
export async function renderInto(nodes: HTMLElement[]): Promise<void> {
  if (nodes.length === 0) return;
  await getMermaid();
  await Promise.all(
    nodes.map(async (node) => {
      // Idempotent: rendering replaces the node's text with the SVG, so the
      // source is stashed on first sight. Without this, a second pass over an
      // already-rendered node would try to parse the SVG's own CSS.
      if (node.dataset.mermaidSource === undefined) {
        node.dataset.mermaidSource = node.textContent ?? '';
      }
      if (node.classList.contains('mermaid-rendered')) return;
      const source = node.dataset.mermaidSource;
      if (!source.trim()) return;
      try {
        const svg = await renderDiagram(source);
        node.innerHTML = svg;
        node.classList.add('mermaid-rendered');
        node.classList.remove('mermaid-error');
        delete node.dataset.error;
      } catch (err) {
        const message = err instanceof Error ? err.message.split('\n')[0]! : String(err);
        node.textContent = source;
        node.classList.add('mermaid-error');
        node.dataset.error = message.trim() || 'Invalid diagram';
      }
    })
  );
}

/**
 * Find and render every mermaid block inside a container (or the whole
 * document). Lazy: returns immediately when there is nothing to draw.
 */
export async function mountMermaid(root: ParentNode = document): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>('pre.mermaid')];
  if (nodes.length === 0) return;
  await renderInto(nodes);
}

/* ────────────────────────────────────────────────────────────────────────
 * Authoring aids
 * ──────────────────────────────────────────────────────────────────────── */

/** Starter scaffolds — the fastest path from "blank" to "a diagram". */
export interface DiagramTemplate {
  id: string;
  label: string;
  code: string;
}

export const DIAGRAM_TEMPLATES: DiagramTemplate[] = [
  {
    id: 'flowchart',
    label: 'Flowchart',
    code: `flowchart TD
  A[Start] --> B{Decision?}
  B -->|Yes| C[Do the thing]
  B -->|No| D[Skip it]
  C --> E[Done]
  D --> E`,
  },
  {
    id: 'sequence',
    label: 'Sequence',
    code: `sequenceDiagram
  participant Reader
  participant Site
  Reader->>Site: Asks for a page
  Site-->>Reader: Renders it`,
  },
  {
    id: 'state',
    label: 'State',
    code: `stateDiagram-v2
  [*] --> Draft
  Draft --> InReview: submits
  InReview --> Published: approves
  Published --> [*]`,
  },
  {
    id: 'class',
    label: 'Class',
    code: `classDiagram
  class Theme {
    +String base
    +Overrides overrides
  }
  class Overrides {
    +Map light
    +Map dark
  }
  Theme "1" --> "1" Overrides`,
  },
  {
    id: 'er',
    label: 'ER',
    code: `erDiagram
  SITE ||--o{ PAGE : contains
  PAGE ||--o{ SECTION : contains
  SECTION {
    string title
    string body
  }`,
  },
  {
    id: 'mindmap',
    label: 'Mindmap',
    code: `mindmap
  root((Components))
    Layout
      Sidebar
      Panel
    Content
      Editor
      Preview`,
  },
  {
    id: 'pie',
    label: 'Pie',
    code: `pie title Time spent
  "Writing components" : 55
  "Fixing the theme" : 25
  "Naming things" : 20`,
  },
  {
    id: 'gantt',
    label: 'Gantt',
    code: `gantt
  title Build
  dateFormat YYYY-MM-DD
  section Work
  Scaffold      :a1, 2026-01-01, 5d
  Components    :after a1, 10d`,
  },
];

/**
 * Completion candidates. The first line picks the diagram type, and each
 * type contributes its own keywords — mermaid's grammar is per-diagram, so
 * offering `participant` inside a pie chart would be noise.
 */
const DIAGRAM_TYPES: { label: string; detail: string }[] = [
  { label: 'flowchart TD', detail: 'Flowchart, top-down' },
  { label: 'flowchart LR', detail: 'Flowchart, left-to-right' },
  { label: 'graph TD', detail: 'Flowchart (legacy keyword)' },
  { label: 'sequenceDiagram', detail: 'Interactions over time' },
  { label: 'classDiagram', detail: 'Classes and relationships' },
  { label: 'stateDiagram-v2', detail: 'States and transitions' },
  { label: 'erDiagram', detail: 'Entities and relationships' },
  { label: 'journey', detail: 'User journey' },
  { label: 'gantt', detail: 'Schedule' },
  { label: 'pie', detail: 'Pie chart' },
  { label: 'mindmap', detail: 'Mindmap' },
  { label: 'timeline', detail: 'Timeline' },
  { label: 'quadrantChart', detail: 'Quadrant chart' },
  { label: 'gitGraph', detail: 'Git branches' },
];

const KEYWORDS_BY_TYPE: Record<string, { label: string; detail: string }[]> = {
  flowchart: [
    { label: '-->', detail: 'Arrow' },
    { label: '---', detail: 'Open link' },
    { label: '-.->', detail: 'Dotted arrow' },
    { label: '==>', detail: 'Thick arrow' },
    { label: 'subgraph', detail: 'Group nodes (close with end)' },
    { label: 'end', detail: 'Close a subgraph' },
    { label: 'direction LR', detail: 'Subgraph direction' },
    { label: 'click', detail: 'Node interaction' },
  ],
  sequence: [
    { label: 'participant', detail: 'Declare a participant' },
    { label: 'actor', detail: 'Declare an actor' },
    { label: '->>', detail: 'Solid arrow' },
    { label: '-->>', detail: 'Dashed reply' },
    { label: 'activate', detail: 'Start activation box' },
    { label: 'deactivate', detail: 'End activation box' },
    { label: 'loop', detail: 'Loop block (close with end)' },
    { label: 'alt', detail: 'Alternative block' },
    { label: 'else', detail: 'Alternative branch' },
    { label: 'opt', detail: 'Optional block' },
    { label: 'par', detail: 'Parallel block' },
    { label: 'Note over', detail: 'Annotation' },
    { label: 'end', detail: 'Close a block' },
  ],
  class: [
    { label: 'class', detail: 'Declare a class' },
    { label: '<|--', detail: 'Inheritance' },
    { label: '*--', detail: 'Composition' },
    { label: 'o--', detail: 'Aggregation' },
    { label: '-->', detail: 'Association' },
    { label: '<<interface>>', detail: 'Stereotype' },
  ],
  state: [
    { label: '[*]', detail: 'Start / end state' },
    { label: '-->', detail: 'Transition' },
    { label: 'state', detail: 'Declare a state' },
    { label: 'note right of', detail: 'Annotation' },
    { label: '--', detail: 'Concurrency divider' },
  ],
  er: [
    { label: '||--o{', detail: 'One to many' },
    { label: '||--||', detail: 'One to one' },
    { label: '}o--o{', detail: 'Many to many' },
  ],
  gantt: [
    { label: 'title', detail: 'Chart title' },
    { label: 'dateFormat', detail: 'Input date format' },
    { label: 'section', detail: 'Group of tasks' },
    { label: 'excludes', detail: 'Skip dates' },
  ],
  pie: [{ label: 'title', detail: 'Chart title' }],
  mindmap: [
    { label: 'root((text))', detail: 'Root node' },
    { label: '::icon()', detail: 'Node icon' },
  ],
  journey: [
    { label: 'title', detail: 'Journey title' },
    { label: 'section', detail: 'Journey stage' },
  ],
  timeline: [
    { label: 'title', detail: 'Timeline title' },
    { label: 'section', detail: 'Timeline period' },
  ],
};

/** Which keyword set applies, from the diagram's first non-empty line. */
export function diagramKindOf(code: string): string | null {
  const first = code.split('\n').find((l) => l.trim() && !l.trim().startsWith('%%'))?.trim() ?? '';
  if (/^(flowchart|graph)\b/i.test(first)) return 'flowchart';
  if (/^sequenceDiagram\b/i.test(first)) return 'sequence';
  if (/^classDiagram/i.test(first)) return 'class';
  if (/^stateDiagram/i.test(first)) return 'state';
  if (/^erDiagram\b/i.test(first)) return 'er';
  if (/^gantt\b/i.test(first)) return 'gantt';
  if (/^pie\b/i.test(first)) return 'pie';
  if (/^mindmap\b/i.test(first)) return 'mindmap';
  if (/^journey\b/i.test(first)) return 'journey';
  if (/^timeline\b/i.test(first)) return 'timeline';
  return null;
}

/** Diagram types on the first line, the matching keyword set everywhere else. */
export function mermaidCompletions(
  docText: string,
  onFirstLine: boolean
): { label: string; detail: string; type: string }[] {
  if (onFirstLine) return DIAGRAM_TYPES.map((t) => ({ ...t, type: 'keyword' }));
  const kind = diagramKindOf(docText);
  const words = kind ? (KEYWORDS_BY_TYPE[kind] ?? []) : [];
  return words.map((w) => ({ ...w, type: 'keyword' }));
}

/**
 * CodeMirror completion source for mermaid — shared by the workbench dialog
 * and in-editor code blocks (attached to the language's data there, so it
 * only fires inside mermaid blocks).
 */
export function mermaidCompletionSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[\w[\](){}<>|.=-]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const doc = context.state.doc;
  const onFirstLine = doc.lineAt(context.pos).number === 1;
  const options = mermaidCompletions(doc.toString(), onFirstLine);
  if (options.length === 0) return null;
  return { from: word.from, options, validFor: /^[\w[\](){}<>|.=-]*$/ };
}
