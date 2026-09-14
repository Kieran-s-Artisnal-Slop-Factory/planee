/**
 * A trimmed stand-in for `@codemirror/language-data` (D11).
 *
 * The real package lists ~150 languages, each behind a dynamic import, and a
 * bundler emits a chunk for every one of them whether or not anything ever
 * loads it — so the offline precache would carry the whole of
 * `@codemirror/legacy-modes`. Crepe imports that list as its default code-block
 * language set, which is why astro.config.mjs ALIASES the bare specifier
 * `@codemirror/language-data` to this file: Crepe and our own editor both see
 * only the shortlist below.
 *
 * The descriptions are copied from @codemirror/language-data 6.5 (same names,
 * aliases, extensions and loaders), filtered to the languages Shiki also
 * highlights in the preview (lib/markdown/render.ts `SHIKI_LANGS`). Svelte and
 * Astro have no CodeMirror package; they borrow the HTML mode, which is what
 * both files mostly are. Mermaid is added by code-languages.ts.
 */
import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from '@codemirror/language';

function legacy(parser: StreamParser<unknown>): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(parser));
}

function html() {
  return import('@codemirror/lang-html').then((m) => m.html());
}

export const languages: LanguageDescription[] = [
  LanguageDescription.of({
    name: 'C',
    extensions: ['c', 'h', 'ino'],
    load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  }),
  LanguageDescription.of({
    name: 'C++',
    alias: ['cpp'],
    extensions: ['cpp', 'c++', 'cc', 'cxx', 'hpp', 'h++', 'hh', 'hxx'],
    load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  }),
  LanguageDescription.of({
    name: 'CSS',
    extensions: ['css'],
    load: () => import('@codemirror/lang-css').then((m) => m.css()),
  }),
  LanguageDescription.of({
    name: 'Go',
    alias: ['golang'],
    extensions: ['go'],
    load: () => import('@codemirror/lang-go').then((m) => m.go()),
  }),
  LanguageDescription.of({
    name: 'HTML',
    alias: ['xhtml'],
    extensions: ['html', 'htm', 'handlebars', 'hbs'],
    load: html,
  }),
  LanguageDescription.of({
    name: 'Java',
    extensions: ['java'],
    load: () => import('@codemirror/lang-java').then((m) => m.java()),
  }),
  LanguageDescription.of({
    name: 'JavaScript',
    alias: ['ecmascript', 'js', 'node'],
    extensions: ['js', 'mjs', 'cjs'],
    load: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  }),
  LanguageDescription.of({
    name: 'JSON',
    alias: ['json5', 'jsonc'],
    extensions: ['json', 'map', 'jsonc'],
    load: () => import('@codemirror/lang-json').then((m) => m.json()),
  }),
  LanguageDescription.of({
    name: 'JSX',
    extensions: ['jsx'],
    load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  }),
  LanguageDescription.of({
    name: 'Markdown',
    alias: ['md'],
    extensions: ['md', 'markdown', 'mkd'],
    load: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  }),
  LanguageDescription.of({
    name: 'Python',
    alias: ['py'],
    extensions: ['BUILD', 'bzl', 'py', 'pyw'],
    filename: /^(BUCK|BUILD)$/,
    load: () => import('@codemirror/lang-python').then((m) => m.python()),
  }),
  LanguageDescription.of({
    name: 'Rust',
    alias: ['rs'],
    extensions: ['rs'],
    load: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  }),
  LanguageDescription.of({
    name: 'SCSS',
    extensions: ['scss'],
    load: () => import('@codemirror/lang-sass').then((m) => m.sass()),
  }),
  LanguageDescription.of({
    name: 'SQL',
    extensions: ['sql'],
    load: () => import('@codemirror/lang-sql').then((m) => m.sql({ dialect: m.StandardSQL })),
  }),
  LanguageDescription.of({
    name: 'TSX',
    extensions: ['tsx'],
    load: () =>
      import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  }),
  LanguageDescription.of({
    name: 'TypeScript',
    alias: ['ts'],
    extensions: ['ts', 'mts', 'cts'],
    load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  }),
  LanguageDescription.of({
    name: 'Svelte',
    extensions: ['svelte'],
    load: html,
  }),
  LanguageDescription.of({
    name: 'Astro',
    extensions: ['astro'],
    load: html,
  }),
  LanguageDescription.of({
    name: 'XML',
    alias: ['rss', 'wsdl', 'xsd'],
    extensions: ['xml', 'xsl', 'xsd', 'svg'],
    load: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  }),
  LanguageDescription.of({
    name: 'YAML',
    alias: ['yml'],
    extensions: ['yaml', 'yml'],
    load: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  }),
  // Legacy modes ported from CodeMirror 5
  LanguageDescription.of({
    name: 'diff',
    extensions: ['diff', 'patch'],
    load: () => import('@codemirror/legacy-modes/mode/diff').then((m) => legacy(m.diff)),
  }),
  LanguageDescription.of({
    name: 'Dockerfile',
    alias: ['docker'],
    filename: /^Dockerfile$/,
    load: () => import('@codemirror/legacy-modes/mode/dockerfile').then((m) => legacy(m.dockerFile)),
  }),
  LanguageDescription.of({
    name: 'PowerShell',
    alias: ['ps1', 'pwsh'],
    extensions: ['ps1', 'psd1', 'psm1'],
    load: () => import('@codemirror/legacy-modes/mode/powershell').then((m) => legacy(m.powerShell)),
  }),
  LanguageDescription.of({
    name: 'Properties files',
    alias: ['ini', 'properties'],
    extensions: ['properties', 'ini', 'in'],
    load: () => import('@codemirror/legacy-modes/mode/properties').then((m) => legacy(m.properties)),
  }),
  LanguageDescription.of({
    name: 'Shell',
    alias: ['bash', 'sh', 'zsh', 'shellscript'],
    extensions: ['sh', 'ksh', 'bash'],
    filename: /^PKGBUILD$/,
    load: () => import('@codemirror/legacy-modes/mode/shell').then((m) => legacy(m.shell)),
  }),
  LanguageDescription.of({
    name: 'TOML',
    extensions: ['toml'],
    load: () => import('@codemirror/legacy-modes/mode/toml').then((m) => legacy(m.toml)),
  }),
];
