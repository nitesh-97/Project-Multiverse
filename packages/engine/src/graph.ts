import { PlanError } from './errors';

/**
 * Topological order of `ids` given `edges` of [predecessor, successor].
 * Deterministic: among nodes that are ready at the same time, the one that appears first in `ids` goes first.
 * Throws PlanError on unknown ids or cycles (a self-edge is a cycle).
 */
export function topologicalOrder(ids: readonly string[], edges: ReadonlyArray<readonly [string, string]>): string[] {
  const index = new Map<string, number>();
  ids.forEach((id, i) => index.set(id, i));

  const unknown = new Set<string>();
  const successors = new Map<string, string[]>();
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));

  for (const [from, to] of edges) {
    if (!index.has(from)) unknown.add(from);
    if (!index.has(to)) unknown.add(to);
    if (!index.has(from) || !index.has(to)) continue;
    (successors.get(from) ?? successors.set(from, []).get(from)!).push(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }
  if (unknown.size > 0) throw new PlanError(`Dependency refers to unknown ids: ${[...unknown].join(', ')}`);

  const byIndex = (a: string, b: string) => (index.get(a) as number) - (index.get(b) as number);
  const ready = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift() as string;
    order.push(id);
    for (const next of successors.get(id) ?? []) {
      const left = (indegree.get(next) as number) - 1;
      indegree.set(next, left);
      if (left === 0) ready.push(next);
    }
    ready.sort(byIndex);
  }

  if (order.length < ids.length) {
    const stuck = ids.filter((id) => (indegree.get(id) as number) > 0);
    throw new PlanError(`Dependency cycle involving: ${stuck.join(', ')}`);
  }
  return order;
}
