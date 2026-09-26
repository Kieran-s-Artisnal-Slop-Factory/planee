// Ported from notey src/lib/notebook/mathText.test.ts.
import { describe, expect, it } from 'vitest';
import {
  MATRIX_MAX,
  looksLikeMath,
  mathAt,
  mathMarkdown,
  matrixLatex,
  unescapeDollars,
} from './text';

/** The offset just after `needle` starts, for readable cursor positions. */
const inside = (text: string, needle: string) => text.indexOf(needle) + 1;

describe('finding the formula the cursor is in', () => {
  it('finds inline maths and hands back its source', () => {
    const text = 'The area is $\\pi r^2$ exactly.';
    const found = mathAt(text, inside(text, '\\pi'));
    expect(found).toEqual({ from: 12, to: 21, latex: '\\pi r^2', display: false });
    expect(text.slice(found!.from, found!.to)).toBe('$\\pi r^2$');
  });

  it('leaves prices alone', () => {
    // A closing delimiter followed by a digit is money. Getting this wrong
    // turns "$12 and $15" into a formula the moment anyone opens the editor.
    const text = 'It cost $12 and then $15.';
    expect(mathAt(text, inside(text, '12'))).toBeNull();
    expect(mathAt(text, text.length - 1)).toBeNull();
  });

  it('will not pair a `$` across a line', () => {
    const text = 'costs $5 each\nor $9 for two';
    expect(mathAt(text, inside(text, '5'))).toBeNull();
  });

  it('reads `$$…$$` on one line as display maths', () => {
    const text = 'before $$x = y$$ after';
    expect(mathAt(text, inside(text, 'x ='))).toEqual({
      from: 7,
      to: 16,
      latex: 'x = y',
      display: true,
    });
  });

  it('reads a `$$` block over several lines', () => {
    const text = 'intro\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nafter';
    const found = mathAt(text, inside(text, '\\int'));
    expect(found?.display).toBe(true);
    expect(found?.latex).toBe('\\int_0^1 x\\,dx');
    expect(text.slice(found!.from, found!.to)).toBe('$$\n\\int_0^1 x\\,dx\n$$');
  });

  it('reads a ```math fence, which renders the same way', () => {
    const text = '```math\na + b\n```\n';
    const found = mathAt(text, inside(text, 'a + b'));
    expect(found).toEqual({ from: 0, to: 17, latex: 'a + b', display: true });
  });

  it('claims the whole block from anywhere inside it, delimiters included', () => {
    const text = '$$\nx\n$$';
    for (const pos of [0, 2, 3, 5, 7]) expect(mathAt(text, pos)?.latex).toBe('x');
  });

  it('is null where there is no maths', () => {
    expect(mathAt('plain prose', 4)).toBeNull();
    expect(mathAt('', 0)).toBeNull();
    // An unclosed block is not a block yet.
    expect(mathAt('$$\nx = 1\n', 4)).toBeNull();
  });

  it('picks the formula the cursor is in when a line has several', () => {
    const text = 'both $a$ and $b$ here';
    expect(mathAt(text, inside(text, 'a$'))).toMatchObject({ latex: 'a' });
    expect(mathAt(text, inside(text, 'b$'))).toMatchObject({ latex: 'b' });
  });
});

