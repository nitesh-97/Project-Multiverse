import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { EventMarker, ModuleView, ProjectTimelineView } from '@multiverse/engine';
import { api } from '../api/client';
import { useResource } from '../api/useResource';
import { ChangeDetail } from '../components/ChangeDetail';
import type { EntryInfo } from '../components/ChangeDetail';
import { MilestoneFlags } from '../components/MilestoneFlags';
import { TimelineChart } from '../components/TimelineChart';
import type { EntryTitle } from '../components/TimelineChart';
import { Card, Empty, ErrorNote, Frame, Status } from '../components/ui';
import { useWidth } from '../components/useWidth';
import { formatDate } from '../lib/dates';
import { againstClientDate, againstPlan, healthOfSpare, healthOfVariance, signedDays } from '../lib/format';
import { moduleColors } from '../lib/palette';
import { phaseName } from '../lib/templates';
import { layoutModule, layoutTimeline } from '../lib/timelineLayout';
import { useProject } from '../state';

/**
 * The Multiverse view, at two levels. The project view shows the whole project: a dot for each milestone, and a branch
 * for each module that has moved. Choosing a module's start dot opens that module's own view, the same picture one
 * level down: a dot for each of its tasks, and a branch for each task that has moved.
 */
export function TimelineScreen() {
  const { moduleId } = useProject();
  return moduleId ? <ModuleTimeline key={moduleId} moduleId={moduleId} /> : <ProjectTimeline />;
}

// ---------------------------------------------------------------------------------------------------------------
// What both levels share
// ---------------------------------------------------------------------------------------------------------------

/** What each event and planning change was called, for the tooltips and the explanation. */
function useEntries(scope: string) {
  const { projectId, version } = useProject();
  const events = useResource(scope, version, (signal) => api.events(projectId, signal));
  const planEdits = useResource(scope, version, (signal) => api.planEdits(projectId, signal));
  const titles = useMemo(() => {
    const map = new Map<string, EntryTitle>();
    for (const e of events.data ?? []) map.set(e.id, { title: e.title, who: e.createdBy });
    for (const p of planEdits.data ?? []) map.set(p.id, { title: p.title, who: p.createdBy });
    return map;
  }, [events.data, planEdits.data]);
  return { events, planEdits, titles };
}

const BUTTON_STYLE = { display: 'inline-flex', alignItems: 'center', gap: 8 } as const;

// ---------------------------------------------------------------------------------------------------------------
// The project
// ---------------------------------------------------------------------------------------------------------------

function ProjectTimeline() {
  const { projectId, detail, version, today, go } = useProject();
  const timeline = useResource(projectId, version, (signal) => api.timeline(projectId, signal));
  const forecast = useResource(projectId, version, (signal) => api.forecast(projectId, signal));
  const tasks = useResource(projectId, version, (signal) => api.currentTasks(projectId, signal));
  const { events, planEdits, titles } = useEntries(projectId);

  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => setSelected(null), [projectId]);
  const [wrapRef, width] = useWidth<HTMLDivElement>(1100);

  const colors = useMemo(() => moduleColors(detail.modules), [detail.modules]);
  const moduleNames = useMemo(() => new Map(detail.modules.map((m) => [m.id, m.name])), [detail.modules]);
  const taskNames = useMemo(() => new Map((tasks.data ?? []).map((t) => [t.id, t.name])), [tasks.data]);

  const tl = timeline.data;
  const layout = useMemo(
    () =>
      tl && forecast.data
        ? layoutTimeline({
            timeline: tl,
            calendar: forecast.data.calendar ?? { startDate: detail.project.startDate, weekendDays: detail.project.weekendDays, holidays: detail.project.holidays },
            clientDate: detail.project.targetDate,
            colors,
            width,
            today,
          })
        : null,
    [tl, forecast.data, detail, colors, width, today],
  );

  const firstError = timeline.error ?? forecast.error ?? events.error ?? planEdits.error;
  const loading = timeline.loading || forecast.loading || events.loading || planEdits.loading;
  const reload = () => {
    timeline.reload();
    forecast.reload();
    events.reload();
    planEdits.reload();
  };

  return (
    <div className="screen">
      {firstError ? <ErrorNote error={firstError} onRetry={reload} /> : null}

      {tl ? <Headline timeline={tl} targetDate={detail.project.targetDate} daysToSpare={forecast.data?.target?.daysToSpare ?? null} /> : null}

      <Card
        title="Where the project is heading"
        sub="The line is the original plan, with a dot for each milestone. A branch leaves it for each module that has moved; its nodes are the changes that moved it."
      >
        <Frame loading={loading}>
          <div ref={wrapRef}>
            {layout && tl ? (
              <>
                <TimelineChart
                  layout={layout}
                  level="project"
                  names={moduleNames}
                  titles={titles}
                  selectedRevision={selected}
                  onSelect={(r) => setSelected((cur) => (cur === r ? null : r))}
                  onOpenModule={(id) => go({ moduleId: id })}
                />
                <Legend level="project" hasPlan={layout.plan !== null} hasClient={layout.client !== null} hasBranches={tl.branches.length > 0} />
                <ModuleKey colors={colors} />
                <OpenModules onOpen={(id) => go({ moduleId: id })} />
                {tl.branches.length === 0 ? (
                  <Empty title="Nothing has slipped">
                    {layout.plan
                      ? 'The forecast matches the plan. Planning has moved the plan itself away from the original (the grey diamond), which is not counted as delay.'
                      : 'The project is on its original plan. When something changes, the module it moves leaves this line as a branch.'}
                  </Empty>
                ) : null}
              </>
            ) : firstError ? null : (
              <Empty title="Loading the timeline" />
            )}
          </div>
        </Frame>
      </Card>

      {selected !== null && tl ? (
        <Selected
          key={selected}
          projectId={projectId}
          revision={selected}
          markers={tl.markers}
          titles={titles}
          events={events.data ?? []}
          moduleNames={moduleNames}
          taskNames={taskNames}
          onClose={() => setSelected(null)}
        />
      ) : null}

      {tl && tasks.data ? <MilestoneFlags flaggedTaskIds={tl.flaggedTaskIds} tasks={tasks.data} /> : null}

      {tl ? <ProjectTable timeline={tl} titles={titles} /> : null}
    </div>
  );
}

