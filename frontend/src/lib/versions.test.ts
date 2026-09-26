import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  currentVersion,
  latestVersion,
  nextVersionAfter,
  sortVersions,
  suggestNextNumber,
} from './versions';

const v = (id: string, number: string, completed = false, deleted_at: string | null = null) => ({
  id,
  number,
  completed,
  deleted_at,
});

describe('compareVersions', () => {
  it('compares numerically, part by part', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0);
  });

  it('treats a missing part as 0', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1', '1.0.1')).toBeLessThan(0);
  });

  it('puts a pre-release suffix just below its release', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
  });

  it('ignores a leading v', () => {
    expect(compareVersions('v1.2.0', '1.2.0')).toBe(0);
  });

  it('sorts words after numbers, by byte order', () => {
    expect(compareVersions('next', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('alpha', 'beta')).toBeLessThan(0);
  });
});

describe('sortVersions', () => {
  it('orders oldest first, deterministically for equal versions', () => {
    const sorted = sortVersions([v('c', '0.10.0'), v('b', '1.0.0'), v('a', '1.0'), v('d', '0.9.0')]);
    expect(sorted.map((x) => x.number)).toEqual(['0.9.0', '0.10.0', '1.0', '1.0.0']);
    // Same number twice: the id decides, identically on every device.
    expect(sortVersions([v('z', '1.0.0'), v('a', '1.0.0')]).map((x) => x.id)).toEqual(['a', 'z']);
  });
});

describe('currentVersion (D3)', () => {
  it('is the oldest incomplete live version', () => {
    const versions = [v('1', '0.1.0', true), v('3', '0.10.0'), v('2', '0.9.0'), v('4', '0.2.0', false, '2026-01-01')];
    expect(currentVersion(versions)?.id).toBe('2');
  });

  it('is undefined when everything is complete or there is nothing', () => {
    expect(currentVersion([v('1', '0.1.0', true)])).toBeUndefined();
    expect(currentVersion([])).toBeUndefined();
  });
});

describe('nextVersionAfter', () => {
  const versions = [v('a', '0.1.0'), v('b', '0.2.0', true), v('c', '0.3.0'), v('d', '0.10.0')];

  it('skips completed versions', () => {
    expect(nextVersionAfter(versions, versions[0]!)?.id).toBe('c');
  });

  it('is the lowest greater one', () => {
    expect(nextVersionAfter(versions, versions[2]!)?.id).toBe('d');
  });

  it('is undefined past the last', () => {
    expect(nextVersionAfter(versions, versions[3]!)).toBeUndefined();
  });
});

describe('latestVersion', () => {
  it('is the highest, complete or not', () => {
    expect(latestVersion([v('a', '0.9.0'), v('b', '0.10.0', true)])?.id).toBe('b');
  });
});

describe('suggestNextNumber', () => {
  it('bumps the minor and zeroes the rest', () => {
    expect(suggestNextNumber('0.1.0')).toBe('0.2.0');
    expect(suggestNextNumber('1.2.3')).toBe('1.3.0');
    expect(suggestNextNumber('0.9.0')).toBe('0.10.0');
    expect(suggestNextNumber('1.2')).toBe('1.3');
    expect(suggestNextNumber('v1.4.2')).toBe('v1.5.0');
    expect(suggestNextNumber('1.0.0-beta')).toBe('1.1.0');
  });

  it('bumps a single number', () => {
    expect(suggestNextNumber('7')).toBe('8');
  });

  it('appends -next to anything else', () => {
    expect(suggestNextNumber('spring')).toBe('spring-next');
  });

  it('skips numbers already taken', () => {
    expect(suggestNextNumber('0.1.0', ['0.2.0', '0.3.0'])).toBe('0.4.0');
  });
});
