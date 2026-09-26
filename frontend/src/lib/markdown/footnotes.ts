// Ported from retoken (af25bc6) src/lib/markdown/footnotes.ts — unchanged.
/**
 * GFM footnotes, as a model the editor can act on.
 *
 *   Ada wrote the first algorithm.[^ada]
 *
 *   [^ada]: Note G, Sketch of the Analytical Engine, 1843.
 *
 * remark-gfm already *renders* these, so nothing here is about output — it's
 * about authoring them: finding what's defined so references can autocomplete,
 * finding what's referenced so a missing definition can be reported, and
 * inserting a matched pair without the author having to scroll to the bottom
 * of the document.
 *
 * Everything is pure and offset-preserving (footnotes.test.ts), so the editor
 * can map a result straight back to a document position.
 */

export interface FootnoteDefinition {
  label: string;
  /** The note text, with continuation lines joined by spaces. */
  text: string;
  /** Offsets of the whole definition, continuation lines included. */
  from: number;
  to: number;
}

export interface FootnoteReference {
  label: string;
  from: number;
  to: number;
}

export interface FootnoteReport {
  definitions: FootnoteDefinition[];
  references: FootnoteReference[];
  /** Referenced but never defined — these render as literal text. */
  orphans: string[];
  /** Defined but never referenced — these never render at all. */
  unused: string[];
  /** Labels defined more than once; only the first definition wins. */
  duplicates: string[];
}

/**
 * Blank out code — fenced blocks and inline spans — replacing it with spaces
 * so every offset still lines up with the original string.
 * `[^not-a-footnote]` inside a code sample is a code sample.
 *
 * Four-space *indented* code blocks are deliberately NOT masked. Telling one
 * apart from a footnote's continuation line needs the block context that only
 * a real parser has, and guessing wrong the other way is worse: it would swallow
 * the second line of every multi-line note.
 */
