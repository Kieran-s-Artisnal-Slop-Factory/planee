// Ported from retoken (af25bc6) src/lib/markdown/footnotes.test.ts — unchanged.
import { describe, expect, it } from 'vitest';
import {
  appendDefinition,
  findDefinitions,
  findReferences,
  footnoteAt,
  footnoteLinks,
  footnoteMarkers,
  insertFootnote,
  maskCode,
  nextLabel,
  removeFootnote,
  renameFootnote,
  report,
  restoreDefinitions,
  setFootnoteText,
  slugifyLabel,
  startsDefinition,
  unescapeFootnotes,
} from './footnotes';

const labels = <T extends { label: string }>(items: T[]) => items.map((i) => i.label);

describe('maskCode', () => {
  it('keeps the string the same length, so offsets survive', () => {
    const md = 'a `code` b\n\n```\nfenced\n```\n';
    expect(maskCode(md)).toHaveLength(md.length);
  });

  it('blanks inline code but leaves prose alone', () => {
    expect(maskCode('see `x[^a]y` here')).toBe('see          here');
  });

  it('blanks fenced blocks', () => {
    const masked = maskCode('```\n[^a]: no\n```\ntext');
    expect(masked).toContain('text');
    expect(masked).not.toContain('[^a]');
  });

  it('handles backtick runs of different lengths', () => {
    // The whole ``…`` span masks, including the single backticks inside it.
    expect(maskCode('``a `b` c`` d')).toBe('            d');
  });
});

describe('findDefinitions', () => {
  it('finds a simple definition', () => {
    const defs = findDefinitions('Text.[^a]\n\n[^a]: The note.\n');
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ label: 'a', text: 'The note.' });
  });

  it('reports offsets that point at the definition', () => {
    const md = 'Text.[^a]\n\n[^a]: The note.\n';
    const def = findDefinitions(md)[0]!;
    expect(md.slice(def.from, def.to)).toBe('[^a]: The note.');
  });

  it('joins indented continuation lines', () => {
    const defs = findDefinitions('[^a]: First line.\n    Second line.\n');
    expect(defs[0]!.text).toBe('First line. Second line.');
  });

  it('absorbs a blank line only when indented text resumes', () => {
    const one = findDefinitions('[^a]: One.\n\n    Still one.\n');
    expect(one[0]!.text).toBe('One. Still one.');
    const two = findDefinitions('[^a]: One.\n\nA new paragraph.\n');
    expect(two[0]!.text).toBe('One.');
  });

  it('finds several, in document order', () => {
    expect(labels(findDefinitions('[^b]: B\n[^a]: A\n'))).toEqual(['b', 'a']);
  });

  it('ignores definitions inside code', () => {
    expect(findDefinitions('```\n[^a]: not real\n```\n')).toEqual([]);
  });

  it('accepts labels with punctuation', () => {
    expect(labels(findDefinitions('[^note-1]: x\n[^ref_2]: y\n'))).toEqual(['note-1', 'ref_2']);
  });

  it('handles an empty definition', () => {
    expect(findDefinitions('[^a]:\n')[0]).toMatchObject({ label: 'a', text: '' });
  });
});

describe('findDefinitions text', () => {
  it('reads the note out of the original, code spans and all', () => {
    const md = 'T[^a]\n\n[^a]: Write `text[^label]` for the reference.\n';
    expect(findDefinitions(md)[0]!.text).toBe('Write `text[^label]` for the reference.');
  });

  it('keeps code on a continuation line too', () => {
    const md = 'T[^a]\n\n[^a]: One `x`\n    and `y`.\n';
    expect(findDefinitions(md)[0]!.text).toBe('One `x` and `y`.');
  });
});

describe('findReferences', () => {
  it('finds references but not definitions', () => {
    expect(labels(findReferences('Text[^a] more[^b].\n\n[^a]: A\n[^b]: B\n'))).toEqual(['a', 'b']);
  });

  it('reports offsets that point at the reference', () => {
    const md = 'Text[^a] more.';
    const ref = findReferences(md)[0]!;
    expect(md.slice(ref.from, ref.to)).toBe('[^a]');
  });

  it('ignores references inside code', () => {
    // A fence only opens a block when it starts its own line.
    expect(findReferences('`[^a]` inline\n\n```\n[^b]\n```\n')).toEqual([]);
  });

  it('counts a repeated reference each time', () => {
    expect(labels(findReferences('one[^a] two[^a]'))).toEqual(['a', 'a']);
  });

  it('treats a mid-line [^a]: as a reference, not a definition', () => {
    // Only a line-leading definition is a definition.
    expect(labels(findReferences('see[^a]: really'))).toEqual(['a']);
  });
});

