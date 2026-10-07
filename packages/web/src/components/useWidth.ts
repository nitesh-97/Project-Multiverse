import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/** The width of an element, kept up to date as the window or the layout changes. */
export function useWidth<T extends HTMLElement>(initial = 800): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const first = el.getBoundingClientRect().width;
    if (first > 0) setWidth(Math.floor(first));
    const watch = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? 0;
      if (w > 0) setWidth(Math.floor(w));
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return [ref, width];
}
