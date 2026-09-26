/**
 * Version numbers: ordering, the "current" version (D3), and what comes next.
 *
 * Numbers are free text in the schema, so the ordering is semver-ish rather
 * than strict: dot-separated parts compared numerically (`0.9.0 < 0.10.0`),
 * with a missing part counting as 0 (`1.0` sorts with `1.0.0`), a numeric part
 * with a suffix sorting just below the bare number (`1.0.0-beta < 1.0.0`), and
 * anything non-numeric compared by byte order — never `localeCompare`, which
 * would let two devices disagree about which version is current.
 *
 * Pure and unit-tested (versions.test.ts).
 */
import type { Version } from './db/types';

type Part = { num: number | null; rest: string };

function parts(number: string): Part[] {
  const clean = number.trim().replace(/^v(?=\d)/i, '');
  if (clean === '') return [];
  return clean.split('.').map((raw) => {
    const match = /^(\d+)(.*)$/.exec(raw);
    return match ? { num: Number(match[1]), rest: match[2]! } : { num: null, rest: raw };
  });
}

const byteCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function comparePart(a: Part, b: Part): number {
  if (a.num !== null && b.num !== null) {
    if (a.num !== b.num) return a.num - b.num;
    // Same number: no suffix is the release, a suffix is a pre-release of it.
    if (a.rest === b.rest) return 0;
    if (a.rest === '') return 1;
    if (b.rest === '') return -1;
    return byteCompare(a.rest, b.rest);
  }
  // Numbers before words.
  if (a.num !== null) return -1;
  if (b.num !== null) return 1;
  return byteCompare(a.rest, b.rest);
}

/**
 * Negative when `a` sorts before `b`, positive after, 0 when they are the same
 * version (including `1.0` against `1.0.0`).
 */
export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  const zero: Part = { num: 0, rest: '' };
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = comparePart(left[i] ?? zero, right[i] ?? zero);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

type Numbered = Pick<Version, 'number'> & { id?: string };

/**
 * Oldest first. Versions that compare equal fall back to the raw number and
 * then the id, both by byte order, so every device sorts them identically.
 */
export function sortVersions<T extends Numbered>(versions: readonly T[]): T[] {
  return [...versions].sort(
    (a, b) =>
      compareVersions(a.number, b.number) ||
      byteCompare(a.number, b.number) ||
      byteCompare(a.id ?? '', b.id ?? '')
  );
}

type Candidate = Numbered & Pick<Version, 'completed'> & { deleted_at?: string | null };

const isOpen = (version: Candidate) => !version.completed && !version.deleted_at;

/**
 * D3: a project's current version is its OLDEST incomplete version. Pass the
 * project's versions; undefined when every one is complete (or there are none).
 */
export function currentVersion<T extends Candidate>(versions: readonly T[]): T | undefined {
  return sortVersions(versions.filter(isOpen))[0];
}

/** The lowest incomplete version strictly greater than `version`. */
export function nextVersionAfter<T extends Candidate>(
  versions: readonly T[],
  version: Numbered
): T | undefined {
  return sortVersions(
    versions.filter(
      (candidate) =>
        isOpen(candidate) &&
        candidate.id !== version.id &&
        compareVersions(candidate.number, version.number) > 0
    )
  )[0];
}

/** The highest version of all, complete or not. */
export function latestVersion<T extends Numbered>(versions: readonly T[]): T | undefined {
  const sorted = sortVersions(versions);
  return sorted[sorted.length - 1];
}

function bumpOnce(number: string): string {
  const trimmed = number.trim();
  const semver = /^(v?)(\d+)\.(\d+)((?:\.\d+)*)(?:[-+].*)?$/i.exec(trimmed);
  if (semver) {
    const [, prefix, major, minor, patchParts] = semver;
    const zeros = (patchParts ?? '').replace(/\d+/g, '0');
    return `${prefix}${major}.${Number(minor) + 1}${zeros}`;
  }
  const single = /^(v?)(\d+)$/i.exec(trimmed);
  if (single) return `${single[1]}${Number(single[2]) + 1}`;
  return `${trimmed}-next`;
}

/**
 * A minor bump: `0.1.0` → `0.2.0`, `1.2.3` → `1.3.0`, `1.2` → `1.3`, `7` → `8`;
 * a number that isn't numeric gets `-next`. With `existing`, keeps bumping
 * until the suggestion isn't already taken.
 */
export function suggestNextNumber(number: string, existing: readonly string[] = []): string {
  const taken = new Set(existing.map((n) => n.trim()));
  let next = bumpOnce(number || '0.0.0');
  for (let i = 0; i < 1000 && taken.has(next); i++) next = bumpOnce(next);
  return next;
}