describe('report', () => {
  it('flags references with no definition', () => {
    expect(report('Text[^missing].').orphans).toEqual(['missing']);
  });

  it('flags definitions nothing references', () => {
    expect(report('Text.\n\n[^spare]: unused\n').unused).toEqual(['spare']);
  });

  it('flags duplicate definitions', () => {
    expect(report('x[^a]\n\n[^a]: one\n[^a]: two\n').duplicates).toEqual(['a']);
  });

  it('is clean for a well-formed document', () => {
    const r = report('Text[^a].\n\n[^a]: The note.\n');
    expect(r.orphans).toEqual([]);
    expect(r.unused).toEqual([]);
    expect(r.duplicates).toEqual([]);
    expect(r.definitions).toHaveLength(1);
    expect(r.references).toHaveLength(1);
  });
});

describe('slugifyLabel', () => {
  it('makes a usable label out of prose', () => {
    expect(slugifyLabel('Note G, Sketch of the Engine')).toBe('note-g-sketch-of-the-engine');
    expect(slugifyLabel('  Hello!  ')).toBe('hello');
  });

  it('falls back rather than returning nothing', () => {
    expect(slugifyLabel('!!!')).toBe('note');
    expect(slugifyLabel('')).toBe('note');
  });

  it('keeps letters outside ASCII', () => {
    expect(slugifyLabel('Café Über')).toBe('café-über');
  });
});

describe('nextLabel', () => {
  it('numbers from one in an empty document', () => {
    expect(nextLabel('')).toBe('1');
  });

  it('skips numbers already used, as definition or reference', () => {
    expect(nextLabel('[^1]: a\n[^2]: b\n')).toBe('3');
    expect(nextLabel('text[^1] more')).toBe('2');
  });

  it('ignores non-numeric labels when numbering', () => {
    expect(nextLabel('[^ada]: a\n')).toBe('1');
  });

  it('suffixes a named label only on collision', () => {
    expect(nextLabel('', 'Ada')).toBe('ada');
    expect(nextLabel('[^ada]: x\n', 'Ada')).toBe('ada-2');
    expect(nextLabel('[^ada]: x\n[^ada-2]: y\n', 'Ada')).toBe('ada-3');
  });
});

describe('insertFootnote', () => {
  it('inserts a reference at the cursor and a definition at the end', () => {
    const result = insertFootnote('Ada wrote it.', 13);
    expect(result.text).toBe('Ada wrote it.[^1]\n\n[^1]: \n');
    expect(result.label).toBe('1');
  });

  it('puts the caret in the definition, ready to type', () => {
    const result = insertFootnote('Ada wrote it.', 13);
    expect(result.text.slice(0, result.cursor)).toBe('Ada wrote it.[^1]\n\n[^1]: ');
  });

  it('inserts mid-text without disturbing the rest', () => {
    const result = insertFootnote('Ada wrote it. Grace built it.', 13);
    expect(result.text.startsWith('Ada wrote it.[^1] Grace built it.')).toBe(true);
  });

  it('joins an existing block of definitions', () => {
    const md = 'One[^a] two.\n\n[^a]: First note.\n';
    const result = insertFootnote(md, 11);
    // The document's trailing newline is kept, not swallowed.
    expect(result.text).toBe('One[^a] two[^1].\n\n[^a]: First note.\n[^1]: \n');
  });

  it('accounts for the reference shifting the definitions down', () => {
    const md = 'One[^a] two.\n\n[^a]: First note.\n';
    const result = insertFootnote(md, 11);
    // The existing definition must survive intact, not be cut into.
    expect(result.text).toContain('[^a]: First note.');
    expect(result.text.slice(0, result.cursor).endsWith('[^1]: ')).toBe(true);
  });

  it('takes an explicit label and note', () => {
    const result = insertFootnote('Text.', 5, { label: 'ada', note: 'Note G, 1843.' });
    expect(result.text).toBe('Text.[^ada]\n\n[^ada]: Note G, 1843.\n');
    expect(result.label).toBe('ada');
  });

  it('handles an empty document', () => {
    const result = insertFootnote('', 0);
    expect(result.text).toBe('[^1]\n\n[^1]: \n');
  });

  it('clamps a position past the end', () => {
    expect(insertFootnote('Hi', 999).text.startsWith('Hi[^1]')).toBe(true);
  });

  it('produces a document that parses back to a matched pair', () => {
    const result = insertFootnote('Ada wrote it.', 13);
    const r = report(result.text);
    expect(r.orphans).toEqual([]);
    expect(r.unused).toEqual([]);
    expect(labels(r.definitions)).toEqual(['1']);
  });
});

