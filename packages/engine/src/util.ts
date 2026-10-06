/**
 * Rounds a variance or step to a millionth of a working day (under 0.1 s) and normalises -0. Anything smaller is
 * numerical noise from carrying forecasts forward and must never read as a real change.
 */
export const tidy = (x: number): number => Math.round(x * 1e6) / 1e6 + 0;

/** Map lookup that must succeed; a miss is a programming error, not bad input (inputs are validated first). */
export function must<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Internal error: missing key ${String(key)}`);
  return value;
}
