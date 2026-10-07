import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashFor, parseHash, useRoute } from '../src/state';

describe('reading the address', () => {
  it('has a project, a tab and, on the timeline, a module', () => {
    expect(parseHash('#/thriveni/timeline/m5')).toEqual({ projectId: 'thriveni', tab: 'timeline', moduleId: 'm5' });
    expect(parseHash('#/thriveni/control-room')).toEqual({ projectId: 'thriveni', tab: 'control-room', moduleId: null });
  });

  it('opens the timeline when the tab is missing or not one we have: it comes first', () => {
    expect(parseHash('')).toEqual({ projectId: null, tab: 'timeline', moduleId: null });
    expect(parseHash('#/thriveni')).toEqual({ projectId: 'thriveni', tab: 'timeline', moduleId: null });
    expect(parseHash('#/thriveni/nonsense/m5')).toEqual({ projectId: 'thriveni', tab: 'timeline', moduleId: 'm5' });
  });

  it('has a module only on the timeline: on any other tab it means nothing', () => {
    expect(parseHash('#/thriveni/retro/m5').moduleId).toBeNull();
    expect(parseHash('#/thriveni/record/m5').moduleId).toBeNull();
  });

  it('decodes names that need it', () => {
    expect(parseHash('#/my%20project/timeline/m%205')).toEqual({ projectId: 'my project', tab: 'timeline', moduleId: 'm 5' });
  });
});

describe('writing it', () => {
  it('round-trips, and puts a module only on the timeline', () => {
    const open = { projectId: 'thriveni', tab: 'timeline', moduleId: 'm5' } as const;
    expect(hashFor(open)).toBe('#/thriveni/timeline/m5');
    expect(parseHash(hashFor(open))).toEqual(open);
    expect(hashFor({ projectId: 'thriveni', tab: 'retro', moduleId: 'm5' })).toBe('#/thriveni/retro');
    expect(hashFor({ projectId: null, tab: 'timeline', moduleId: null })).toBe('#//timeline');
  });

  it('escapes what needs it', () => {
    expect(hashFor({ projectId: 'my project', tab: 'timeline', moduleId: 'm 5' })).toBe('#/my%20project/timeline/m%205');
  });
});

describe('moving about', () => {
  beforeEach(() => {
    window.location.hash = '#/p/timeline/m5';
  });
  afterEach(() => {
    cleanup();
    window.location.hash = '';
  });

  it('leaves the module the moment another tab is chosen, not when the address catches up', () => {
    const { result } = renderHook(() => useRoute());
    expect(result.current[0]).toEqual({ projectId: 'p', tab: 'timeline', moduleId: 'm5' });
    act(() => result.current[1]({ tab: 'retro' }));
    expect(result.current[0]).toEqual({ projectId: 'p', tab: 'retro', moduleId: null });
    expect(window.location.hash).toBe('#/p/retro');
  });

  it('keeps the module when only something else changes on the timeline', () => {
    const { result } = renderHook(() => useRoute());
    act(() => result.current[1]({ projectId: 'q' }));
    expect(result.current[0]).toEqual({ projectId: 'q', tab: 'timeline', moduleId: 'm5' });
  });

  it('opens and closes a module', () => {
    window.location.hash = '#/p/timeline';
    const { result } = renderHook(() => useRoute());
    act(() => result.current[1]({ moduleId: 'm2' }));
    expect(window.location.hash).toBe('#/p/timeline/m2');
    act(() => result.current[1]({ moduleId: null }));
    expect(window.location.hash).toBe('#/p/timeline');
  });
});
