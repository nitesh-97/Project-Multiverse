/** Map lookup that must succeed; a miss is a programming error, not bad input (inputs are validated first). */
export function must<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Internal error: missing key ${String(key)}`);
  return value;
}
