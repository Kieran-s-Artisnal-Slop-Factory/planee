// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { convertLatexToMarkup } from 'mathlive/ssr';
import { cleanClass, cleanStyle, safeMathFragment, sanitizeLatex } from './sanitize';

/** What the page would actually get: filtered LaTeX, typeset, then filtered markup. */
function render(latex: string): HTMLElement {
  const host = document.createElement('span');
  host.append(safeMathFragment(convertLatexToMarkup(sanitizeLatex(latex).latex)));
  return host;
}

/** Every attribute on every element under `host`, as `tag name=value`. */
function attributes(host: HTMLElement): string[] {
  return [...host.querySelectorAll('*')].flatMap((el) =>
    [...el.attributes].map((a) => `${el.localName} ${a.name}=${a.value}`)
  );
}

const styles = (host: HTMLElement) =>
  [...host.querySelectorAll('[style]')].map((el) => el.getAttribute('style') ?? '');

describe('sanitizeLatex', () => {
  it('removes the attribute commands and keeps what they wrapped', () => {
    expect(sanitizeLatex(String.raw`\style{position:fixed}{x}`)).toEqual({
      latex: '{x}',
      removed: [String.raw`\style`],
    });
    expect(sanitizeLatex(String.raw`a\htmlStyle{color:red}{b}c`).latex).toBe('a{b}c');
    expect(sanitizeLatex(String.raw`\cssId{app}{x}`).latex).toBe('{x}');
    expect(sanitizeLatex(String.raw`\htmlId{a}{x}`).latex).toBe('{x}');
    expect(sanitizeLatex(String.raw`\class{btn}{x}`).latex).toBe('{x}');
    expect(sanitizeLatex(String.raw`\htmlClass{modal}{x}`).latex).toBe('{x}');
    expect(sanitizeLatex(String.raw`\htmlData{a=b,href=https://x.test}{x}`).latex).toBe('{x}');
    expect(sanitizeLatex(String.raw`\href{javascript:alert(1)}{x}`).latex).toBe('{x}');
    expect(sanitizeLatex(String.raw`\href{https://x.test}{x}`).latex).toBe('{x}');
  });

  it('takes the attribute however it is written', () => {
    // A space before the argument, nested braces inside it, text mode.
    expect(sanitizeLatex(String.raw`\style {a{b}c}{x}`).latex).toBe('{x}');
    expect(sanitizeLatex(String.raw`\text{\style{position:fixed}{y}}`).latex).toBe(String.raw`\text{{y}}`);
    expect(sanitizeLatex(String.raw`\texttip{x}{\cssId{a}{y}}`).latex).toBe(String.raw`\texttip{x}{{y}}`);
    // Unbraced, MathLive would take the next token as the attribute; with the
    // command gone it is just maths.
    expect(sanitizeLatex(String.raw`\htmlStyle position:fixed x`).latex).toBe(' position:fixed x');
  });

  it('drops \\url whole', () => {
    expect(sanitizeLatex(String.raw`see \url{https://x.test} here`).latex).toBe('see  here');
  });

  it('leaves ordinary maths exactly as written', () => {
    for (const latex of [
      String.raw`\frac{1}{2}`,
      String.raw`\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}`,
      String.raw`\sum_{i=0}^{n} i^2`,
      String.raw`\text{cost \$5}`,
      String.raw`\\style`, // a line break followed by the letters s-t-y-l-e
      String.raw`\stylish x`, // a different (unknown) command
      String.raw`\color{red} x \textcolor{#00f}{y} \colorbox{Red!20}{z} \fcolorbox{red}{rgb(1, 2, 3)}{w}`,
      String.raw`\bbox[5px, border: 2px solid red]{x}`,
      String.raw`\enclose{circle}[2px dashed red]{x}`,
      String.raw`\text{\fontfamily{cmtt}x}`,
    ]) {
      expect(sanitizeLatex(latex), latex).toEqual({ latex, removed: [] });
    }
  });

  it('neutralises a colour that would carry CSS in with it', () => {
    expect(sanitizeLatex(String.raw`\color{;position:fixed}x`).latex).toBe(String.raw`\color{currentColor}x`);
    expect(sanitizeLatex(String.raw`\colorbox{;top:0}{x}`).latex).toBe(String.raw`\colorbox{transparent}{x}`);
    expect(sanitizeLatex(String.raw`\fcolorbox{;top:0}{red}{x}`).latex).toBe(
      String.raw`\fcolorbox{currentColor}{red}{x}`
    );
    expect(sanitizeLatex(String.raw`\textcolor{red;x:y}{x}`).removed).toEqual([String.raw`\textcolor{…}`]);
  });

  it('drops box options and font families that are not plain values', () => {
    expect(sanitizeLatex(String.raw`\bbox[border: 1px solid red;position:fixed]{x}`).latex).toBe(String.raw`\bbox{x}`);
    expect(sanitizeLatex(String.raw`\enclose{box}[mathbackground="red;position:fixed"]{x}`).latex).toBe(
      String.raw`\enclose{box}{x}`
    );
    expect(sanitizeLatex(String.raw`\enclose{box}[shadow="0 0 9em red"]{x}`).latex).toBe(String.raw`\enclose{box}{x}`);
    expect(sanitizeLatex(String.raw`\text{\fontfamily{;position:fixed}x}`).latex).toBe(String.raw`\text{x}`);
  });
});

