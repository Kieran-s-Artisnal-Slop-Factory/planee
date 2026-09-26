/**
 * Keeping a formula from choosing the attributes of the page it lands on
 * (D21).
 *
 * Formulas are user content that syncs between devices, and MathLive — unlike
 * KaTeX with `trust: false` — renders several LaTeX commands whose whole job
 * is to put an attribute of the author's choosing on its markup:
 *
 *   \htmlStyle{…}{x}, \style{…}{x}   → style="…"   (position:fixed over the app)
 *   \class{…}{x}, \htmlClass{…}{x}   → class="…"   (the app's own classes)
 *   \cssId{…}{x}, \htmlId{…}{x}      → id="…"      (clobbering the app's ids)
 *   \htmlData{a=b,href=…}{x}         → data-a="b", href="…"
 *   \href{url}{x}                    → href="url"
 *
 * and a few more pass a value straight through into a `style` attribute
 * without checking it, so a `;` in the value starts a declaration of the
 * author's choosing: a colour MathLive does not recognise (`\color{;top:0}`,
 * `\colorbox`, `\textcolor`, `\fcolorbox`), `\fontfamily{…}`, `\bbox[…]`'s
 * options and `\enclose{…}[…]`'s style argument.
 *
 * Two layers, both applied everywhere a formula is drawn — the preview and
 * table cells (`renderMathIn`), the editor canvas (`typeset`) and the
 * formula dialog's mathfield:
 *
 *  1. `sanitizeLatex` rewrites the LaTeX before MathLive sees it: the
 *     attribute commands are removed with their attribute argument (the
 *     content stays, so `\style{…}{x}` still shows `x`), `\url{…}` is removed
 *     whole, and a colour, font family or box option that is not a plain
 *     value is replaced by a neutral one (or dropped).
 *  2. `cleanMathMarkup` walks the markup MathLive produced and keeps only
 *     what its layout engine itself emits: `span` and a handful of SVG
 *     shapes; MathLive's own class names; `style` declarations from a fixed
 *     list of layout properties whose values are plain lengths, keywords and
 *     colours (`position` only relative/absolute); SVG geometry attributes.
 *     No `id`, `href`, `data-*`, event handler or anything else survives,
 *     whatever the LaTeX said.
 *
 * MathLive has no `\def`/`\newcommand`, so a forbidden command cannot be
 * assembled out of pieces the first layer would not recognise; the second
 * layer is there in case a future MathLive adds one.
 *
 * `sanitizeLatex` is pure; `cleanMathMarkup` needs a DOM (the browser, or
 * happy-dom in sanitize.test.ts).
 */

/** Commands that exist to set an attribute: removed with their attribute argument. */
export const ATTRIBUTE_COMMANDS: readonly string[] = [
  'htmlStyle',
  'style',
  'class',
  'htmlClass',
  'cssId',
  'htmlId',
  'htmlData',
  'href',
];

/** Commands removed together with their (only) argument. */
const DROPPED_WHOLE = new Set(['url']);

/**
 * Colour commands and what an unacceptable colour becomes. `currentColor`
 * and `transparent` are what MathLive would pass through anyway for a
 * colour it cannot map, so the formula still renders — just uncoloured.
 */
const COLOR_COMMANDS: Record<string, readonly string[]> = {
  color: ['currentColor'],
  textcolor: ['currentColor'],
  colorbox: ['transparent'],
  fcolorbox: ['currentColor', 'transparent'],
};

