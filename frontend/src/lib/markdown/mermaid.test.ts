// Ported from notey src/lib/notebook/mermaid.test.ts (planee's mermaid.ts has the same authoring aids).
import { describe, expect, it } from 'vitest';
import { DIAGRAM_TEMPLATES, diagramKindOf, mermaidCompletions } from './mermaid';

// Only the pure authoring aids. Rendering lazy-loads mermaid and needs a DOM,
// so it is exercised by the Playwright suite.

describe('diagramKindOf', () => {
  it('reads the diagram type from the first meaningful line', () => {
    expect(diagramKindOf('flowchart TD\n  A --> B')).toBe('flowchart');
    expect(diagramKindOf('graph LR\n  A --> B')).toBe('flowchart');
    expect(diagramKindOf('sequenceDiagram\n  A->>B: hi')).toBe('sequence');
    expect(diagramKindOf('classDiagram\n  class A')).toBe('class');
    expect(diagramKindOf('stateDiagram-v2\n  [*] --> A')).toBe('state');
    expect(diagramKindOf('erDiagram\n  A ||--o{ B : has')).toBe('er');
    expect(diagramKindOf('gantt\n  title x')).toBe('gantt');
    expect(diagramKindOf('pie title x\n  "a" : 1')).toBe('pie');
    expect(diagramKindOf('mindmap\n  root((x))')).toBe('mindmap');
    expect(diagramKindOf('journey\n  title x')).toBe('journey');
    expect(diagramKindOf('timeline\n  title x')).toBe('timeline');
  });

  it('skips blank lines and %% comments, and is case-insensitive', () => {
    expect(diagramKindOf('\n\n%% a comment\n  FLOWCHART LR\n')).toBe('flowchart');
  });

  it('is null for unknown or empty source', () => {
    expect(diagramKindOf('')).toBeNull();
    expect(diagramKindOf('%% only a comment')).toBeNull();
    expect(diagramKindOf('quadrantChart\n  title x')).toBeNull();
    expect(diagramKindOf('flowcharts TD')).toBeNull();
  });
});

describe('mermaidCompletions', () => {
  it('offers diagram types on the first line', () => {
    const options = mermaidCompletions('', true);
    const labels = options.map((o) => o.label);
    expect(labels).toContain('flowchart TD');
    expect(labels).toContain('sequenceDiagram');
    expect(labels).toContain('gitGraph');
    for (const o of options) expect(o.type).toBe('keyword');
  });

  it('offers the keyword set for the detected diagram elsewhere', () => {
    const seq = mermaidCompletions('sequenceDiagram\n', false).map((o) => o.label);
    expect(seq).toContain('participant');
    expect(seq).not.toContain('subgraph');
    const flow = mermaidCompletions('graph TD\n', false).map((o) => o.label);
    expect(flow).toContain('subgraph');
    expect(flow).not.toContain('participant');
  });

  it('offers nothing below the first line of an unknown diagram', () => {
    expect(mermaidCompletions('quadrantChart\n', false)).toEqual([]);
    expect(mermaidCompletions('', false)).toEqual([]);
  });
});

describe('DIAGRAM_TEMPLATES', () => {
  it('has eight templates with unique ids and labels', () => {
    expect(DIAGRAM_TEMPLATES).toHaveLength(8);
    expect(new Set(DIAGRAM_TEMPLATES.map((t) => t.id)).size).toBe(8);
    expect(new Set(DIAGRAM_TEMPLATES.map((t) => t.label)).size).toBe(8);
    for (const t of DIAGRAM_TEMPLATES) {
      expect(t.id).toMatch(/^[a-z]+$/);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.code.trim().length).toBeGreaterThan(0);
    }
  });

  it('opens every template with a diagram type the completer recognises', () => {
    for (const t of DIAGRAM_TEMPLATES) {
      expect(diagramKindOf(t.code), `${t.id} starts with a diagram type`).not.toBeNull();
    }
    expect(DIAGRAM_TEMPLATES.map((t) => diagramKindOf(t.code))).toEqual(
      DIAGRAM_TEMPLATES.map((t) => t.id)
    );
  });
});
