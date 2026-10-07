import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, formatDate, formatLongDate, formatShortDate, isWorkingDay, weekday } from '../src/lib/dates';
import {
  againstClientDate,
  againstPlan,
  healthOfSpare,
  healthOfVariance,
  num,
  percent,
  plural,
  sentence,
  signed,
  signedDays,
  workingDays,
} from '../src/lib/format';
import { moduleColors } from '../src/lib/palette';

describe('dates', () => {
  it('counts calendar days across month ends and leap years', () => {
    expect(daysBetween('2026-10-30', '2026-11-02')).toBe(3);
    expect(daysBetween('2026-11-02', '2026-10-30')).toBe(-3);
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDays('2028-02-28', 2)).toBe('2028-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('knows the weekday, in the engine convention (0 = Sunday)', () => {
    expect(weekday('2026-10-05')).toBe(1);
    expect(weekday('2026-10-04')).toBe(0);
    expect(weekday('2026-10-10')).toBe(6);
  });

  it('formats dates the way people say them', () => {
    expect(formatDate('2026-10-14')).toBe('Wed 14 Oct');
    expect(formatDate('2026-10-14', { year: true })).toBe('Wed 14 Oct 2026');
    expect(formatLongDate('2026-11-02')).toBe('Monday 2 November 2026');
    expect(formatShortDate('2026-10-05')).toBe('5 Oct');
  });

  it('tells working days from weekends and holidays', () => {
    const cal = { weekendDays: [0, 6], holidays: ['2026-10-28'] };
    expect(isWorkingDay('2026-10-27', cal)).toBe(true);
    expect(isWorkingDay('2026-10-28', cal)).toBe(false);
    expect(isWorkingDay('2026-10-31', cal)).toBe(false);
  });
});

describe('plain-language numbers', () => {
  it('writes day counts with the right singular and plural', () => {
    expect(workingDays(1)).toBe('1 working day');
    expect(workingDays(3)).toBe('3 working days');
    expect(workingDays(1.5)).toBe('1.5 working days');
    expect(workingDays(-2)).toBe('2 working days');
    expect(workingDays(0)).toBe('0 working days');
  });

  it('signs them with a real minus and drops float noise', () => {
    expect(signed(3)).toBe('+3');
    expect(signed(-2)).toBe('−2');
    expect(signed(0)).toBe('0');
    expect(signed(0.1 + 0.2)).toBe('+0.3');
    expect(signed(-1e-9)).toBe('0');
    expect(signedDays(1)).toBe('+1 working day');
    expect(signedDays(-1)).toBe('−1 working day');
    expect(signedDays(2)).toBe('+2 working days');
    expect(num(-0)).toBe('0');
  });

  it('says how far off plan and off the client date', () => {
    expect(againstPlan(0)).toBe('On plan');
    expect(againstPlan(1)).toBe('1 working day late');
    expect(againstPlan(-2)).toBe('2 working days early');
    expect(againstClientDate(0)).toBe('Exactly on the client date');
    expect(againstClientDate(3)).toBe('3 working days to spare');
    expect(againstClientDate(-1)).toBe('1 working day past the client date');
  });

  it('grades how worried to be, never calling a delay good', () => {
    expect(healthOfVariance(0)).toBe('good');
    expect(healthOfVariance(-3)).toBe('good');
    expect(healthOfVariance(1)).toBe('warning');
    expect(healthOfVariance(2)).toBe('warning');
    expect(healthOfVariance(2.5)).toBe('critical');
    expect(healthOfSpare(0)).toBe('good');
    expect(healthOfSpare(-1)).toBe('warning');
    expect(healthOfSpare(-3)).toBe('critical');
  });

  it('formats the small things', () => {
    expect(percent(70.1)).toBe('70.1%');
    expect(percent(100)).toBe('100%');
    expect(sentence('UNCONFIRMED_COMPLETION')).toBe('Unconfirmed completion');
    expect(plural(1, 'event')).toBe('1 event');
    expect(plural(2, 'event')).toBe('2 events');
  });
});

describe('module colours', () => {
  const modules = [
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `m${n}`, kind: 'DELIVERABLE' as const })),
    { id: 'shared', kind: 'SHARED' as const },
    { id: 'project', kind: 'PROJECT' as const },
  ];

  it('gives each module its own slot, in plan order, and the delivery module ink', () => {
    const c = moduleColors(modules);
    expect(c.get('m1')).toBe('var(--series-1)');
    expect(c.get('m5')).toBe('var(--series-5)');
    expect(c.get('shared')).toBe('var(--series-8)');
    expect(c.get('project')).toBe('var(--ink)');
  });

  it('keeps a module on its colour whatever else is on screen', () => {
    // The colour comes from the module's place in the plan, not from which modules happen to have deviated.
    expect(moduleColors(modules.slice(0, 5)).get('m5')).toBe('var(--series-5)');
    expect(moduleColors(modules).get('m5')).toBe('var(--series-5)');
  });

  it('never invents a ninth hue', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ id: `x${i}`, kind: 'DELIVERABLE' as const }));
    const c = moduleColors(many);
    expect(c.get('x7')).toBe('var(--series-8)');
    expect(c.get('x8')).toBe('var(--series-other)');
    expect(c.get('x10')).toBe('var(--series-other)');
  });
});