/** A colour as LaTeX writes one: `red`, `Red!20!blue`, `-red`, `#f00`, `rgb(1, 2, 3)`. */
const SAFE_COLOR = /^\s*-?[A-Za-z0-9#!.,()% ]*\s*$/;
/** A font family name. */
const SAFE_FONT = /^\s*[A-Za-z][A-Za-z0-9 _-]*\s*$/;
/** `\bbox[5px, border: 2px solid red]` — MathLive parses it, but passes `border` through. */
const SAFE_BBOX = /^[A-Za-z0-9#!.,()% :-]*$/;
/** `\enclose{box}[2px dashed red]`, `[mathcolor="red"]`. */
const SAFE_ENCLOSE = /^[A-Za-z0-9#!.,()% ="-]*$/;

export interface SanitizedLatex {
  latex: string;
  /** What was taken out or neutralised, e.g. `\style`, `\color{…}` — empty when nothing was. */
  removed: string[];
}

const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

function skipSpace(s: string, i: number): number {
  while (isSpace(s[i])) i++;
  return i;
}

/**
 * The index just past the `{…}` group starting at `start` (which must be a
 * `{`), honouring nesting and backslash escapes. An unclosed group runs to
 * the end of the text, which is how MathLive reads one too.
 */
function groupEnd(s: string, start: number, open = '{', close = '}'): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      i++; // whatever follows a backslash is escaped
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (open === '[' && ch === close && depth === 0) return i + 1;
    if (open === '{' && depth === 0) return i + 1;
  }
  return s.length;
}

/** The `[…]` optional argument starting at `start` (a `[`): braces inside it nest. */
function optionalEnd(s: string, start: number): number {
  return groupEnd(s, start, '[', ']');
}

/**
 * Take the attribute-setting commands out of `latex` and neutralise the
 * values MathLive would pass into a `style` unchecked. Everything else is
 * returned exactly as written.
 */
export function sanitizeLatex(latex: string): SanitizedLatex {
  const removed: string[] = [];
  let out = '';
  let i = 0;
  const s = latex;

  while (i < s.length) {
    const ch = s[i]!;
    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }
    const name = /^\\([A-Za-z]+)/.exec(s.slice(i, i + 64))?.[1];
    if (!name) {
      // `\\`, `\{`, `\$`, a control space… copied as the pair they are.
      out += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    let j = i + 1 + name.length;

    if (ATTRIBUTE_COMMANDS.includes(name) || DROPPED_WHOLE.has(name)) {
      removed.push('\\' + name);
      const k = skipSpace(s, j);
      // The attribute argument goes with the command. Unbraced, MathLive
      // would read the next token as the attribute; without the command it is
      // just ordinary maths again, so it can stay.
      if (s[k] === '{') j = groupEnd(s, k);
      i = j;
      continue;
    }

    const colors = COLOR_COMMANDS[name];
    if (colors) {
      let written = '\\' + name;
      let ok = true;
      for (const fallback of colors) {
        const k = skipSpace(s, j);
        if (s[k] !== '{') {
          ok = false;
          break;
        }
        const end = groupEnd(s, k);
        const value = s.slice(k + 1, Math.max(k + 1, end - 1));
        if (SAFE_COLOR.test(value)) {
          written += `{${value}}`;
        } else {
          written += `{${fallback}}`;
          removed.push(`\\${name}{…}`);
        }
        j = end;
      }
      if (!ok) {
        // An unbraced colour: drop the command, keep what followed it.
        removed.push('\\' + name);
        i = j;
        continue;
      }
      out += written;
      i = j;
      continue;
    }

    if (name === 'fontfamily') {
      const k = skipSpace(s, j);
      if (s[k] === '{') {
        const end = groupEnd(s, k);
        const value = s.slice(k + 1, Math.max(k + 1, end - 1));
        if (SAFE_FONT.test(value)) {
          out += `\\fontfamily{${value}}`;
        } else {
          removed.push('\\fontfamily{…}');
        }
        i = end;
      } else {
        removed.push('\\fontfamily');
        i = j;
      }
      continue;
    }

    if (name === 'bbox') {
      out += '\\bbox';
      const k = skipSpace(s, j);
      if (s[k] === '[') {
        const end = optionalEnd(s, k);
        const value = s.slice(k + 1, Math.max(k + 1, end - 1));
        if (SAFE_BBOX.test(value)) out += `[${value}]`;
        else removed.push('\\bbox[…]');
        j = end;
      }
      i = j;
      continue;
    }

    if (name === 'enclose') {
      out += '\\enclose';
      let k = skipSpace(s, j);
      if (s[k] === '{') {
        const end = groupEnd(s, k);
        out += s.slice(j, end); // the notation: a list of flags, never CSS
        j = end;
        k = skipSpace(s, j);
        if (s[k] === '[') {
          const optEnd = optionalEnd(s, k);
          const value = s.slice(k + 1, Math.max(k + 1, optEnd - 1));
          if (SAFE_ENCLOSE.test(value) && !/shadow/i.test(value)) out += `[${value}]`;
          else removed.push('\\enclose[…]');
          j = optEnd;
        }
      }
      i = j;
      continue;
    }

    out += s.slice(i, j);
    i = j;
  }

  return { latex: out, removed };
}

/* ── The markup ──────────────────────────────────────────────────────── */

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'g', 'path', 'line', 'rect', 'circle', 'ellipse', 'polygon', 'polyline']);

