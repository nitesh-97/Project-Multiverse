import { describe, expect, it } from 'vitest';
import { PlanError, topologicalOrder } from '../src';

describe('topologicalOrder', () => {
  it('orders a chain', () => {
    expect(topologicalOrder(['c', 'b', 'a'], [['a', 'b'], ['b', 'c']])).toEqual(['a', 'b', 'c']);
  });

  it('keeps input order when nothing constrains it', () => {
    expect(topologicalOrder(['b', 'a'], [])).toEqual(['b', 'a']);
  });

  it('breaks ties by input order', () => {
    expect(topologicalOrder(['a', 'b', 'c', 'd'], [['a', 'c'], ['b', 'c'], ['c', 'd']])).toEqual(['a', 'b', 'c', 'd']);
    // y and z are ready first; x waits for z.
    expect(topologicalOrder(['x', 'y', 'z'], [['z', 'x']])).toEqual(['y', 'z', 'x']);
  });

  it('accepts duplicate edges', () => {
    expect(topologicalOrder(['a', 'b'], [['a', 'b'], ['a', 'b']])).toEqual(['a', 'b']);
  });

  it('rejects cycles and self-dependencies', () => {
    expect(() => topologicalOrder(['a', 'b'], [['a', 'b'], ['b', 'a']])).toThrow(PlanError);
    expect(() => topologicalOrder(['a', 'b'], [['a', 'b'], ['b', 'a']])).toThrow(/cycle/i);
    expect(() => topologicalOrder(['a'], [['a', 'a']])).toThrow(/cycle/i);
  });

  it('rejects unknown ids', () => {
    expect(() => topologicalOrder(['a'], [['a', 'ghost']])).toThrow(/unknown ids: ghost/);
  });
});
