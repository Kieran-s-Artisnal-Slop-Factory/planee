// Ported from notey src/lib/notebook/drawing.test.ts — the ref rules only.
// planee's vendored fonts are guarded by src/lib/sw.test.ts instead.
import { describe, expect, it } from 'vitest';
import { DRAWING_SUFFIX, drawingFilename, isDrawingRef } from './excalidraw';

describe('drawing refs', () => {
  it('recognises the .excalidraw.png convention and nothing else', () => {
    expect(isDrawingRef('assets/0b9f7c3e-2a41-4c5d-9e8f-1a2b3c4d5e6f.excalidraw.png')).toBe(true);
    expect(isDrawingRef('images/PLAN.EXCALIDRAW.PNG')).toBe(true);
    expect(isDrawingRef('images/plan.excalidraw.png?v=2#x')).toBe(true);
    expect(isDrawingRef('images/plan.png')).toBe(false);
    expect(isDrawingRef('images/excalidraw.png')).toBe(false);
  });

  it('names a new drawing from its title, or "drawing"', () => {
    expect(drawingFilename()).toBe('drawing' + DRAWING_SUFFIX);
    expect(drawingFilename('  ')).toBe('drawing' + DRAWING_SUFFIX);
    expect(drawingFilename('Q3 Plan — draft!')).toBe('q3-plan-draft' + DRAWING_SUFFIX);
  });
});