/**
 * Class names MathLive's layout emits: its `ML__` namespace, plus the few
 * unprefixed ones `mathlive-static.css` styles.
 */
const CLASS_OK =
  /^(?:ML__[\w-]+|col-align-[a-z]|delim-size\d|lcGreek|overline|overline-line|underline|underline-line|slice-\d+-of-\d+|style-wrap)$/;

/** The properties MathLive's boxes set on themselves (Box.setStyle and friends). */
const STYLE_PROPS = new Set([
  'height',
  'width',
  'min-width',
  'top',
  'left',
  'right',
  'bottom',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-left',
  'padding-right',
  'vertical-align',
  'display',
  'position',
  'font-size',
  'font-family',
  'line-height',
  'color',
  'background-color',
  '--bg-color',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-color',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-radius',
  'box-sizing',
  'overflow',
  'z-index',
  'opacity',
]);

/** Plain CSS values: numbers, lengths, keywords, `#hex`. No quotes, colons, semicolons or escapes. */
const VALUE_OK = /^[\w\s.,#%()+*/-]*$/;
/** The only functions a value may call. */
const FUNCTION_OK = /^(?:calc|rgb|rgba|hsl|hsla)$/i;

const KEYWORDS: Record<string, RegExp> = {
  position: /^(?:relative|absolute)$/,
  display: /^(?:inline-block|inline|block|inline-flex|flex|inline-table|table|table-row|table-cell|none)$/,
  overflow: /^(?:visible|hidden)$/,
  'box-sizing': /^(?:border-box|content-box)$/,
};

/** SVG geometry and paint, as MathLive draws stretchy delimiters, `\enclose` and `\cancel`. */
const SVG_ATTRS = new Set([
  'width',
  'height',
  'viewBox',
  'preserveAspectRatio',
  'fill',
  'fill-rule',
  'd',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'points',
  'vector-effect',
]);

function plainValue(value: string): boolean {
  if (!VALUE_OK.test(value)) return false;
  for (const call of value.matchAll(/([A-Za-z-]+)\s*\(/g)) {
    if (!FUNCTION_OK.test(call[1]!)) return false;
  }
  return true;
}

/** The declarations of a MathLive `style` attribute worth keeping, re-joined; '' if none. */
export function cleanStyle(style: string): string {
  const kept: string[] = [];
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (!STYLE_PROPS.has(property) || value === '' || !plainValue(value)) continue;
    const keyword = KEYWORDS[property];
    if (keyword && !keyword.test(value)) continue;
    kept.push(`${property}:${value}`);
  }
  return kept.join(';');
}

/** MathLive's own class names out of a `class` attribute; '' if none. */
export function cleanClass(value: string): string {
  return value
    .split(/\s+/)
    .filter((token) => CLASS_OK.test(token))
    .join(' ');
}

/**
 * Strip everything MathLive's layout would not have produced from the
 * markup under `root`, in place: unknown elements go (with their contents),
 * and every attribute is checked against the lists above.
 */
export function cleanMathMarkup(root: ParentNode): void {
  for (const el of [...root.querySelectorAll('*')]) {
    const svg = el.namespaceURI === SVG_NS;
    const tag = el.localName;
    if (svg ? !SVG_TAGS.has(tag) : tag !== 'span') {
      el.remove();
      continue;
    }
    for (const { name, value } of [...el.attributes]) {
      if (name === 'class') {
        const next = cleanClass(value);
        if (next) el.setAttribute('class', next);
        else el.removeAttribute('class');
      } else if (name === 'style') {
        const next = cleanStyle(value);
        if (next) el.setAttribute('style', next);
        else el.removeAttribute('style');
      } else if (name === 'aria-hidden' && (value === 'true' || value === 'false')) {
        // kept
      } else if (svg && SVG_ATTRS.has(name) && plainValue(value)) {
        // kept
      } else {
        el.removeAttribute(name);
      }
    }
  }
}

/**
 * Parse MathLive's markup into an inert fragment and clean it. A `<template>`
 * parses without running scripts or fetching images, so nothing in the
 * markup does anything before `cleanMathMarkup` has seen it.
 */
export function safeMathFragment(markup: string, doc: Document = document): DocumentFragment {
  const template = doc.createElement('template');
  template.innerHTML = markup;
  cleanMathMarkup(template.content);
  return template.content;
}
