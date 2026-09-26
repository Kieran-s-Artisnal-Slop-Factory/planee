import { describe, expect, it } from 'vitest';
import { chordLabel, chordOf, chordParts, matchesChord, normaliseChord, parseChord } from './keys';
import { KEYMAP, appChords } from './keymap';

type Ev = Partial<KeyboardEvent>;
const ev = (e: Ev): KeyboardEvent =>
  ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, key: '', code: '', ...e }) as KeyboardEvent;

describe('chords', () => {
  it('parses and tidies spellings', () => {
    expect(normaliseChord('shift+ctrl+1')).toBe('Ctrl+Shift+1');
    expect(normaliseChord('ctrl+arrowup')).toBe('Ctrl+ArrowUp');
    expect(normaliseChord('pagedown')).toBe('PageDown');
    expect(normaliseChord('Ctrl+Nope')).toBeNull();
    expect(normaliseChord('Hyper+A')).toBeNull();
    expect(parseChord('Ctrl+e')?.key).toBe('E');
  });

  it('matches on code, so Shift+digit and macOS Option still match', () => {
    expect(matchesChord(ev({ ctrlKey: true, shiftKey: true, key: '!', code: 'Digit1' }), 'Ctrl+Shift+1')).toBe(true);
    expect(matchesChord(ev({ altKey: true, key: 'ƒ', code: 'KeyF' }), 'Alt+F')).toBe(true);
    expect(matchesChord(ev({ ctrlKey: true, key: 'Enter', code: 'NumpadEnter' }), 'Ctrl+Enter')).toBe(true);
    expect(matchesChord(ev({ ctrlKey: true, key: 'ArrowUp', code: 'ArrowUp' }), 'Ctrl+ArrowUp')).toBe(true);
    expect(matchesChord(ev({ shiftKey: true, key: 'Tab', code: 'Tab' }), 'Shift+Tab')).toBe(true);
  });

  it('compares every modifier', () => {
    expect(matchesChord(ev({ ctrlKey: true, shiftKey: true, code: 'Digit1', key: '!' }), 'Ctrl+1')).toBe(false);
    expect(matchesChord(ev({ ctrlKey: true, code: 'Digit1', key: '1' }), 'Ctrl+Shift+1')).toBe(false);
    expect(matchesChord(ev({ code: 'Tab', key: 'Tab', shiftKey: true }), 'Tab')).toBe(false);
  });

  it('falls back to key when there is no code', () => {
    expect(matchesChord(ev({ ctrlKey: true, key: 'k' }), 'Ctrl+K')).toBe(true);
    expect(matchesChord(ev({ key: ' ' }), 'Space')).toBe(true);
  });

  it('records a chord from an event', () => {
    expect(chordOf(ev({ ctrlKey: true, shiftKey: true, code: 'KeyC', key: 'C' }))).toBe('Ctrl+Shift+C');
    expect(chordOf(ev({ code: 'ControlLeft', key: 'Control', ctrlKey: true }))).toBeNull();
  });

  it('displays arrows and page keys as glyphs', () => {
    expect(chordParts('Ctrl+ArrowUp')).toEqual(['Ctrl', '↑']);
    expect(chordLabel('PageDown')).toBe('PgDn');
    expect(chordLabel('Meta+K')).toBe('Cmd+K');
  });
});

describe('keymap', () => {
  it('has unique ids and valid chords, with no chord bound twice in one scope', () => {
    const ids = new Set<string>();
    const seen = new Map<string, string>();
    for (const bind of KEYMAP) {
      expect(ids.has(bind.id), bind.id).toBe(false);
      ids.add(bind.id);
      for (const chord of [...bind.keys, ...(bind.fallback ? [bind.fallback] : [])]) {
        const tidy = normaliseChord(chord);
        expect(tidy, `${bind.id}: ${chord}`).toBe(chord);
        const key = bind.scope + ':' + tidy;
        expect(seen.get(key), `${chord} bound twice in ${bind.scope}`).toBeUndefined();
        seen.set(key, bind.id);
      }
    }
    expect(appChords()).toContain('Alt+N');
  });
});
