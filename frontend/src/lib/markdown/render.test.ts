import { describe, expect, it, vi } from 'vitest';
import { MISSING_IMAGE_SRC, renderMarkdown, shikiLanguage } from './render';

const UUID = '0b9f7c3e-2a41-4c5d-9e8f-1a2b3c4d5e6f';

describe('renderMarkdown sanitising', () => {
  it('drops raw HTML images with event handlers', async () => {
    const html = await renderMarkdown('before <img src=x onerror=alert(1)> after');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<img');
    expect(html).toContain('before');
  });

  it('strips an onerror smuggled into a block of raw HTML', async () => {
    const html = await renderMarkdown('<div><img src="x" onerror="alert(1)"></div>\n\ntext');
    expect(html).not.toMatch(/onerror|alert/);
  });

  it('removes javascript: hrefs but keeps the link text', async () => {
    const html = await renderMarkdown('[x](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('>x</a>');
  });

  it('keeps ordinary links', async () => {
    const html = await renderMarkdown('[site](https://example.com) [rel](./page)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="./page"');
  });

  it('removes script tags and their content', async () => {
    const html = await renderMarkdown('hi\n\n<script>alert(1)</script>\n\nthere');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  it('refuses a data: src that is not an image', async () => {
    const html = await renderMarkdown('![x](data:text/html;base64,PHNjcmlwdD4=)');
    expect(html).not.toContain('data:text/html');
  });

  it('keeps a data: image', async () => {
    const html = await renderMarkdown('![x](data:image/png;base64,iVBORw0KGgo=)');
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });
});

describe('renderMarkdown GFM', () => {
  it('renders a table', async () => {
    const html = await renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>2</td>');
  });

  it('renders a task list with disabled checkboxes', async () => {
    const html = await renderMarkdown('- [ ] todo\n- [x] done\n');
    expect(html).toContain('class="contains-task-list"');
    expect(html).toContain('class="task-list-item"');
    expect(html).toMatch(/<input type="checkbox" disabled>/);
    expect(html).toMatch(/<input type="checkbox" checked disabled>/);
  });
});

describe('renderMarkdown footnotes', () => {
  const md = 'Ada wrote it.[^ada]\n\n[^ada]: Note G.\n';

  it('renders the reference and the note', async () => {
    const html = await renderMarkdown(md);
    expect(html).toContain('data-footnotes');
    expect(html).toContain('data-footnote-ref');
    expect(html).toContain('data-footnote-backref');
    expect(html).toContain('Note G.');
  });

  it('points every in-document link at an id that exists', async () => {
    const html = await renderMarkdown(md);
    const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    const targets = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThanOrEqual(2);
    for (const target of targets) expect(ids).toContain(target);
    // aria-describedby names the sr-only heading.
    const described = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(ids).toContain(described);
  });

  it('keeps ids clobber-prefixed, and namespaces them per render', async () => {
    const html = await renderMarkdown(md, { idPrefix: 'p7-' });
    expect(html).toContain('id="user-content-p7-fn-ada"');
    expect(html).toContain('href="#user-content-p7-fn-ada"');
  });
});

describe('renderMarkdown math', () => {
  // The pipeline only marks formulas up; MathLive typesets them in the
  // browser (lib/math/typeset.ts), so there is no KaTeX markup here at all.
  it('leaves inline math as a data-math placeholder holding the LaTeX as text', async () => {
    const html = await renderMarkdown('Area is $\\pi r^2$.');
    expect(html).toBe(
      '<p>Area is <span class="math math-inline" data-math="\\pi r^2">\\pi r^2</span>.</p>'
    );
    expect(html).not.toContain('katex');
  });

  it('keeps $$x^2$$ inside a sentence inline', async () => {
    const html = await renderMarkdown('$$x^2$$');
    expect(html).toContain('<span class="math math-inline" data-math="x^2">x^2</span>');
    expect(html).not.toContain('$$');
  });

  it('turns a $$ block into a display placeholder', async () => {
    const html = await renderMarkdown('$$\nx^2\n$$\n');
    expect(html).toBe('<div class="math math-display" data-math="x^2" data-display="">x^2</div>');
  });

  it('treats a ```math fence as display math, not code', async () => {
    const html = await renderMarkdown('```math\na + b\n```\n');
    expect(html).toBe('<div class="math math-display" data-math="a + b" data-display="">a + b</div>');
    expect(html).not.toContain('astro-code');
  });

  it('escapes the LaTeX: it is text, never markup', async () => {
    // A bare `<` is inert inside a quoted attribute; the quote is what must
    // be escaped there, and `<` in the text.
    const html = await renderMarkdown('$<img src=x onerror=alert(1)>$ and $a"b$');
    expect(html).toBe(
      '<p><span class="math math-inline" data-math="<img src=x onerror=alert(1)>">&#x3C;img src=x onerror=alert(1)></span>' +
        ' and <span class="math math-inline" data-math="a&#x22;b">a"b</span></p>'
    );
  });

  it('passes MathLive attribute commands through as text for the typesetter to filter', async () => {
    // lib/math/sanitize.ts strips these before MathLive sees them; here they
    // are just characters in an attribute and a text node.
    const html = await renderMarkdown('$\\style{position:fixed}{x}$');
    expect(html).toBe(
      '<p><span class="math math-inline" data-math="\\style{position:fixed}{x}">\\style{position:fixed}{x}</span></p>'
    );
  });

  describe('money is not maths', () => {
    it('keeps two prices on one line as prose', async () => {
      const html = await renderMarkdown('It cost $5 and $10.');
      expect(html).toBe('<p>It cost $5 and $10.</p>');
    });

    it('keeps a price range as prose', async () => {
      expect(await renderMarkdown('Between $12 and $15 today')).toBe('<p>Between $12 and $15 today</p>');
    });

    it('keeps a single price as prose', async () => {
      expect(await renderMarkdown('costs $7 today')).toBe('<p>costs $7 today</p>');
    });

    it('renders real maths beside an escaped price', async () => {
      const html = await renderMarkdown('Pay \\$5 for $x^2$.');
      expect(html).toBe('<p>Pay $5 for <span class="math math-inline" data-math="x^2">x^2</span>.</p>');
    });

    it('leaves a lone price and a formula on one line as text (known limit; escape the price)', async () => {
      // micromark pairs the price's `$` with the formula's opening one, the
      // strict rule hands that back as text, and the formula has lost its
      // opener — the same thing the editor canvas does (notey's documented
      // limit). Nothing is lost: the markdown is untouched.
      expect(await renderMarkdown('Pay $5 for $x^2$.')).toBe('<p>Pay $5 for $x^2$.</p>');
    });

    it('does not treat a formula with a space inside the delimiters as maths', async () => {
      expect(await renderMarkdown('a $ x $ b')).toBe('<p>a $ x $ b</p>');
    });
  });
});

describe('renderMarkdown code', () => {
  it('highlights a shortlisted language with Shiki', async () => {
    const html = await renderMarkdown('```ts\nconst x: number = 1;\n```\n');
    expect(html).toContain('class="shiki shiki-themes github-light github-dark astro-code"');
    expect(html).toContain('--shiki-light:');
    expect(html).toContain('--shiki-dark:');
  });

  it('falls back to plain text for a language off the shortlist', async () => {
    const html = await renderMarkdown('```cobol\nDISPLAY "HI".\n```\n');
    expect(html).toContain('astro-code');
    expect(html).toContain('DISPLAY');
  });

  it('escapes code content', async () => {
    const html = await renderMarkdown('```html\n<script>alert(1)</script>\n```\n');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&#x3C;');
  });

  it('maps fence names onto the shortlisted grammars', () => {
    expect(shikiLanguage('TypeScript')).toBe('typescript');
    expect(shikiLanguage('sh')).toBe('shellscript');
    expect(shikiLanguage('c++')).toBe('cpp');
    expect(shikiLanguage('yml')).toBe('yaml');
    expect(shikiLanguage('cobol')).toBeNull();
  });
});

describe('renderMarkdown mermaid', () => {
  it('turns a mermaid fence into the placeholder, source escaped', async () => {
    const html = await renderMarkdown('```mermaid\nflowchart TD\n  A["<b>x</b>"] --> B\n```\n');
    // Quotes are escaped in the attribute (so it can't be broken out of — a
    // bare `<` is inert inside a quoted attribute), and the text is escaped.
    expect(html).toBe(
      '<pre class="mermaid" data-mermaid-source="flowchart TD\n  A[&#x22;<b>x</b>&#x22;] --> B">' +
        'flowchart TD\n  A["&#x3C;b>x&#x3C;/b>"] --> B</pre>'
    );
  });
});

describe('renderMarkdown images', () => {
  it('passes asset refs to resolveImage', async () => {
    const resolveImage = vi.fn(() => 'blob:http://localhost/abc');
    const src = `assets/${UUID}.excalidraw.png`;
    const html = await renderMarkdown(`![d](${src})`, { resolveImage });
    expect(resolveImage).toHaveBeenCalledWith(src);
    expect(html).toContain('src="blob:http://localhost/abc"');
  });

  it('never passes absolute URLs to resolveImage', async () => {
    const resolveImage = vi.fn(() => 'blob:nope');
    await renderMarkdown('![a](https://example.com/a.png) ![b](/root.png)', { resolveImage });
    expect(resolveImage).not.toHaveBeenCalled();
  });

  it('shows a placeholder for an asset the resolver does not have', async () => {
    const html = await renderMarkdown(`![gone](assets/${UUID}.png)`, { resolveImage: () => undefined });
    expect(html).toContain('class="asset-missing"');
    expect(html).toContain(MISSING_IMAGE_SRC.slice(0, 30));
    expect(html).toContain('alt="gone"');
  });
});