function Headline({ timeline, targetDate, daysToSpare }: { timeline: ProjectTimelineView; targetDate: string | null; daysToSpare: number | null }) {
  const { current, original } = timeline;
  const planMoved = current.planDelivery.date !== original.delivery.date;
  return (
    <div className="tiles">
      <div className="tile">
        <div className="label">Original plan</div>
        <div className="value">{formatDate(original.delivery.date)}</div>
        <div className="detail">As planned when the project started</div>
      </div>
      {planMoved ? (
        <div className="tile">
          <div className="label">Plan now</div>
          <div className="value">{formatDate(current.planDelivery.date)}</div>
          <div className="detail">After {signedDays(current.planDelivery.offset - original.delivery.offset)} of planning changes</div>
        </div>
      ) : null}
      <div className="tile">
        <div className="label">Forecast</div>
        <div className="value">{formatDate(current.delivery.date)}</div>
        <div className="detail">
          <Status health={healthOfVariance(current.variance)}>{againstPlan(current.variance)}</Status>
        </div>
      </div>
      {targetDate && daysToSpare !== null ? (
        <div className="tile">
          <div className="label">Client date</div>
          <div className="value">{formatDate(targetDate)}</div>
          <div className="detail">
            <Status health={healthOfSpare(daysToSpare)}>{againstClientDate(daysToSpare)}</Status>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The colour of each module, which is what a coloured dot or branch means. */
function ModuleKey({ colors }: { colors: ReadonlyMap<string, string> }) {
  const { detail } = useProject();
  const modules = detail.modules.filter((m) => m.kind !== 'PROJECT');
  return (
    <div className="legend" aria-label="Module colours">
      {modules.map((m) => (
        <span key={m.id} className="legend-item">
          <span className="key-dot" style={{ background: colors.get(m.id) }} /> {m.name}
        </span>
      ))}
    </div>
  );
}

/** The same thing as clicking a module's start dot, for anyone who cannot or would rather not aim at a dot. */
function OpenModules({ onOpen }: { onOpen: (moduleId: string) => void }) {
  const { detail } = useProject();
  return (
    <div className="legend" style={{ alignItems: 'center' }}>
      <span className="secondary">Open a module's own timeline:</span>
      {detail.modules.map((m) => (
        <button key={m.id} type="button" className="button small" onClick={() => onOpen(m.id)}>
          {m.name}
        </button>
      ))}
    </div>
  );
}

function Legend({ level, hasPlan, hasClient, hasBranches }: { level: 'project' | 'module'; hasPlan: boolean; hasClient: boolean; hasBranches: boolean }) {
  return (
    <div className="legend" aria-label="Legend">
      <span className="legend-item">
        <span className="key-line" style={{ borderTopColor: 'var(--ink-2)' }} /> Original plan
      </span>
      {level === 'project' ? (
        <>
          <span className="legend-item">
            <span className="key-dot" style={{ background: 'var(--series-1)' }} /> A module starts (click to open it)
          </span>
          <span className="legend-item">
            <span className="key-dot" style={{ background: 'var(--surface)', border: '2.5px solid var(--series-1)' }} /> A module finishes (solid once done)
          </span>
          <span className="legend-item">
            <span className="key-diamond" style={{ background: 'var(--ink-2)' }} /> A flagged milestone
          </span>
        </>
      ) : (
        <>
          <span className="legend-item">
            <span className="key-dot" style={{ background: 'var(--surface)', border: '2.5px solid var(--ink-2)' }} /> A task finishes (solid once done)
          </span>
          <span className="legend-item">
            <span className="key-diamond" style={{ background: 'var(--ink-2)' }} /> A milestone
          </span>
        </>
      )}
      {hasBranches ? (
        <span className="legend-item">
          <span className="key-dot" style={{ background: 'var(--ink)' }} /> Branch node: a change that moved it (hollow: float absorbed it)
        </span>
      ) : null}
      <span className="legend-item">
        <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">
          <circle r="5" fill="var(--ink)" />
        </svg>
        Event
        <svg width="14" height="14" viewBox="-8 -8 16 16" aria-hidden="true">
          <path d="M 0 -7 l 7 7 l -7 7 l -7 -7 z" fill="var(--ink)" />
        </svg>
        Planning change
        <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">
          <path d="M -5 -5 l 10 10 M 5 -5 l -10 10" stroke="var(--ink)" strokeWidth="2.25" strokeLinecap="round" />
        </svg>
        Withdrawn
      </span>
      <span className="legend-item">Hollow marker: no schedule effect</span>
      <span className="legend-item">
        <span className="key-band" /> Weekend or holiday
      </span>
      <span className="legend-item">
        <span className="key-dot" style={{ background: 'var(--good)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--good) 25%, transparent)' }} /> We are here (today)
      </span>
      <span className="legend-item">
        <span className="key-line" style={{ borderTopColor: 'var(--accent)' }} /> Status date: when the forecast was last re-worked
      </span>
      {hasClient ? (
        <span className="legend-item">
          <span className="key-line" style={{ borderTopColor: 'var(--ink)' }} /> Client date
        </span>
      ) : null}
      {hasPlan ? (
        <span className="legend-item">
          <span className="key-diamond" style={{ background: 'var(--muted)' }} /> Plan now
        </span>
      ) : null}
    </div>
  );
}

function Selected({
  projectId,
  revision,
  markers,
  titles,
  events,
  moduleNames,
  taskNames,
  onClose,
}: {
  projectId: string;
  revision: number;
  markers: readonly EventMarker[];
  titles: ReadonlyMap<string, EntryTitle>;
  events: ReadonlyArray<{ id: string; type: string; phase: string; createdBy: string; description: string; couldHaveBeenEarlier?: boolean }>;
  moduleNames: ReadonlyMap<string, string>;
  taskNames: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const { detail } = useProject();
  const phases = detail.project.phases;
  const snap = useResource(`${projectId}:${revision}`, 0, (signal) => api.snapshot(projectId, revision, signal));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (snap.data) ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [snap.data]);

  const marker = markers.find((m) => m.revision === revision);
  const event = marker ? events.find((e) => e.id === marker.eventId) : undefined;
  const entry: EntryInfo | undefined = marker
    ? {
        title: marker.kind === 'VOID' ? `Withdrawn: ${titles.get(marker.eventId)?.title ?? marker.eventId}` : (titles.get(marker.eventId)?.title ?? marker.eventId),
        kind: marker.kind,
        ...(titles.get(marker.eventId)?.who ? { by: titles.get(marker.eventId)?.who } : {}),
        ...(event && marker.kind === 'EVENT' ? { type: event.type, phase: phaseName(phases, event.phase), description: event.description, couldHaveBeenEarlier: event.couldHaveBeenEarlier === true } : {}),
      }
    : undefined;

  return (
    <div ref={ref}>
      {snap.error ? <ErrorNote error={snap.error} onRetry={snap.reload} /> : null}
      {snap.data?.explanation ? (
        <ChangeDetail explanation={snap.data.explanation} entry={entry} moduleNames={moduleNames} taskNames={taskNames} onClose={onClose} />
      ) : snap.loading ? (
        <Card>
          <Empty title="Loading the explanation" />
        </Card>
      ) : null}
    </div>
  );
}

function TableCard({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <Card
      title="As a table"
      actions={
        <button type="button" className="button small" aria-expanded={open} onClick={onToggle}>
          {open ? 'Hide table' : 'Show table'}
        </button>
      }
    >
      {open ? <div style={{ display: 'grid', gap: 16 }}>{children}</div> : <p className="secondary">Every dot, every branch and every recorded change, without the drawing.</p>}
    </Card>
  );
}

function ChangesTable({ markers, titles }: { markers: readonly EventMarker[]; titles: ReadonlyMap<string, EntryTitle> }) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Recorded changes, oldest first</caption>
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Date</th>
            <th>Kind</th>
            <th>What</th>
            <th className="num">Effort</th>
            <th className="num">Delivery</th>
          </tr>
        </thead>
        <tbody>
          {markers.map((m) => (
            <tr key={m.revision}>
              <td className="num">{m.revision}</td>
              <td className="nowrap">{formatDate(m.asOf)}</td>
              <td>{m.kind === 'EVENT' ? 'Event' : m.kind === 'PLAN' ? 'Planning change' : 'Withdrawn'}</td>
              <td>{titles.get(m.eventId)?.title ?? m.eventId}</td>
              <td className="num">{signedDays(m.effortImpact)}</td>
              <td className="num">{m.noScheduleEffect ? 'no effect' : signedDays(m.stepDays)}</td>
            </tr>
          ))}
          {markers.length === 0 ? (
            <tr>
              <td colSpan={6} className="muted">
                Nothing has been recorded yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

/** The same picture as a table, for anyone who cannot or would rather not read the chart. */
function ProjectTable({ timeline, titles }: { timeline: ProjectTimelineView; titles: ReadonlyMap<string, EntryTitle> }) {
  const [open, setOpen] = useState(false);
  return (
    <TableCard open={open} onToggle={() => setOpen((o) => !o)}>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Milestones: where each was planned, and where it is now forecast</caption>
          <thead>
            <tr>
              <th>Milestone</th>
              <th>Planned</th>
              <th>Forecast</th>
              <th className="num">Against plan</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {timeline.milestones.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td className="nowrap">{m.original ? formatDate(m.original.date) : 'added later'}</td>
                <td className="nowrap">{formatDate(m.forecast.date)}</td>
                <td className="num">{signedDays(m.variance)}</td>
                <td>{m.reached ? (m.kind === 'MODULE_START' ? 'Started' : 'Done') : 'Not yet'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Branches: modules that have moved away from the original plan</caption>
          <thead>
            <tr>
              <th>Module</th>
              <th>Was due</th>
              <th>Now due</th>
              <th className="num">Against plan</th>
              <th>Status</th>
              <th className="num">Changes</th>
            </tr>
          </thead>
          <tbody>
            {timeline.branches.map((b) => (
              <tr key={b.moduleId}>
                <td>{b.isDelivery ? 'Delivery' : b.moduleName}</td>
                <td className="nowrap">{b.baselineFinish ? formatDate(b.baselineFinish.date) : '—'}</td>
                <td className="nowrap">{formatDate(b.currentFinish.date)}</td>
                <td className="num">{signedDays(b.currentDelta)}</td>
                <td>{b.status === 'MERGED' ? 'Back on its original date' : 'Open'}</td>
                <td className="num">{b.steps.length}</td>
              </tr>
            ))}
            {timeline.branches.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No module has moved away from the plan.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <ChangesTable markers={timeline.markers} titles={titles} />
    </TableCard>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// One module
// ---------------------------------------------------------------------------------------------------------------

function ModuleTimeline({ moduleId }: { moduleId: string }) {
  const { projectId, detail, version, today, go } = useProject();
  const scope = `${projectId}:${moduleId}`;
  const view = useResource(scope, version, (signal) => api.moduleTimeline(projectId, moduleId, signal));
  const forecast = useResource(projectId, version, (signal) => api.forecast(projectId, signal));
  const tasks = useResource(projectId, version, (signal) => api.currentTasks(projectId, signal));
  const { events, planEdits, titles } = useEntries(projectId);

  const [selected, setSelected] = useState<number | null>(null);
  const [wrapRef, width] = useWidth<HTMLDivElement>(1100);
  const colors = useMemo(() => moduleColors(detail.modules), [detail.modules]);
  const moduleNames = useMemo(() => new Map(detail.modules.map((m) => [m.id, m.name])), [detail.modules]);
  const taskNames = useMemo(() => new Map((tasks.data ?? []).map((t) => [t.id, t.name])), [tasks.data]);

  const v = view.data;
  const layout = useMemo(
    () =>
      v && forecast.data
        ? layoutModule({
            view: v,
            calendar: forecast.data.calendar ?? { startDate: detail.project.startDate, weekendDays: detail.project.weekendDays, holidays: detail.project.holidays },
            color: colors.get(moduleId) ?? 'var(--ink)',
            width,
            today,
          })
        : null,
    [v, forecast.data, detail, colors, moduleId, width, today],
  );

  const error = view.error ?? forecast.error ?? events.error ?? planEdits.error;
  const loading = view.loading || forecast.loading || events.loading || planEdits.loading;
  const module = detail.modules.find((m) => m.id === moduleId);

  return (
    <div className="screen">
      <nav aria-label="Where you are" className="legend" style={{ marginTop: 0, alignItems: 'center' }}>
        <button type="button" className="button small" style={BUTTON_STYLE} onClick={() => go({ moduleId: null })}>
          {'←'} Back to the project
        </button>
        <span className="secondary">Project</span>
        <span aria-hidden="true">{'›'}</span>
        <strong aria-current="page">{v?.name ?? module?.name ?? moduleId}</strong>
      </nav>

      {error ? (
        <ErrorNote
          error={error}
          onRetry={() => {
            view.reload();
            forecast.reload();
          }}
        />
      ) : null}

      {v ? <ModuleHeadline view={v} /> : null}

      <Card title={v ? `${v.name}: where it is heading` : 'Loading the module'} sub="The line is this module's original plan, with a dot for each task. A branch leaves it for each task that has moved.">
        <Frame loading={loading}>
          <div ref={wrapRef}>
            {layout && v ? (
              <>
                <TimelineChart
                  layout={layout}
                  level="module"
                  names={taskNames}
                  titles={titles}
                  selectedRevision={selected}
                  onSelect={(r) => setSelected((cur) => (cur === r ? null : r))}
                />
                <Legend level="module" hasPlan={layout.plan !== null} hasClient={false} hasBranches={v.branches.length > 0} />
                {v.branches.length === 0 ? <Empty title="Nothing in this module has slipped">Every task is where the plan put it. When one moves, it leaves this line as a branch.</Empty> : null}
              </>
            ) : error ? null : (
              <Empty title="Loading the module" />
            )}
          </div>
        </Frame>
      </Card>

      {selected !== null && v ? (
        <Selected
          key={selected}
          projectId={projectId}
          revision={selected}
          markers={v.markers}
          titles={titles}
          events={events.data ?? []}
          moduleNames={moduleNames}
          taskNames={taskNames}
          onClose={() => setSelected(null)}
        />
      ) : null}

      {v ? <ModuleTable view={v} titles={titles} /> : null}
    </div>
  );
}

function ModuleHeadline({ view }: { view: ModuleView }) {
  const done = view.dots.filter((d) => d.state === 'DONE').length;
  const { current, original } = view;
  return (
    <div className="tiles">
      <div className="tile">
        <div className="label">Planned to finish</div>
        <div className="value">{original.finish ? formatDate(original.finish.date) : '—'}</div>
        <div className="detail">In the original plan</div>
      </div>
      <div className="tile">
        <div className="label">Forecast to finish</div>
        <div className="value">{formatDate(current.finish.date)}</div>
        <div className="detail">
          <Status health={healthOfVariance(current.variance)}>{againstPlan(current.variance)}</Status>
        </div>
      </div>
      <div className="tile">
        <div className="label">Tasks done</div>
        <div className="value">
          {done} of {view.dots.length}
        </div>
        <div className="detail">Milestones count as tasks</div>
      </div>
    </div>
  );
}

function ModuleTable({ view, titles }: { view: ModuleView; titles: ReadonlyMap<string, EntryTitle> }) {
  const [open, setOpen] = useState(false);
  return (
    <TableCard open={open} onToggle={() => setOpen((o) => !o)}>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Tasks of {view.name}: where each was planned, and where it is now forecast</caption>
          <thead>
            <tr>
              <th>Task</th>
              <th>Planned finish</th>
              <th>Forecast finish</th>
              <th className="num">Against plan</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {view.dots.map((d) => (
              <tr key={d.taskId}>
                <td>
                  {d.name}
                  {d.critical ? (
                    <span className="tag" style={{ marginLeft: 6 }}>
                      critical
                    </span>
                  ) : null}
                </td>
                <td className="nowrap">{d.original ? formatDate(d.original.date) : 'added later'}</td>
                <td className="nowrap">{formatDate(d.forecast.date)}</td>
                <td className="num">{signedDays(d.variance)}</td>
                <td>{d.state === 'DONE' ? 'Done' : d.state === 'IN_PROGRESS' ? 'Under way' : 'Not started'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ChangesTable markers={view.markers} titles={titles} />
    </TableCard>
  );
}