describe('cleanStyle and cleanClass', () => {
  it('keeps MathLive layout and drops everything else', () => {
    expect(cleanStyle('height:0.44em;vertical-align:-0.19em')).toBe('height:0.44em;vertical-align:-0.19em');
    expect(cleanStyle('position:fixed;top:0')).toBe('top:0');
    expect(cleanStyle('position:relative;display:inline-block')).toBe('position:relative;display:inline-block');
    expect(cleanStyle('background-image:url(https://x.test/a.png)')).toBe('');
    expect(cleanStyle('color:var(--x);width:expression(alert(1))')).toBe('');
    expect(cleanStyle('left:calc(-1 * 1px - 0.3em);color:#d7170b')).toBe('left:calc(-1 * 1px - 0.3em);color:#d7170b');
    expect(cleanStyle('content:"x";cursor:pointer')).toBe('');
  });

  it('keeps only class names MathLive styles', () => {
    expect(cleanClass('ML__latex ML__base col-align-c lcGreek slice-1-of-3 btn modal')).toBe(
      'ML__latex ML__base col-align-c lcGreek slice-1-of-3'
    );
  });
});

describe('a formula through the whole pipeline', () => {
  it('renders `\\style{…}` without the style', () => {
    const host = render(String.raw`\style{position:fixed;top:0;left:0}{x}`);
    expect(host.querySelector('.ML__latex')).not.toBeNull();
    expect(host.textContent).toContain('x');
    expect(styles(host).join(';')).not.toMatch(/fixed|left:0/);
  });

  it('renders `\\cssId`, `\\href` and `\\htmlData` without their attributes', () => {
    for (const latex of [
      String.raw`\cssId{app}{x}`,
      String.raw`\href{https://evil.test}{x}`,
      String.raw`\href{javascript:alert(1)}{x}`,
      String.raw`\htmlData{a=b,href=https://evil.test}{x}`,
      String.raw`\class{btn}{x}`,
    ]) {
      const all = attributes(render(latex)).join('\n');
      expect(all, latex).not.toMatch(/ (?:id|href|data-[\w-]+)=/);
      expect(all, latex).not.toMatch(/class=[^\n]*\b(?:btn)\b/);
    }
  });

  it('keeps colours but not what was smuggled in with them', () => {
    const colored = render(String.raw`\color{red}{x}`);
    expect(styles(colored).join(';')).toMatch(/color:#[0-9a-f]{6}/);
    for (const latex of [
      String.raw`\color{;position:fixed}{x}`,
      String.raw`\colorbox{;top:0}{x}`,
      String.raw`\fcolorbox{;position:fixed}{red}{x}`,
      String.raw`\bbox[border: 1px solid red;position:fixed]{x}`,
      String.raw`\enclose{box}[mathbackground="red;position:fixed"]{x}`,
      String.raw`\text{\fontfamily{;position:fixed}x}`,
    ]) {
      expect(styles(render(latex)).join(';'), latex).not.toContain('fixed');
    }
  });

  it('removes injected elements and event handlers even if the markup had them', () => {
    const fragment = safeMathFragment(
      '<span class="ML__latex" onclick="alert(1)" id="x"><img src="x" onerror="alert(1)"><a href="javascript:1">a</a>' +
        '<svg onload="alert(1)" viewBox="0 0 1 1"><path d="M0 0" fill="url(#x)"/><script>alert(1)</script></svg></span>'
    );
    const host = document.createElement('div');
    host.append(fragment);
    expect(host.innerHTML).toBe(
      '<span class="ML__latex"><svg viewBox="0 0 1 1"><path d="M0 0"></path></svg></span>'
    );
  });
});