describe('footnoteAt', () => {
  const md = 'One[^a] two.\n\n[^a]: The note.\n[^b]: Spare.\n';

  it('finds the reference the caret is in', () => {
    expect(footnoteAt(md, md.indexOf('[^a]') + 2)).toBe('a');
  });

  it('counts a caret resting against either edge of a reference', () => {
    const start = md.indexOf('[^a]');
    expect(footnoteAt(md, start)).toBe('a');
    expect(footnoteAt(md, start + 4)).toBe('a');
  });

  it('finds the note the caret is in, continuation lines included', () => {
    const long = 'T[^a]\n\n[^a]: One.\n    Two.\n';
    expect(footnoteAt(long, long.indexOf('Two.'))).toBe('a');
  });

  it('tells one note from the next', () => {
    expect(footnoteAt(md, md.indexOf('Spare.'))).toBe('b');
  });

  it('is null in ordinary prose', () => {
    expect(footnoteAt(md, 1)).toBeNull();
    expect(footnoteAt('Just prose.', 4)).toBeNull();
  });

  it('is null inside code, where a footnote is a code sample', () => {
    const code = 'Text `[^a]` more\n';
    expect(footnoteAt(code, code.indexOf('[^a]') + 2)).toBeNull();
  });
});

describe('startsDefinition', () => {
  it('recognises a definition line', () => {
    expect(startsDefinition('[^a]: The note.')).toBe(true);
    expect(startsDefinition('   [^a]: indented up to three')).toBe(true);
  });

  it('is not fooled by a reference or by prose', () => {
    expect(startsDefinition('Text[^a] more')).toBe(false);
    expect(startsDefinition('[^a] at the start, but no colon')).toBe(false);
    expect(startsDefinition('     [^a]: four spaces is a code block')).toBe(false);
    expect(startsDefinition('')).toBe(false);
  });
});

