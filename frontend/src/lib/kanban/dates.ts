// Ported from retoken (af25bc6)
/**
 * Due dates, as a board has to treat them.
 *
 * A due date is a CALENDAR DAY in the reader's own timezone, not a moment.
 * `'2026-03-04'` parsed with `new Date()` is UTC midnight — which is the 3rd in
 * the Americas — so plain date strings are built local-midnight here instead,
 * and every comparison is made between whole local days.
 *
 * Reading is deliberately forgiving, because a due field holds whatever the
 * storage behind it holds: a `Date`, epoch milliseconds or seconds, a plain
 * `YYYY-MM-DD`, an ISO timestamp. Writing gives it back in the SAME shape,
 * keeping any time of day that was already there — the board edits a date, it
 * does not get to change the type of a field it was handed.
 *
 * Pure and unit-tested (dates.test.ts). No Svelte, no DOM.
 */
import type { DueFormat } from './types';

export interface Due {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  /** Local midnight of that day, as epoch milliseconds. */
  time: number;
  /** Whether the source value carried a time of day. */
  hasTime: boolean;
  /** The value as it was found, for writing back in the same shape. */
  raw: unknown;
}

/** How near a due date has to be to count as "soon". */
export const DEFAULT_SOON_DAYS = 3;

const DAY_MS = 86_400_000;
const PLAIN_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/**
 * Below this, a number is read as epoch SECONDS rather than milliseconds:
 * 1e11 ms is 1973, and 1e11 seconds is the year 5138, so nothing real is
 * ambiguous.
 */
const SECONDS_CUTOFF = 1e11;

const pad = (n: number) => String(n).padStart(2, '0');

/** A `Date`'s local calendar day as `YYYY-MM-DD`. */
export const dayOf = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** Local midnight of a `YYYY-MM-DD` day, as epoch ms. NaN if unparseable. */
export function dayStart(day: string): number {
  const match = PLAIN_DAY.exec(day);
  if (!match) return NaN;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

/** Whether a moment carries a clock time, read in the reader's own timezone. */
const hasClockTime = (date: Date): boolean =>
  date.getHours() !== 0 ||
  date.getMinutes() !== 0 ||
  date.getSeconds() !== 0 ||
  date.getMilliseconds() !== 0;

/**
 * Read whatever the due field held. Accepts a `Date`, epoch ms or seconds, a
 * plain `YYYY-MM-DD` (as a LOCAL day, not UTC), an ISO timestamp, or anything
 * else `Date.parse` understands. Unreadable values are null — a broken date
 * leaves the card without one rather than showing a wrong one.
 */
export function parseDue(raw: unknown): Due | null {
  if (raw === null || raw === undefined || raw === '') return null;

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return { day: dayOf(raw), time: dayStart(dayOf(raw)), hasTime: hasClockTime(raw), raw };
  }

  if (typeof raw === 'number' || typeof raw === 'bigint') {
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    const ms = Math.abs(value) < SECONDS_CUTOFF ? value * 1000 : value;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return null;
    return { day: dayOf(date), time: dayStart(dayOf(date)), hasTime: hasClockTime(date), raw };
  }

  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  const plain = PLAIN_DAY.exec(text);
  if (plain) {
    const time = dayStart(text);
    if (Number.isNaN(time)) return null;
    // A day built from local parts round-trips: `2026-02-30` becomes March 2,
    // and reading the day back out is what reports the real date.
    return { day: dayOf(new Date(time)), time, hasTime: false, raw };
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  const day = dayOf(parsed);
  return { day, time: dayStart(day), hasTime: /\d:\d/.test(text), raw };
}

/** A `Due` for a day the reader picked, with no source value behind it. */
export const dueFromDay = (day: string | null): Due | null => {
  if (!day) return null;
  const time = dayStart(day);
  if (Number.isNaN(time)) return null;
  return { day: dayOf(new Date(time)), time, hasTime: false, raw: day };
};

/**
 * Whole days from today to a due date. Rounded, because a day across a
 * daylight-saving boundary is 23 or 25 hours long and truncating would report
 * "tomorrow" as today twice a year.
 */
export function dueDiffDays(due: Due, now: number = Date.now()): number {
  const today = dayStart(dayOf(new Date(now)));
  return Math.round((due.time - today) / DAY_MS);
}

export type DueState = 'none' | 'overdue' | 'today' | 'soon' | 'later';

/** How a due date should read: nothing, late, today, close, or far off. */
export function dueState(
  due: Due | null,
  now: number = Date.now(),
  soonDays: number = DEFAULT_SOON_DAYS
): DueState {
  if (!due) return 'none';
  const diff = dueDiffDays(due, now);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  return diff <= soonDays ? 'soon' : 'later';
}

/**
 * A short badge label: relative for the days around now, where "in 2 days"
 * is what a reader actually wants, and an absolute date beyond that.
 */
export function formatDue(due: Due, locale?: string, now: number = Date.now()): string {
  const diff = dueDiffDays(due, now);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff <= 6) return `In ${diff} days`;
  if (diff < -1 && diff >= -6) return `${-diff} days ago`;
  const date = new Date(due.time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  }).format(date);
}

/** The whole date, for a tooltip — the badge is deliberately terse. */
export function formatDueFull(due: Due, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(due.time));
}

/**
 * Which shape to write a date in. `auto` follows the value already in the
 * field, so a board over `Date` objects keeps handing back `Date` objects.
 */
function effectiveFormat(existing: unknown, format: DueFormat): Exclude<DueFormat, 'auto'> {
  if (format !== 'auto') return format;
  if (existing instanceof Date) return 'date';
  if (typeof existing === 'number' || typeof existing === 'bigint') return 'epoch';
  if (typeof existing === 'string' && /\d:\d/.test(existing)) return 'datetime';
  return 'iso';
}

/** The value as a `Date`, for lifting its clock time onto another day. */
function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' || typeof value === 'bigint') {
    const ms = Math.abs(Number(value)) < SECONDS_CUTOFF ? Number(value) * 1000 : Number(value);
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Write a picked day back in the field's own shape. A time of day already in
 * the field is kept — moving a deadline to another day shouldn't quietly reset
 * "5pm" to midnight.
 */
export function writeDue(
  day: string | null,
  existing: unknown,
  format: DueFormat = 'auto'
): unknown {
  if (!day) return null;
  const start = dayStart(day);
  if (Number.isNaN(start)) return null;

  const at = new Date(start);
  const previous = parseDue(existing);
  const clock = previous?.hasTime ? asDate(previous.raw) : null;
  if (clock) {
    at.setHours(clock.getHours(), clock.getMinutes(), clock.getSeconds(), clock.getMilliseconds());
  }

  switch (effectiveFormat(existing, format)) {
    case 'date':
      return at;
    case 'epoch':
      // Seconds in, seconds out.
      return typeof existing === 'number' && Math.abs(existing) < SECONDS_CUTOFF
        ? Math.round(at.getTime() / 1000)
        : at.getTime();
    case 'datetime':
      return at.toISOString();
    default:
      return dayOf(at);
  }
}
