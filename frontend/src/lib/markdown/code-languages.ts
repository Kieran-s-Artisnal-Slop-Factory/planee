/**
 * The language list for Crepe's in-editor code blocks.
 *
 * Ported from retoken (af25bc6) src/lib/markdown/code-languages.ts. Changed:
 * the base list is planee's trimmed shortlist (./codemirror-language-data.ts,
 * which astro.config.mjs also aliases `@codemirror/language-data` to) rather
 * than CodeMirror's full ~150-language set (D11). Each entry still lazy-loads
 * its grammar on first use. **mermaid** additionally carries our completion
 * source so authors get intellisense while typing a diagram in a fenced block.
 */
import { LanguageDescription, LanguageSupport } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { languages as builtinLanguages } from './codemirror-language-data';
import { mermaidCompletionSource } from './mermaid';

/**
 * mermaid, with completions attached to the language itself.
 *
 * Registered as a `languageData` PROVIDER rather than through
 * `language.data.of(...)`: `codemirror-lang-mermaid` dispatches to a
 * per-diagram grammar (flowchart, sequence, …) after the first line, and
 * per-language data only resolves for whichever grammar covers the cursor —
 * attaching to the top-level language yields completions on line 1 and
 * silence everywhere else. A provider answers for every position. It needs
 * no language check because these extensions are only installed in the
 * CodeMirror instance of a block whose language *is* mermaid.
 */
const mermaidDescription = LanguageDescription.of({
  name: 'mermaid',
  alias: ['mmd'],
  extensions: ['mmd', 'mermaid'],
  async load() {
    const { mermaid } = await import('codemirror-lang-mermaid');
    const base = mermaid();
    return new LanguageSupport(base.language, [
      base.support,
      EditorState.languageData.of(() => [{ autocomplete: mermaidCompletionSource }]),
    ]);
  },
});

/** Passed to Crepe as `[Crepe.Feature.CodeMirror]: { languages }`. */
export const codeBlockLanguages: LanguageDescription[] = [...builtinLanguages, mermaidDescription];