describe('appendDefinition', () => {
  it('starts a block when the document has no notes', () => {
    expect(appendDefinition('Text.', 'a', 'The note.')).toBe('Text.\n\n[^a]: The note.\n');
  });

  it('joins the block when there is one', () => {
    expect(appendDefinition('T\n\n[^a]: A\n', 'b', 'B')).toBe('T\n\n[^a]: A\n[^b]: B\n');
  });

  it('leaves a stub with no trailing space', () => {
    expect(appendDefinition('Text.', 'a')).toBe('Text.\n\n[^a]:\n');
  });

  it('is found by the reader that has to see it', () => {
    expect(labels(findDefinitions(appendDefinition('T[^a]\n\n[^a]: A\n', 'b', 'B')))).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('renameFootnote', () => {
  const md = 'One[^a] and two[^a].\n\n[^a]: The note.\n';

  it('renames the definition and every reference together', () => {
    const out = renameFootnote(md, 'a', 'ada');
    expect(out).toBe('One[^ada] and two[^ada].\n\n[^ada]: The note.\n');
    expect(report(out).orphans).toEqual([]);
  });

  it('keeps the note text', () => {
    expect(findDefinitions(renameFootnote(md, 'a', 'ada'))[0]!.text).toBe('The note.');
  });

  it('leaves other labels alone', () => {
    const two = 'X[^a][^b]\n\n[^a]: A\n[^b]: B\n';
    expect(renameFootnote(two, 'a', 'z')).toBe('X[^z][^b]\n\n[^z]: A\n[^b]: B\n');
  });

  it('refuses a label that could not be written', () => {
    expect(renameFootnote(md, 'a', '')).toBe(md);
    expect(renameFootnote(md, 'a', 'two words')).toBe(md);
    expect(renameFootnote(md, 'a', 'a')).toBe(md);
  });

  it('ignores a label inside code', () => {
    const withCode = 'Text[^a]\n\n`[^a]`\n\n[^a]: A\n';
    expect(renameFootnote(withCode, 'a', 'z')).toContain('`[^a]`');
  });
});

describe('setFootnoteText', () => {
  it('rewrites the note in place', () => {
    expect(setFootnoteText('T[^a]\n\n[^a]: Old.\n', 'a', 'New.')).toBe('T[^a]\n\n[^a]: New.\n');
  });

  it('replaces continuation lines rather than stacking on them', () => {
    const md = 'T[^a]\n\n[^a]: One.\n    Two.\n';
    expect(setFootnoteText(md, 'a', 'Just one now.')).toBe('T[^a]\n\n[^a]: Just one now.\n');
  });

  it('flattens a multi-line note, since a stray line would leave the note', () => {
    expect(setFootnoteText('[^a]: x\n', 'a', 'One.\nTwo.')).toBe('[^a]: One. Two.\n');
    expect(findDefinitions(setFootnoteText('[^a]: x\n', 'a', 'One.\nTwo.'))[0]!.text).toBe(
      'One. Two.'
    );
  });

  it('empties to a bare stub', () => {
    expect(setFootnoteText('[^a]: x\n', 'a', '   ')).toBe('[^a]:\n');
  });

  it('does nothing for a label that is not defined', () => {
    expect(setFootnoteText('[^a]: x\n', 'b', 'y')).toBe('[^a]: x\n');
  });
});

describe('removeFootnote', () => {
  it('takes the references with it, so nothing is left dangling', () => {
    const out = removeFootnote('One[^a] two[^a].\n\n[^a]: The note.\n', 'a');
    expect(out).toBe('One two.\n');
    expect(report(out).orphans).toEqual([]);
  });

  it('keeps the rest of the block', () => {
    expect(removeFootnote('X[^a][^b]\n\n[^a]: A\n[^b]: B\n', 'a')).toBe('X[^b]\n\n[^b]: B\n');
  });

  it('can leave the references for a label about to be redefined', () => {
    const out = removeFootnote('X[^a]\n\n[^a]: A\n', 'a', { keepReferences: true });
    expect(out).toBe('X[^a]\n');
    expect(report(out).orphans).toEqual(['a']);
  });

  it('removes a multi-line note whole', () => {
    expect(removeFootnote('X[^a]\n\n[^a]: One.\n    Two.\n', 'a')).toBe('X\n');
  });

  it('does nothing for a label that is not defined', () => {
    expect(removeFootnote('X[^a]\n\n[^a]: A\n', 'b')).toBe('X[^a]\n\n[^a]: A\n');
  });
});

describe('footnoteLinks', () => {
  const md = 'One[^a] two.\n\nMore text.\n\n[^a]: The note.\n';

  it('marks the reference line and the definition line', () => {
    expect(footnoteLinks(md).map((l) => [l.line, l.role, l.label])).toEqual([
      [0, 'ref', 'a'],
      [4, 'def', 'a'],
    ]);
  });

  it('points a reference at its definition', () => {
    const ref = footnoteLinks(md).find((l) => l.role === 'ref')!;
    expect(md.slice(ref.target!, ref.target! + 5)).toBe('[^a]:');
  });

  it('points a definition back at its first reference', () => {
    const def = footnoteLinks(md).find((l) => l.role === 'def')!;
    expect(md.slice(def.target!, def.target! + 4)).toBe('[^a]');
    expect(def.target).toBe(3);
  });

  it('leaves an orphan with nowhere to jump, but still marks it', () => {
    const orphan = footnoteLinks('Text[^missing].')[0]!;
    expect(orphan).toMatchObject({ line: 0, role: 'ref', label: 'missing', target: null });
  });

  it('marks an unreferenced definition too', () => {
    const unused = footnoteLinks('[^spare]: nothing cites this\n')[0]!;
    expect(unused).toMatchObject({ role: 'def', label: 'spare', target: null });
  });

  it('gives every reference on a line its own link, in document order', () => {
    const links = footnoteLinks('A[^a] and B[^b]\n\n[^a]: x\n[^b]: y\n');
    expect(links.filter((l) => l.line === 0).map((l) => l.label)).toEqual(['a', 'b']);
  });

  it('reports the occurrence offset, not only the target', () => {
    const md3 = 'A[^a]\n\n[^a]: x\n';
    const ref = footnoteLinks(md3).find((l) => l.role === 'ref')!;
    expect(md3.slice(ref.from, ref.from + 4)).toBe('[^a]');
  });

  it('resolves to the first definition when a label is defined twice', () => {
    const md2 = 'X[^a]\n\n[^a]: first\n[^a]: second\n';
    const ref = footnoteLinks(md2).find((l) => l.role === 'ref')!;
    expect(md2.slice(ref.target!)).toMatch(/^\[\^a\]: first/);
  });

  it('counts lines correctly further down a document', () => {
    const long = 'line0\nline1\nline2\nText[^a]\n\n[^a]: note\n';
    expect(footnoteLinks(long).map((l) => l.line)).toEqual([3, 5]);
  });

  it('ignores footnotes inside code', () => {
    expect(footnoteLinks('```\n[^a]: no\n```\n')).toEqual([]);
  });

  it('is empty for a document with no footnotes', () => {
    expect(footnoteLinks('Just prose.')).toEqual([]);
  });
});

describe('footnoteMarkers', () => {
  it('puts both footnotes of a line on that line’s marker', () => {
    const markers = footnoteMarkers('A[^a] and B[^b]\n\n[^a]: x\n[^b]: y\n');
    const first = markers.find((m) => m.line === 0)!;
    expect(first.links.map((l) => l.label)).toEqual(['a', 'b']);
    expect(first.links.every((l) => l.target !== null)).toBe(true);
  });

  it('groups a definition that cites another note with its own marker', () => {
    // `[^a]: … [^b]` is a definition line that is also a reference line.
    const markers = footnoteMarkers('T[^a][^b]\n\n[^a]: see [^b]\n[^b]: y\n');
    const line2 = markers.find((m) => m.line === 2)!;
    expect(line2.links.map((l) => [l.role, l.label])).toEqual([
      ['def', 'a'],
      ['ref', 'b'],
    ]);
  });

  it('gives one entry per line, in document order', () => {
    expect(footnoteMarkers('A[^a] B[^b]\n\n[^a]: x\n[^b]: y\n').map((m) => m.line)).toEqual([
      0, 2, 3,
    ]);
  });

  it('leaves an orphan on its own marker', () => {
    const markers = footnoteMarkers('Text[^missing].');
    expect(markers).toHaveLength(1);
    expect(markers[0]!.links).toHaveLength(1);
    expect(markers[0]!.links[0]!.target).toBeNull();
  });

  it('is empty for a document with no footnotes', () => {
    expect(footnoteMarkers('Just prose.')).toEqual([]);
  });
});

describe('restoreDefinitions', () => {
  it('puts back a definition the round-trip dropped', () => {
    const before = 'Text[^a].\n\n[^a]: The note.\n';
    const after = 'Text[^a].\n'; // what Milkdown hands back
    expect(restoreDefinitions(before, after)).toBe('Text[^a].\n\n[^a]: The note.\n');
  });

  it('restores continuation lines verbatim', () => {
    const before = 'T[^a]\n\n[^a]: One.\n    Two.\n';
    expect(restoreDefinitions(before, 'T[^a]\n')).toBe('T[^a]\n\n[^a]: One.\n    Two.\n');
  });

  it('restores several, in their original order', () => {
    const before = 'T[^a][^b]\n\n[^a]: A\n[^b]: B\n';
    expect(restoreDefinitions(before, 'T[^a][^b]\n')).toBe('T[^a][^b]\n\n[^a]: A\n[^b]: B\n');
  });

  it('leaves a document that kept its definitions alone', () => {
    const md = 'Text[^a].\n\n[^a]: The note.\n';
    expect(restoreDefinitions(md, md)).toBe(md);
  });

  it('only restores the ones actually missing', () => {
    const before = 'T[^a][^b]\n\n[^a]: A\n[^b]: B\n';
    const after = 'T[^a][^b]\n\n[^a]: A\n';
    expect(restoreDefinitions(before, after)).toBe('T[^a][^b]\n\n[^a]: A\n\n[^b]: B\n');
  });

  it('does nothing when there was nothing to lose', () => {
    expect(restoreDefinitions('Plain text.', 'Plain text.')).toBe('Plain text.');
  });

  it('handles the document being emptied', () => {
    expect(restoreDefinitions('T[^a]\n\n[^a]: A\n', '')).toBe('[^a]: A\n');
  });

  it('is idempotent — repairing twice changes nothing more', () => {
    const before = 'Text[^a].\n\n[^a]: The note.\n';
    const once = restoreDefinitions(before, 'Text[^a].\n');
    expect(restoreDefinitions(once, once)).toBe(once);
  });

  it('leaves no orphans behind', () => {
    const before = 'Text[^a].\n\n[^a]: The note.\n';
    expect(report(restoreDefinitions(before, 'Text[^a].\n')).orphans).toEqual([]);
  });
});

describe('unescapeFootnotes', () => {
  it('undoes the serializer escaping a footnote reference', () => {
    expect(unescapeFootnotes(String.raw`Text\[^a] more`)).toBe('Text[^a] more');
  });

  it('undoes it on a definition too', () => {
    expect(unescapeFootnotes(String.raw`\[^a]: The note.`)).toBe('[^a]: The note.');
  });

  it('leaves other escaped brackets alone', () => {
    expect(unescapeFootnotes(String.raw`\[not a footnote]`)).toBe(String.raw`\[not a footnote]`);
    expect(unescapeFootnotes(String.raw`\[\[wiki]]`)).toBe(String.raw`\[\[wiki]]`);
  });

  it('is a no-op on already-clean markdown', () => {
    expect(unescapeFootnotes('Text[^a]\n\n[^a]: note')).toBe('Text[^a]\n\n[^a]: note');
  });
});
