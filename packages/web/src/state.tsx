import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ProjectDetail } from '@multiverse/engine';

export const TABS = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'control-room', label: 'Control room' },
  { id: 'retro', label: 'Retrospective' },
  { id: 'record', label: 'Record a change' },
] as const;
export type TabId = (typeof TABS)[number]['id'];

export interface Route {
  projectId: string | null;
  tab: TabId;
  /** On the timeline: the module whose own timeline is open. Null is the project view. */
  moduleId: string | null;
}

/** `#/thriveni/control-room`, or `#/thriveni/timeline/m5` for a module's own timeline. An empty or unknown tab means the timeline: it comes first. */
export function parseHash(hash: string): Route {
  const [, projectId, tab, moduleId] = hash.replace(/^#/, '').split('/');
  const known = TABS.find((t) => t.id === tab)?.id ?? 'timeline';
  return {
    projectId: projectId ? decodeURIComponent(projectId) : null,
    tab: known,
    moduleId: known === 'timeline' && moduleId ? decodeURIComponent(moduleId) : null,
  };
}

export const hashFor = (route: Route): string =>
  `#/${route.projectId ? encodeURIComponent(route.projectId) : ''}/${route.tab}${route.tab === 'timeline' && route.moduleId ? `/${encodeURIComponent(route.moduleId)}` : ''}`;

export function useRoute(): [Route, (next: Partial<Route>) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const go = useCallback(
    (next: Partial<Route>) => {
      const merged = { ...route, ...next };
      // Only the timeline has a module open: any other tab is the whole project.
      if (merged.tab !== 'timeline') merged.moduleId = null;
      if (hashFor(merged) !== window.location.hash) window.location.hash = hashFor(merged);
      setRoute(merged);
    },
    [route],
  );
  return [route, go];
}

// ---------------------------------------------------------------------------------------------------------------
// Things worth remembering between visits. All of it is a convenience, so a browser that will not store it is fine.
// ---------------------------------------------------------------------------------------------------------------

export function remembered(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not stored; nothing depends on it.
  }
}

export type Theme = 'auto' | 'light' | 'dark';

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = remembered('mv.theme');
    return saved === 'light' || saved === 'dark' ? saved : 'auto';
  });
  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    remember('mv.theme', theme);
  }, [theme]);
  return [theme, setTheme];
}

// ---------------------------------------------------------------------------------------------------------------
// The open project
// ---------------------------------------------------------------------------------------------------------------

export interface ProjectContextValue {
  projectId: string;
  detail: ProjectDetail;
  /** Goes up whenever something was recorded; screens reload when it changes. */
  version: number;
  /** Something changed on the server (an event was recorded, a module locked): everything on screen refreshes. */
  refresh: () => void;
  /** On the timeline: the module whose own timeline is open, or null for the project view. */
  moduleId: string | null;
  /** Today, as the date forms start on. */
  today: string;
  recordingAs: string;
  setRecordingAs: (name: string) => void;
  go: (next: Partial<Route>) => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ value, children }: { value: ProjectContextValue; children: ReactNode }) {
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used inside a ProjectProvider');
  return ctx;
}

/** Today's date as `YYYY-MM-DD`, in the viewer's own calendar. */
export function todayISO(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
