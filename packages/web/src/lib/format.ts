/** Plain-language numbers. Working days throughout: that is the unit the engine works in. */

const MINUS = '−';
const EPS = 1e-6;

/** A day count without float noise: 1, 1.5, 0.25. */
export function num(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
}

/** "1 working day", "3 working days", "1.5 working days". */
export function workingDays(n: number): string {
  return `${num(Math.abs(n))} working ${Math.abs(Math.abs(n) - 1) < EPS ? 'day' : 'days'}`;
}

/** "+3", "−2", "0". */
export function signed(n: number): string {
  const r = Math.round(n * 100) / 100;
  if (Math.abs(r) < EPS) return '0';
  return r > 0 ? `+${num(r)}` : `${MINUS}${num(-r)}`;
}

/** "+3 working days", "−1 working day", "0 working days". */
export function signedDays(n: number): string {
  return `${signed(n)} working ${Math.abs(Math.abs(n) - 1) < EPS ? 'day' : 'days'}`;
}

/** Variance against the plan: positive is late. */
export function againstPlan(variance: number): string {
  if (Math.abs(variance) < EPS) return 'On plan';
  return variance > 0 ? `${workingDays(variance)} late` : `${workingDays(variance)} early`;
}

/** Days to spare against the client's date: positive is to spare, negative is late. */
export function againstClientDate(daysToSpare: number): string {
  if (Math.abs(daysToSpare) < EPS) return 'Exactly on the client date';
  return daysToSpare > 0 ? `${workingDays(daysToSpare)} to spare` : `${workingDays(daysToSpare)} past the client date`;
}

export type Health = 'good' | 'warning' | 'critical';

/** How worried to be about a delay in working days. Late is never "good"; a little late is a warning. */
export function healthOfVariance(variance: number): Health {
  if (variance <= EPS) return 'good';
  return variance <= 2 + EPS ? 'warning' : 'critical';
}

export function healthOfSpare(daysToSpare: number): Health {
  if (daysToSpare >= -EPS) return 'good';
  return daysToSpare >= -2 - EPS ? 'warning' : 'critical';
}

export const percent = (n: number): string => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;

/** "EVENT_NAME" -> "Event name". */
export function sentence(constant: string): string {
  const s = constant.toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
