import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api/client';
import { useResource } from './api/useResource';
import { Card, Empty, ErrorNote } from './components/ui';
import { ControlRoomScreen } from './screens/ControlRoomScreen';
import { RecordScreen } from './screens/RecordScreen';
import { RetroScreen } from './screens/RetroScreen';
import { TimelineScreen } from './screens/TimelineScreen';
import { ProjectProvider, TABS, remember, remembered, todayISO, useRoute, useTheme } from './state';
import type { ProjectContextValue, TabId, Theme } from './state';

function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M3 16h26" fill="none" stroke="var(--ink-2)" strokeWidth="3" strokeLinecap="round" />
      <path d="M9 16c6 0 5-9 12-9h8" fill="none" stroke="var(--series-1)" strokeWidth="3" strokeLinecap="round" />
      <path d="M9 16c6 0 5 9 12 9h8" fill="none" stroke="var(--series-2)" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** `today` is a parameter so a test, or a demo, can pin the date forms start on. */
export function App({ today = todayISO() }: { today?: string }) {
  const [route, go] = useRoute();
  const [theme, setTheme] = useTheme();
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const [recordingAs, setRecordingAsState] = useState(() => remembered('mv.name') ?? 'PM');
  const setRecordingAs = useCallback((name: string) => {
    setRecordingAsState(name);
    remember('mv.name', name);
  }, []);

  const projects = useResource('projects', version, (signal) => api.projects(signal));
  const list = projects.data;

  // Open the project in the address, or the one used last, or the first.
  const projectId = useMemo(() => {
    if (!list || list.length === 0) return null;
    const wanted = route.projectId ?? remembered('mv.project');
    return list.find((p) => p.id === wanted)?.id ?? (list[0]?.id as string);
  }, [list, route.projectId]);

  useEffect(() => {
    if (projectId && projectId !== route.projectId) go({ projectId });
    if (projectId) remember('mv.project', projectId);
  }, [projectId, route.projectId, go]);

  const detail = useResource(projectId, version, (signal) => api.project(projectId as string, signal));

  const value: ProjectContextValue | null = useMemo(
    () => (projectId && detail.data ? { projectId, detail: detail.data, version, refresh, moduleId: route.moduleId, today, recordingAs, setRecordingAs, go } : null),
    [projectId, detail.data, version, refresh, route.moduleId, today, recordingAs, setRecordingAs, go],
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <Logo />
          <div>
            Project Multiverse
            <small>See how your project got here, and where it is going</small>
          </div>
        </div>
        <div className="header-spacer" />
        <div className="header-tools">
          {list && list.length > 0 ? (
            <label className="field-inline">
              Project
              <select value={projectId ?? ''} onChange={(e) => go({ projectId: e.target.value, moduleId: null })} aria-label="Project">
                {list.map((p) => (
                  <option key={p.id} value={p.id}>
                    {list.filter((q) => q.name === p.name).length > 1 ? `${p.name} (${p.id})` : p.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="field-inline">
            Recording as
            <input type="text" value={recordingAs} onChange={(e) => setRecordingAs(e.target.value)} size={12} aria-label="Your name, for the record" />
          </label>
          <label className="field-inline">
            Theme
            <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)} aria-label="Theme">
              <option value="auto">Match system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>
      </header>

      <nav className="tabs" role="tablist" aria-label="Views">
        {TABS.map((t) => (
          <button key={t.id} id={`tab-${t.id}`} type="button" role="tab" className="tab" aria-selected={route.tab === t.id} aria-controls="view" onClick={() => go({ tab: t.id })}>
            {t.label}
          </button>
        ))}
      </nav>

      <main id="view" role="tabpanel" aria-labelledby={`tab-${route.tab}`}>
        {projects.error ? <ErrorNote error={projects.error} onRetry={projects.reload} /> : null}
        {detail.error ? <ErrorNote error={detail.error} onRetry={detail.reload} /> : null}
        {projects.data && projects.data.length === 0 ? (
          <Card>
            <Empty title="There are no projects yet">
              Create one through the API, or load the Thriveni example with <code>npm run seed -w @multiverse/server</code>.
            </Empty>
          </Card>
        ) : null}
        {value ? (
          <ProjectProvider value={value}>
            <Screen tab={route.tab} started={value.detail.started} go={go} />
          </ProjectProvider>
        ) : projects.error || detail.error || (projects.data && projects.data.length === 0) ? null : (
          <Card>
            <Empty title="Loading" />
          </Card>
        )}
      </main>
    </div>
  );
}

function Screen({ tab, started, go }: { tab: TabId; started: boolean; go: (next: { tab: TabId }) => void }) {
  if (tab === 'record') return <RecordScreen />;
  if (!started) {
    return (
      <Card>
        <Empty title="This project has not started yet">
          <p>The timeline, control room and retrospective need a forecast, and the forecast begins when the first module is started.</p>
          <p style={{ marginTop: 12 }}>
            <button type="button" className="button primary" onClick={() => go({ tab: 'record' })}>
              Go to Record a change
            </button>
          </p>
        </Empty>
      </Card>
    );
  }
  if (tab === 'control-room') return <ControlRoomScreen />;
  if (tab === 'retro') return <RetroScreen />;
  return <TimelineScreen />;
}