export function maskCode(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let fence: string | null = null;

  for (const line of lines) {
    const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null && opening) {
      fence = opening[1]!.charAt(0).repeat(3);
      out.push(line); // keep the fence line itself; it holds no references
      continue;
    }
    if (fence !== null) {
      const closing = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      out.push(' '.repeat(line.length));
      if (closing && closing[1]!.startsWith(fence)) fence = null;
      continue;
    }
    // Inline code spans, backtick runs of any length.
    out.push(line.replace(/(`+)(?:[^`]|(?!\1)`)*\1/g, (span) => ' '.repeat(span.length)));
  }
  return out.join('\n');
}

/** A label is everything up to the closing bracket, minus whitespace. */
const LABEL = String.raw`[^\]\s]+`;

/**
 * Whether a run of text opens a definition — `[^label]: …`.
 *
 * For a caller holding a block of text rather than a document: the WYSIWYG
 * editor asks it of a paragraph, to recognise a note someone typed by hand
 * where a note isn't shown.
 */
export function startsDefinition(text: string): boolean {
  return new RegExp(String.raw`^ {0,3}\[\^${LABEL}\]:`).test(text);
}

/**
 * Every `[^label]: …` definition, with its continuation lines. A definition
 * runs until the next blank line that isn't followed by indented text, or the
 * next definition.
 */
export function findDefinitions(markdown: string): FootnoteDefinition[] {
  const masked = maskCode(markdown);
  const found: FootnoteDefinition[] = [];
  const pattern = new RegExp(String.raw`^ {0,3}\[\^(${LABEL})\]:[ \t]?(.*)$`, 'gm');

  for (const match of masked.matchAll(pattern)) {
    const from = match.index!;
    let to = from + match[0].length;
    // The note is read back out of the ORIGINAL string at the offsets the
    // masked one found: masking is offset-preserving, so a note that contains
    // `code` keeps its code instead of the spaces standing in for it.
    const parts = [markdown.slice(to - match[2]!.length, to).trim()];

    // Continuation: indented lines, and blank lines that are followed by one.
    let cursor = to;
    while (cursor < masked.length) {
      const lineEnd = masked.indexOf('\n', cursor + 1);
      const stop = lineEnd === -1 ? masked.length : lineEnd;
      const line = masked.slice(cursor + 1, stop);
      const indented = /^(?: {4,}|\t)\S/.test(line);
      const blank = line.trim() === '';
      if (!indented && !blank) break;
      if (blank) {
        // Only absorb a blank line if indented text resumes after it.
        const nextEnd = masked.indexOf('\n', stop + 1);
        const next = masked.slice(stop + 1, nextEnd === -1 ? masked.length : nextEnd);
        if (!/^(?: {4,}|\t)\S/.test(next)) break;
      } else {
        parts.push(markdown.slice(cursor + 1, stop).trim());
      }
      cursor = stop;
      to = stop;
    }

    found.push({
      label: match[1]!,
      text: parts.filter(Boolean).join(' '),
      from,
      to,
    });
  }
  return found;
}

/** Every `[^label]` reference — definitions and code excluded. */
export function findReferences(markdown: string): FootnoteReference[] {
  const masked = maskCode(markdown);
  const found: FootnoteReference[] = [];
  const pattern = new RegExp(String.raw`\[\^(${LABEL})\]`, 'g');

  for (const match of masked.matchAll(pattern)) {
    const from = match.index!;
    // `[^x]:` at the start of a line is a definition, not a reference.
    if (masked[from + match[0].length] === ':') {
      const lineStart = masked.lastIndexOf('\n', from - 1) + 1;
      if (/^ {0,3}$/.test(masked.slice(lineStart, from))) continue;
    }
    found.push({ label: match[1]!, from, to: from + match[0].length });
  }
  return found;
}

/**
 * The label of the footnote at `pos`, or null.
 *
 * Both halves count: a caret in `[^ada]` mid-sentence and a caret in the
 * `[^ada]: …` note at the foot are both "on footnote ada", which is what lets
 * one key mean "show me the other half" from either end. Bounds are inclusive,
 * so a caret resting against either edge of a reference still counts — that is
 * where a caret lands when you click one.
 */
export function footnoteAt(markdown: string, pos: number): string | null {
  const reference = findReferences(markdown).find((r) => pos >= r.from && pos <= r.to);
  if (reference) return reference.label;
  return findDefinitions(markdown).find((d) => pos >= d.from && pos <= d.to)?.label ?? null;
}

/** Definitions, references, and everything that doesn't line up between them. */
export function report(markdown: string): FootnoteReport {
  const definitions = findDefinitions(markdown);
  const references = findReferences(markdown);
  const defined = new Set(definitions.map((d) => d.label));
  const referenced = new Set(references.map((r) => r.label));

  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const { label } of definitions) {
    if (seen.has(label) && !duplicates.includes(label)) duplicates.push(label);
    seen.add(label);
  }

  return {
    definitions,
    references,
    orphans: [...referenced].filter((label) => !defined.has(label)),
    unused: [...defined].filter((label) => !referenced.has(label)),
    duplicates,
  };
}

/** Turn arbitrary text into a usable label: `Note G, 1843` → `note-g-1843`. */
export function slugifyLabel(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'note';
}

/**
 * A label not already in use. Numeric by default (`1`, `2`, …) since that is
 * how footnotes are usually written; pass a base for a named one, which gets
 * `-2`, `-3` … only if it collides.
 */
export function nextLabel(markdown: string, base?: string): string {
  const taken = new Set([
    ...findDefinitions(markdown).map((d) => d.label),
    ...findReferences(markdown).map((r) => r.label),
  ]);

  if (!base) {
    let n = 1;
    while (taken.has(String(n))) n++;
    return String(n);
  }

  const slug = slugifyLabel(base);
  if (!taken.has(slug)) return slug;
  let n = 2;
  while (taken.has(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

export interface FootnoteInsertion {
  /** The whole document, rewritten. */
  text: string;
  /** Where to put the caret — inside the new definition, ready to type. */
  cursor: number;
  label: string;
}

/**
 * Put a definition line where definitions belong: joined onto the block of
 * existing ones when there is any (`anchor` is where that block ends), and
 * otherwise starting a new block at the foot of the document.
 *
 * Returns the rewritten text and where the definition itself ends, which is
 * where a caret wants to be.
 */
function placeDefinition(
  markdown: string,
  definition: string,
  anchor: number
): { text: string; cursor: number } {
  if (anchor >= 0) {
    // Straight after the last definition — one newline, same block.
    return {
      text: markdown.slice(0, anchor) + '\n' + definition + markdown.slice(anchor),
      cursor: anchor + 1 + definition.length,
    };
  }
  const trimmed = markdown.replace(/\s+$/, '');
  const separator = trimmed ? '\n\n' : '';
  return {
    text: trimmed + separator + definition + '\n',
    cursor: trimmed.length + separator.length + definition.length,
  };
}

/**
 * Insert a reference at `pos` and a matching definition stub.
 *
 * The definition joins the existing block of definitions when there is one
 * (they conventionally sit together at the foot of the document) and
 * otherwise starts a new block at the end. The caret lands in the definition,
 * because the note is the part you actually have to write.
 */
export function insertFootnote(
  markdown: string,
  pos: number,
  options: { label?: string; note?: string } = {}
): FootnoteInsertion {
  const label = options.label ?? nextLabel(markdown);
  const reference = `[^${label}]`;
  const note = options.note ?? '';

  const clamped = Math.max(0, Math.min(pos, markdown.length));
  const withRef = markdown.slice(0, clamped) + reference + markdown.slice(clamped);

  // Existing definitions move down by the reference we just inserted.
  const last = findDefinitions(markdown).at(-1);
  const anchor = last ? (last.to >= clamped ? last.to + reference.length : last.to) : -1;

  const { text, cursor } = placeDefinition(withRef, `[^${label}]: ${note}`, anchor);
  return { text, cursor, label };
}

/**
 * Add a definition without touching the body — for a note written somewhere
 * that isn't the document, which is how the footnote dialog adds one.
 */
export function appendDefinition(markdown: string, label: string, note = ''): string {
  const last = findDefinitions(markdown).at(-1);
  return placeDefinition(markdown, `[^${label}]: ${note}`.trimEnd(), last ? last.to : -1).text;
}

/** Splice a set of replacements in, back to front so offsets stay valid. */
function applyEdits(
  text: string,
  edits: Array<{ from: number; to: number; insert: string }>
): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, edit.from) + edit.insert + out.slice(edit.to);
  }
  return out;
}

/**
 * Rename a label everywhere at once — the definition and every reference to
 * it. Renaming one without the others is how you get an orphan, so the two
 * are deliberately not separable.
 */
export function renameFootnote(markdown: string, from: string, to: string): string {
  const label = to.trim();
  if (!label || label === from || /[\]\s]/.test(label)) return markdown;

  const edits = [
    // A definition's `from` points at the `[`, so replacing just the bracketed
    // part leaves `: the note` alone.
    ...findDefinitions(markdown)
      .filter((definition) => definition.label === from)
      .map((definition) => ({
        from: definition.from,
        to: definition.from + `[^${from}]`.length,
        insert: `[^${label}]`,
      })),
    ...findReferences(markdown)
      .filter((reference) => reference.label === from)
      .map((reference) => ({ from: reference.from, to: reference.to, insert: `[^${label}]` })),
  ];
  return applyEdits(markdown, edits);
}

/**
 * Rewrite a note's text where it stands, references untouched.
 *
 * The note becomes one line: a continuation line has to be indented to belong
 * to the definition, and silently re-indenting what someone typed is a worse
 * surprise than a long line.
 */
export function setFootnoteText(markdown: string, label: string, text: string): string {
  const note = text.replace(/\s+/g, ' ').trim();
  const edits = findDefinitions(markdown)
    .filter((definition) => definition.label === label)
    .map((definition) => ({
      from: definition.from,
      to: definition.to,
      insert: `[^${label}]: ${note}`.trimEnd(),
    }));
  return applyEdits(markdown, edits);
}

/**
 * Delete a note.
 *
 * Its references go too, because a reference with no definition doesn't
 * degrade — it renders as the literal text `[^label]` in the middle of a
 * sentence. `keepReferences` leaves them for a caller that means to define
 * the label again.
 */
export function removeFootnote(
  markdown: string,
  label: string,
  options: { keepReferences?: boolean } = {}
): string {
  const edits = findDefinitions(markdown)
    .filter((definition) => definition.label === label)
    .map((definition) => ({
      from: definition.from,
      // Swallow the newline that ended it, so the block doesn't grow a gap.
      to: markdown[definition.to] === '\n' ? definition.to + 1 : definition.to,
      insert: '',
    }));

  if (!options.keepReferences) {
    for (const reference of findReferences(markdown)) {
      if (reference.label === label) {
        edits.push({ from: reference.from, to: reference.to, insert: '' });
      }
    }
  }
  if (edits.length === 0) return markdown;
  // The blank line that separated the block from the prose outlives the last
  // note in it. Only the very end of the document is touched, and only when
  // something was actually removed.
  return applyEdits(markdown, edits).replace(/\n{2,}$/, '\n');
}

/** What one footnote occurrence says and where it jumps. */
export interface FootnoteLink {
  /** Zero-based offset of the line the occurrence sits on. */
  line: number;
  label: string;
  /** `ref` links jump to the definition; `def` links jump to a reference. */
  role: 'ref' | 'def';
  /** Document offset of the occurrence itself. */
  from: number;
  /** Document offset to jump to, or null when there is nowhere to go. */
  target: number | null;
}

/**
 * Every footnote occurrence, in document order, resolved to where it jumps.
 *
 * A reference points at its definition and a definition points back at its
 * first reference, which is the pair of moves you actually make while writing:
 * "what did I say in that note?" and "where did I cite this?". A link with
 * no counterpart carries `target: null` — that's the orphan case, and it is
 * still reported so you can see the problem in the margin.
 *
 * One line can carry several: two citations in a sentence, or a note that
 * cites another note. Each gets its own link — grouping them for a gutter is
 * `footnoteMarkers`' job.
 *
 * Lines are counted in the same string that produced the offsets, so a caller
 * can map either onto an editor position.
 */
export function footnoteLinks(markdown: string): FootnoteLink[] {
  const definitions = findDefinitions(markdown);
  const references = findReferences(markdown);

  const definitionAt = new Map<string, number>();
  for (const definition of definitions) {
    // First definition wins, matching how the renderer resolves duplicates.
    if (!definitionAt.has(definition.label)) definitionAt.set(definition.label, definition.from);
  }
  const referenceAt = new Map<string, number>();
  for (const reference of references) {
    if (!referenceAt.has(reference.label)) referenceAt.set(reference.label, reference.from);
  }

  /** Offsets are cheap to turn into line numbers with one pass of newlines. */
  const lineStarts = [0];
  for (let i = 0; i < markdown.length; i++) {
    if (markdown[i] === '\n') lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  const links: FootnoteLink[] = [
    ...references.map((reference) => ({
      line: lineOf(reference.from),
      label: reference.label,
      role: 'ref' as const,
      from: reference.from,
      target: definitionAt.get(reference.label) ?? null,
    })),
    ...definitions.map((definition) => ({
      line: lineOf(definition.from),
      label: definition.label,
      role: 'def' as const,
      from: definition.from,
      target: referenceAt.get(definition.label) ?? null,
    })),
  ];
  // Document order, so a line's own footnotes come out in the order they are
  // written — which is the order a gutter marker should step through them.
  return links.sort((a, b) => a.from - b.from);
}

/** Every footnote occurrence sitting on one line. */
export interface FootnoteLineMarker {
  /** Zero-based offset of the line. */
  line: number;
  /** In document order; never empty. */
  links: FootnoteLink[];
}

/**
 * Footnote links grouped by line — one entry per line that carries any, which
 * is what a gutter can actually draw.
 *
 * A gutter has room for one marker per line but a line can cite two notes, so
 * the marker stands for all of them: the count belongs on it, and clicking
 * steps through the targets rather than only ever offering the first.
 *
 * Lines come out in document order, as do the links within each.
 */
export function footnoteMarkers(markdown: string): FootnoteLineMarker[] {
  const byLine = new Map<number, FootnoteLink[]>();
  for (const link of footnoteLinks(markdown)) {
    const existing = byLine.get(link.line);
    if (existing) existing.push(link);
    else byLine.set(link.line, [link]);
  }
  return [...byLine].map(([line, links]) => ({ line, links }));
}

/**
 * Put back definitions a round-trip dropped.
 *
 * Milkdown parses GFM footnotes but has no schema node for them, so a
 * definition that goes into the WYSIWYG editor does not come out: type one
 * character and every `[^label]: …` in the document is silently gone, while
 * the `[^label]` references survive and become orphans. Nobody can delete a
 * definition in WYSIWYG on purpose — it isn't rendered there — so anything
 * missing was lost, and putting it back is always the right answer.
 *
 * Definitions are restored verbatim (continuation lines and all) from the
 * text they were taken from, appended as a block at the foot of the document.
 */
export function restoreDefinitions(before: string, after: string): string {
  const had = findDefinitions(before);
  if (had.length === 0) return after;

  const kept = new Set(findDefinitions(after).map((d) => d.label));
  const missing = had.filter((d) => !kept.has(d.label));
  if (missing.length === 0) return after;

  const block = missing.map((d) => before.slice(d.from, d.to)).join('\n');
  const trimmed = after.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

/**
 * Undo the escaping a markdown serializer applies to footnote syntax.
 *
 * Milkdown/Crepe round-trips through remark-stringify, which does not know
 * GFM footnotes: it treats `[^a]` as a literal bracket and emits `\[^a]`,
 * which then renders as visible punctuation instead of a footnote. This
 * reverses exactly that — a backslash immediately before `[^label]` — and
 * nothing else.
 */
export function unescapeFootnotes(markdown: string): string {
  return markdown.replace(new RegExp(String.raw`\\(\[\^${LABEL}\])`, 'g'), '$1');
}