describe('telling maths from money', () => {
  // micromark hands the canvas a formula for `$12 and $15` — it strips a
  // space from each side the way a code span does. This is the rule that
  // hands it back, and it is markdown.ts's rule so that the canvas and the
  // preview of one note agree.
  it('accepts an ordinary formula', () => {
    expect(looksLikeMath('$x^2$')).toBe(true);
    expect(looksLikeMath('$$a+b$$')).toBe(true);
  });

  it('refuses a space just inside a delimiter', () => {
    expect(looksLikeMath('$12 and $')).toBe(false);
    expect(looksLikeMath('$ x$')).toBe(false);
    expect(looksLikeMath('$x $')).toBe(false);
  });

  it('refuses a closing `$` that a digit follows', () => {
    // "$12$15" — two prices, not a formula reading "12".
    expect(looksLikeMath('$12$', '1')).toBe(false);
    expect(looksLikeMath('$12$', ' ')).toBe(true);
  });

  it('refuses an empty pair and anything unbalanced', () => {
    expect(looksLikeMath('$$')).toBe(false);
    expect(looksLikeMath('$x')).toBe(false);
    expect(looksLikeMath('x')).toBe(false);
  });

  it('holds the display pair to the same rule', () => {
    expect(looksLikeMath('$$ x $$')).toBe(false);
    // A digit after the pair is not a second price: $$ is never money.
    expect(looksLikeMath('$$x$$', '1')).toBe(true);
  });
});

describe('the dollars remark-stringify escapes', () => {
  // With maths on, the serializer escapes every `$` in prose, so a note that
  // has been through the canvas once is not the note that went in.
  it('puts a price back the way it was written', () => {
    expect(unescapeDollars(String.raw`costs \$7 today`)).toBe('costs $7 today');
    expect(unescapeDollars(String.raw`\$12 and \$15`)).toBe('$12 and $15');
  });

  it('leaves real maths alone, since it was never escaped', () => {
    expect(unescapeDollars('$x^2$ and $$y$$')).toBe('$x^2$ and $$y$$');
  });

  it('does not touch a shell variable in code', () => {
    // Nothing escapes inside code, so a backslash in there is the author's.
    expect(unescapeDollars('`echo \\$PATH`')).toBe('`echo \\$PATH`');
    const fence = '```sh\necho \\$HOME\n```';
    expect(unescapeDollars(fence)).toBe(fence);
  });

  it('still repairs the prose around a code span', () => {
    expect(unescapeDollars('\\$5 for `\\$X` and \\$6')).toBe('$5 for `\\$X` and $6');
  });
});

describe('an empty matrix of a chosen size', () => {
  it('puts the caret in the first cell and a placeholder in every other', () => {
    expect(matrixLatex(2, 2)).toBe(String.raw`\begin{pmatrix}#0 & #? \\ #? & #?\end{pmatrix}`);
  });

  it('has the rows and columns asked for', () => {
    const latex = matrixLatex(3, 4);
    const body = latex.replace(/^\\begin\{pmatrix\}|\\end\{pmatrix\}$/g, '');
    const rows = body.split(' \\\\ ');
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.split(' & ')).toHaveLength(4);
  });

  it('makes a single row or column without a stray separator', () => {
    expect(matrixLatex(1, 3)).toBe(String.raw`\begin{pmatrix}#0 & #? & #?\end{pmatrix}`);
    expect(matrixLatex(2, 1)).toBe(String.raw`\begin{pmatrix}#0 \\ #?\end{pmatrix}`);
  });

  it('clamps a size it cannot use rather than producing nonsense', () => {
    expect(matrixLatex(0, 0)).toBe(matrixLatex(1, 1));
    expect(matrixLatex(99, 2)).toBe(matrixLatex(MATRIX_MAX, 2));
    expect(matrixLatex(Number.NaN, 2.6)).toBe(matrixLatex(1, 3));
  });
});

describe('writing a formula back', () => {
  it('keeps an inline formula in the sentence', () => {
    expect(mathMarkdown('x^2', false)).toBe('$x^2$');
  });

  it('gives a display formula its own lines', () => {
    expect(mathMarkdown('x^2', true)).toBe('$$\nx^2\n$$');
  });

  it('trims what the editor hands over', () => {
    expect(mathMarkdown('  x^2  ', false)).toBe('$x^2$');
  });

  it('will not write a multi-line formula inline, because that cannot parse', () => {
    expect(mathMarkdown('a\nb', false)).toBe('$$\na\nb\n$$');
  });
});
