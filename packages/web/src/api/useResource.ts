import { useCallback, useEffect, useRef, useState } from 'react';

export interface Resource<T> {
  data: T | undefined;
  error: Error | null;
  /** True while a request is out, including a refresh that is keeping the old data on screen. */
  loading: boolean;
  reload: () => void;
}

/**
 * Loads something and keeps it. `scope` says what the data is about (a project): when it changes the old data is
 * dropped. `version` says "it may have changed" (something was recorded): the old data stays on screen, dimmed by the
 * caller, until the new data arrives, so the page never flashes empty or jumps.
 */
export function useResource<T>(scope: string | null, version: number, load: (signal: AbortSignal) => Promise<T>): Resource<T> {
  const [state, setState] = useState<{ scope: string | null; data: T | undefined; error: Error | null; loading: boolean }>({
    scope,
    data: undefined,
    error: null,
    loading: scope !== null,
  });
  const loadRef = useRef(load);
  loadRef.current = load;
  const [manual, setManual] = useState(0);

  useEffect(() => {
    if (scope === null) {
      setState({ scope, data: undefined, error: null, loading: false });
      return;
    }
    const controller = new AbortController();
    setState((s) => (s.scope === scope ? { ...s, loading: true, error: null } : { scope, data: undefined, error: null, loading: true }));
    loadRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ scope, data, error: null, loading: false });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState((s) => ({ scope, data: s.scope === scope ? s.data : undefined, error: error instanceof Error ? error : new Error(String(error)), loading: false }));
      },
    );
    return () => controller.abort();
  }, [scope, version, manual]);

  const reload = useCallback(() => setManual((n) => n + 1), []);
  // Never show another scope's data, even for the one render before the effect has run.
  const current = state.scope === scope;
  return { data: current ? state.data : undefined, error: current ? state.error : null, loading: current ? state.loading : scope !== null, reload };
}
