// Ported from retoken (af25bc6)
import { describe, expect, it } from 'vitest';
import {
  dayOf,
  dayStart,
  dueDiffDays,
  dueFromDay,
  dueState,
  formatDue,
  formatDueFull,
  parseDue,
  writeDue,
} from './dates';

/** Local noon on 27 August 2026 — built from local parts, so timezone-proof. */
const NOW = new Date(2026, 7, 27, 12, 0, 0).getTime();

describe('dayOf / dayStart', () => {
  it('reads a date as its local calendar day', () => {
    expect(dayOf(new Date(2026, 2, 4, 23, 59))).toBe('2026-03-04');
    expect(dayOf(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });

  it('round-trips a day through local midnight', () => {
    expect(dayOf(new Date(dayStart('2026-03-04')))).toBe('2026-03-04');
  });

  it('is NaN for something that is not a day', () => {
    expect(dayStart('nope')).toBeNaN();
    expect(dayStart('2026-3-4')).toBeNaN();
  });
});

describe('parseDue', () => {
  it('reads a plain day as a LOCAL day, not UTC', () => {
    // `new Date('2026-03-04')` is UTC midnight, which is 3 March in the
    // Americas. The board must never show the day before the one written.
    expect(parseDue('2026-03-04')?.day).toBe('2026-03-04');
    expect(parseDue('2026-03-04')?.hasTime).toBe(false);
  });

  it('reads a Date, keeping whether it carried a clock time', () => {
    expect(parseDue(new Date(2026, 2, 4, 17, 30))).toMatchObject({
      day: '2026-03-04',
      hasTime: true,
    });
    expect(parseDue(new Date(2026, 2, 4))).toMatchObject({ day: '2026-03-04', hasTime: false });
  });

  it('reads epoch milliseconds', () => {
    const at = new Date(2026, 2, 4, 15, 30);
    expect(parseDue(at.getTime())).toMatchObject({ day: '2026-03-04', hasTime: true });
  });

  it('reads epoch seconds, because plenty of data stores them', () => {
    const at = new Date(2026, 2, 4, 15, 30);
    const seconds = Math.round(at.getTime() / 1000);
    expect(parseDue(seconds)?.day).toBe(parseDue(at.getTime())?.day);
  });

  it('reads an ISO timestamp', () => {
    const at = new Date(2026, 2, 4, 9, 15);
    expect(parseDue(at.toISOString())).toMatchObject({ day: '2026-03-04', hasTime: true });
  });

  it('is null for nothing, and for what it cannot read', () => {
    expect(parseDue(null)).toBeNull();
    expect(parseDue(undefined)).toBeNull();
    expect(parseDue('')).toBeNull();
    expect(parseDue('   ')).toBeNull();
    expect(parseDue('next tuesday')).toBeNull();
    expect(parseDue(new Date('nope'))).toBeNull();
    expect(parseDue({})).toBeNull();
    expect(parseDue(NaN)).toBeNull();
  });

  it('reports the real day for an overflowing one', () => {
    // 30 February is 2 March; saying so beats showing a date that isn't.
    expect(parseDue('2026-02-30')?.day).toBe('2026-03-02');
  });
});

describe('dueFromDay', () => {
  it('makes a due date out of a picked day', () => {
    expect(dueFromDay('2026-03-04')).toMatchObject({ day: '2026-03-04', hasTime: false });
  });

  it('is null for nothing, or for a day it cannot read', () => {
    expect(dueFromDay(null)).toBeNull();
    expect(dueFromDay('')).toBeNull();
    expect(dueFromDay('rubbish')).toBeNull();
  });
});

describe('dueDiffDays / dueState', () => {
  const on = (day: string) => dueFromDay(day)!;

  it('counts whole days from today', () => {
    expect(dueDiffDays(on('2026-08-27'), NOW)).toBe(0);
    expect(dueDiffDays(on('2026-08-28'), NOW)).toBe(1);
    expect(dueDiffDays(on('2026-08-26'), NOW)).toBe(-1);
    expect(dueDiffDays(on('2026-09-06'), NOW)).toBe(10);
  });

  it('survives a daylight-saving boundary, where a day is 23 or 25 hours', () => {
    // Rounding rather than truncating is what keeps these exact.
    const spring = new Date(2026, 2, 8, 12).getTime();
    expect(dueDiffDays(on('2026-03-09'), spring)).toBe(1);
    expect(dueDiffDays(on('2026-03-07'), spring)).toBe(-1);
  });

  it('names how a date reads', () => {
    expect(dueState(null, NOW)).toBe('none');
    expect(dueState(on('2026-08-20'), NOW)).toBe('overdue');
    expect(dueState(on('2026-08-27'), NOW)).toBe('today');
    expect(dueState(on('2026-08-29'), NOW)).toBe('soon');
    expect(dueState(on('2026-08-30'), NOW)).toBe('soon');
    expect(dueState(on('2026-08-31'), NOW)).toBe('later');
  });

  it('takes how near "soon" is', () => {
    expect(dueState(on('2026-09-03'), NOW, 7)).toBe('soon');
    expect(dueState(on('2026-08-28'), NOW, 0)).toBe('later');
  });
});

describe('formatDue', () => {
  const on = (day: string) => dueFromDay(day)!;

  it('is relative for the days around now', () => {
    expect(formatDue(on('2026-08-27'), 'en-US', NOW)).toBe('Today');
    expect(formatDue(on('2026-08-28'), 'en-US', NOW)).toBe('Tomorrow');
    expect(formatDue(on('2026-08-26'), 'en-US', NOW)).toBe('Yesterday');
    expect(formatDue(on('2026-08-30'), 'en-US', NOW)).toBe('In 3 days');
    expect(formatDue(on('2026-08-24'), 'en-US', NOW)).toBe('3 days ago');
  });

  it('is an absolute date beyond that, with the year only when it differs', () => {
    expect(formatDue(on('2026-10-04'), 'en-US', NOW)).toBe('Oct 4');
    expect(formatDue(on('2027-01-04'), 'en-US', NOW)).toBe('Jan 4, 2027');
  });

  it('spells the whole date out for a tooltip', () => {
    expect(formatDueFull(on('2026-03-04'), 'en-US')).toBe('Wednesday, March 4, 2026');
  });
});

describe('writeDue', () => {
  it('writes a plain day by default', () => {
    expect(writeDue('2026-03-04', undefined)).toBe('2026-03-04');
    expect(writeDue('2026-03-04', '2026-01-01')).toBe('2026-03-04');
  });

  it('clears the date for no day', () => {
    expect(writeDue(null, '2026-01-01')).toBeNull();
    expect(writeDue('', '2026-01-01')).toBeNull();
    expect(writeDue('rubbish', '2026-01-01')).toBeNull();
  });

  it('keeps a Date field a Date', () => {
    const written = writeDue('2026-03-04', new Date(2026, 0, 1));
    expect(written).toBeInstanceOf(Date);
    expect(dayOf(written as Date)).toBe('2026-03-04');
  });

  it('keeps an epoch field a number, in the units it was already in', () => {
    const ms = writeDue('2026-03-04', new Date(2026, 0, 1).getTime());
    expect(typeof ms).toBe('number');
    expect(dayOf(new Date(ms as number))).toBe('2026-03-04');

    const seconds = writeDue('2026-03-04', Math.round(new Date(2026, 0, 1).getTime() / 1000));
    expect(dayOf(new Date((seconds as number) * 1000))).toBe('2026-03-04');
  });

  it('keeps the time of day a deadline already had', () => {
    const existing = new Date(2026, 0, 1, 17, 30).toISOString();
    const written = writeDue('2026-03-04', existing) as string;
    const at = new Date(written);
    expect(dayOf(at)).toBe('2026-03-04');
    expect(at.getHours()).toBe(17);
    expect(at.getMinutes()).toBe(30);
  });

  it('takes an explicit format over what was there', () => {
    expect(writeDue('2026-03-04', new Date(2026, 0, 1), 'iso')).toBe('2026-03-04');
    expect(typeof writeDue('2026-03-04', '2026-01-01', 'epoch')).toBe('number');
    expect(writeDue('2026-03-04', '2026-01-01', 'date')).toBeInstanceOf(Date);
    expect(String(writeDue('2026-03-04', '2026-01-01', 'datetime'))).toContain('T');
  });
});
