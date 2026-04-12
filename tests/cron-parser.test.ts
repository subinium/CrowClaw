import { describe, it, expect } from 'vitest';
import {
  parseCron,
  cronMatches,
  nextCronOccurrence,
  prevCronOccurrence,
  formatCron,
  describeCron,
} from '../packages/scheduler/src/cron-parser.js';

// ---------------------------------------------------------------------------
// parseCron
// ---------------------------------------------------------------------------

describe('parseCron', () => {
  it('parses wildcard expression (* * * * *)', () => {
    const cron = parseCron('* * * * *');
    expect(cron.minutes).toHaveLength(60);
    expect(cron.hours).toHaveLength(24);
    expect(cron.daysOfMonth).toHaveLength(31);
    expect(cron.months).toHaveLength(12);
    expect(cron.daysOfWeek).toHaveLength(7);
  });

  it('parses specific values (0 9 * * *)', () => {
    const cron = parseCron('0 9 * * *');
    expect(cron.minutes).toEqual([0]);
    expect(cron.hours).toEqual([9]);
    expect(cron.daysOfMonth).toHaveLength(31);
    expect(cron.months).toHaveLength(12);
    expect(cron.daysOfWeek).toHaveLength(7);
  });

  it('parses step expression (*/5 * * * *)', () => {
    const cron = parseCron('*/5 * * * *');
    expect(cron.minutes).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  it('parses range expression (1-5 * * * *)', () => {
    const cron = parseCron('1-5 * * * *');
    expect(cron.minutes).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses list expression (1,3,5 * * * *)', () => {
    const cron = parseCron('1,3,5 * * * *');
    expect(cron.minutes).toEqual([1, 3, 5]);
  });

  it('parses range with step (0 */2 * * *)', () => {
    const cron = parseCron('0 */2 * * *');
    expect(cron.minutes).toEqual([0]);
    expect(cron.hours).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
  });

  it('parses step on explicit range (1-10/2 * * * *)', () => {
    const cron = parseCron('1-10/2 * * * *');
    expect(cron.minutes).toEqual([1, 3, 5, 7, 9]);
  });

  it('parses complex expression (30 9 1,15 * 1-5)', () => {
    const cron = parseCron('30 9 1,15 * 1-5');
    expect(cron.minutes).toEqual([30]);
    expect(cron.hours).toEqual([9]);
    expect(cron.daysOfMonth).toEqual([1, 15]);
    expect(cron.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  // Aliases

  it('parses @hourly', () => {
    const cron = parseCron('@hourly');
    expect(cron.minutes).toEqual([0]);
    expect(cron.hours).toHaveLength(24);
  });

  it('parses @daily', () => {
    const cron = parseCron('@daily');
    expect(cron.minutes).toEqual([0]);
    expect(cron.hours).toEqual([0]);
    expect(cron.daysOfMonth).toHaveLength(31);
    expect(cron.months).toHaveLength(12);
    expect(cron.daysOfWeek).toHaveLength(7);
  });

  it('parses @weekly', () => {
    const cron = parseCron('@weekly');
    expect(cron.daysOfWeek).toEqual([0]);
  });

  it('parses @monthly', () => {
    const cron = parseCron('@monthly');
    expect(cron.daysOfMonth).toEqual([1]);
    expect(cron.hours).toEqual([0]);
    expect(cron.minutes).toEqual([0]);
  });

  it('parses @yearly', () => {
    const cron = parseCron('@yearly');
    expect(cron.months).toEqual([1]);
    expect(cron.daysOfMonth).toEqual([1]);
    expect(cron.hours).toEqual([0]);
    expect(cron.minutes).toEqual([0]);
  });

  it('is case-insensitive for aliases', () => {
    const cron = parseCron('@DAILY');
    expect(cron.minutes).toEqual([0]);
    expect(cron.hours).toEqual([0]);
  });

  // Invalid expressions

  it('throws on too few fields', () => {
    expect(() => parseCron('* * *')).toThrow('expected 5 fields');
  });

  it('throws on too many fields', () => {
    expect(() => parseCron('* * * * * *')).toThrow('expected 5 fields');
  });

  it('throws on out-of-range values', () => {
    expect(() => parseCron('60 * * * *')).toThrow('out of range');
  });

  it('throws on invalid range', () => {
    expect(() => parseCron('5-2 * * * *')).toThrow('Invalid range');
  });

  it('throws on non-numeric value', () => {
    expect(() => parseCron('abc * * * *')).toThrow('Invalid cron field value');
  });

  it('throws on empty expression', () => {
    expect(() => parseCron('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// cronMatches
// ---------------------------------------------------------------------------

describe('cronMatches', () => {
  it('matches every minute', () => {
    const cron = parseCron('* * * * *');
    expect(cronMatches(cron, new Date('2026-04-13T10:30:00'))).toBe(true);
  });

  it('matches specific time (0 9 * * *) at 9:00', () => {
    const cron = parseCron('0 9 * * *');
    expect(cronMatches(cron, new Date('2026-04-13T09:00:00'))).toBe(true);
  });

  it('does not match (0 9 * * *) at 10:00', () => {
    const cron = parseCron('0 9 * * *');
    expect(cronMatches(cron, new Date('2026-04-13T10:00:00'))).toBe(false);
  });

  it('does not match (0 9 * * *) at 9:01', () => {
    const cron = parseCron('0 9 * * *');
    expect(cronMatches(cron, new Date('2026-04-13T09:01:00'))).toBe(false);
  });

  it('matches every 5 minutes at minute 15', () => {
    const cron = parseCron('*/5 * * * *');
    expect(cronMatches(cron, new Date('2026-04-13T10:15:00'))).toBe(true);
  });

  it('does not match every 5 minutes at minute 13', () => {
    const cron = parseCron('*/5 * * * *');
    expect(cronMatches(cron, new Date('2026-04-13T10:13:00'))).toBe(false);
  });

  it('matches specific day of week (0 9 * * 1) on Monday', () => {
    // 2026-04-13 is a Monday
    const cron = parseCron('0 9 * * 1');
    expect(cronMatches(cron, new Date('2026-04-13T09:00:00'))).toBe(true);
  });

  it('does not match specific day of week (0 9 * * 1) on Tuesday', () => {
    // 2026-04-14 is a Tuesday
    const cron = parseCron('0 9 * * 1');
    expect(cronMatches(cron, new Date('2026-04-14T09:00:00'))).toBe(false);
  });

  it('matches first of month (0 0 1 * *)', () => {
    const cron = parseCron('0 0 1 * *');
    // 2026-05-01 is a Friday (day 5)
    expect(cronMatches(cron, new Date('2026-05-01T00:00:00'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// nextCronOccurrence
// ---------------------------------------------------------------------------

describe('nextCronOccurrence', () => {
  it('finds next 9:00 AM from 8:00 AM same day', () => {
    const cron = parseCron('0 9 * * *');
    const after = new Date('2026-04-13T08:00:00');
    const next = nextCronOccurrence(cron, after);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(13); // same day
  });

  it('finds next 9:00 AM from 10:00 AM → next day', () => {
    const cron = parseCron('0 9 * * *');
    const after = new Date('2026-04-13T10:00:00');
    const next = nextCronOccurrence(cron, after);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(14); // next day
  });

  it('finds first of next month for (0 0 1 * *)', () => {
    const cron = parseCron('0 0 1 * *');
    const after = new Date('2026-04-13T10:00:00');
    const next = nextCronOccurrence(cron, after);
    expect(next.getMonth()).toBe(4); // May (0-indexed)
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(0);
    expect(next.getMinutes()).toBe(0);
  });

  it('finds next occurrence for */5 * * * *', () => {
    const cron = parseCron('*/5 * * * *');
    const after = new Date('2026-04-13T10:03:00');
    const next = nextCronOccurrence(cron, after);
    expect(next.getMinutes()).toBe(5);
    expect(next.getHours()).toBe(10);
  });

  it('advances past current minute', () => {
    const cron = parseCron('0 9 * * *');
    // Exactly at 9:00 — next should be tomorrow at 9:00
    const after = new Date('2026-04-13T09:00:00');
    const next = nextCronOccurrence(cron, after);
    expect(next.getDate()).toBe(14);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it('handles @weekly correctly', () => {
    const cron = parseCron('@weekly');
    // 2026-04-13 is Monday — @weekly is Sunday at 00:00
    const after = new Date('2026-04-13T10:00:00');
    const next = nextCronOccurrence(cron, after);
    expect(next.getDay()).toBe(0); // Sunday
    expect(next.getHours()).toBe(0);
    expect(next.getMinutes()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// prevCronOccurrence
// ---------------------------------------------------------------------------

describe('prevCronOccurrence', () => {
  it('finds previous 9:00 AM from 10:00 AM same day', () => {
    const cron = parseCron('0 9 * * *');
    const before = new Date('2026-04-13T10:00:00');
    const prev = prevCronOccurrence(cron, before);
    expect(prev.getHours()).toBe(9);
    expect(prev.getMinutes()).toBe(0);
    expect(prev.getDate()).toBe(13); // same day
  });

  it('finds previous 9:00 AM from 8:00 AM → yesterday', () => {
    const cron = parseCron('0 9 * * *');
    const before = new Date('2026-04-13T08:00:00');
    const prev = prevCronOccurrence(cron, before);
    expect(prev.getHours()).toBe(9);
    expect(prev.getDate()).toBe(12); // previous day
  });
});

// ---------------------------------------------------------------------------
// formatCron
// ---------------------------------------------------------------------------

describe('formatCron', () => {
  it('formats wildcard expression', () => {
    const cron = parseCron('* * * * *');
    expect(formatCron(cron)).toBe('* * * * *');
  });

  it('formats specific time', () => {
    const cron = parseCron('0 9 * * *');
    expect(formatCron(cron)).toBe('0 9 * * *');
  });

  it('formats step pattern', () => {
    const cron = parseCron('*/5 * * * *');
    expect(formatCron(cron)).toBe('*/5 * * * *');
  });

  it('formats ranges', () => {
    const cron = parseCron('1-5 * * * *');
    expect(formatCron(cron)).toBe('1-5 * * * *');
  });

  it('formats lists', () => {
    const cron = parseCron('1,3,5 * * * *');
    expect(formatCron(cron)).toBe('1,3,5 * * * *');
  });

  it('roundtrips @daily', () => {
    const cron = parseCron('@daily');
    expect(formatCron(cron)).toBe('0 0 * * *');
  });
});

// ---------------------------------------------------------------------------
// describeCron
// ---------------------------------------------------------------------------

describe('describeCron', () => {
  it('describes every minute', () => {
    const desc = describeCron(parseCron('* * * * *'));
    expect(desc).toContain('every minute');
    expect(desc).toContain('every hour');
  });

  it('describes daily at 9:00', () => {
    const desc = describeCron(parseCron('0 9 * * *'));
    expect(desc).toContain('minute 0');
    expect(desc).toContain('9:00 AM');
  });

  it('describes weekday schedule', () => {
    const desc = describeCron(parseCron('30 9 * * 1-5'));
    expect(desc).toContain('Monday');
    expect(desc).toContain('Friday');
  });

  it('describes monthly schedule', () => {
    const desc = describeCron(parseCron('0 0 1 * *'));
    expect(desc).toContain('day 1');
  });

  it('describes yearly schedule', () => {
    const desc = describeCron(parseCron('@yearly'));
    expect(desc).toContain('January');
    expect(desc).toContain('day 1');
  });
});
