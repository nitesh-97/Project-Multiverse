import { useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import type { EventMarker } from '@multiverse/engine';
import { formatDate } from '../lib/dates';
import { signedDays } from '../lib/format';
import type { DotLayout, LaneLayout, StepLayout, TimelineLayout } from '../lib/timelineLayout';
import { useTooltip } from './ui';

export interface EntryTitle {
  title: string;
  who?: string;
}

export interface TimelineChartProps {
  layout: TimelineLayout;
  /** The project, or one module: what the picture is of. */
  level: 'project' | 'module';
  /** Names of the things branches are about (modules or tasks), by id, for "moved because of ...". */
  names: ReadonlyMap<string, string>;
  /** What each event or planning change was called, by id. */
  titles: ReadonlyMap<string, EntryTitle>;
  selectedRevision: number | null;
  onSelect: (revision: number) => void;
  /** Called when a module-start dot is chosen: show that module's own timeline. */
  onOpenModule?: (moduleId: string) => void;
}

const KIND_LABEL = { EVENT: 'Event', PLAN: 'Planning change', VOID: 'Event withdrawn' } as const;

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Space and Enter act like a click on anything drawn as a button. */
const onKey = (act: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    act();
  }
};

const SURFACE = 'var(--surface)';

export function TimelineChart({ layout, level, names, titles, selectedRevision, onSelect, onOpenModule }: TimelineChartProps) {
  const tooltip = useTooltip();
  const [hoverX, setHoverX] = useState<number | null>(null);
  const nameOf = (id: string): string => names.get(id) ?? id;
  const entryTitle = (id: string): string => titles.get(id)?.title ?? id;
  const thing = level === 'project' ? 'module' : 'task';

  const hover = (x: number, content: ReactNode) => (e: PointerEvent<SVGElement>) => {
    tooltip.show(e, content);
    setHoverX(x);
  };
  const focus = (x: number, content: ReactNode) => (e: { currentTarget: SVGElement }) => {
    const r = e.currentTarget.getBoundingClientRect();
    tooltip.show({ clientX: r.left + r.width / 2, clientY: r.top }, content);
    setHoverX(x);
  };
  const leave = () => {
    tooltip.hide();
    setHoverX(null);
  };

  const top = layout.markerY - 16;
  const stepTip = (lane: LaneLayout, s: StepLayout): ReactNode => {
    const step = s.step;
    return (
      <>
        <div className="t-title">{entryTitle(step.eventId)}</div>
        <div className="t-line">
          {lane.isDelivery ? 'Delivery' : lane.name}: <span className="t-value">{step.added ? 'new work' : signedDays(step.delta)}</span>
        </div>
        <div className="t-line">Now finishes {formatDate(step.finishAfter.date)}</div>
        <div className="t-line">
          {step.origin === 'DIRECT' ? 'Changed directly' : `Moved because of ${step.fromIds.length > 0 ? step.fromIds.map(nameOf).join(', ') : 'an earlier step'}`}
        </div>
        {step.absorbed ? <div className="t-line">Float absorbed it: delivery did not move</div> : null}
        {step.onCriticalPath && !step.absorbed ? <div className="t-line">On the critical path</div> : null}
        <div className="t-line muted">
          {KIND_LABEL[step.kind]} · {formatDate(step.asOf)}
        </div>
      </>
    );
  };

  const markerTip = (m: EventMarker): ReactNode => (
    <>
      <div className="t-title">{m.kind === 'VOID' ? `Withdrawn: ${entryTitle(m.eventId)}` : entryTitle(m.eventId)}</div>
      <div className="t-line">
        {KIND_LABEL[m.kind]} · {formatDate(m.asOf)}
      </div>
      {m.kind === 'PLAN' && m.baselineStepDays !== 0 ? (
        <div className="t-line">
          The plan moved <span className="t-value">{signedDays(m.baselineStepDays)}</span> (planning, not delay)
        </div>
      ) : null}
      {m.noScheduleEffect ? (
        m.baselineStepDays === 0 ? <div className="t-line">No schedule effect</div> : null
      ) : (
        <div className="t-line">
          {m.modulesMoved} {m.modulesMoved === 1 ? 'module' : 'modules'} moved{m.stepDays !== 0 ? `, delivery ${signedDays(m.stepDays)}` : ', delivery did not'}
        </div>
      )}
      {m.effortImpact !== 0 ? <div className="t-line">Effort {signedDays(m.effortImpact)}</div> : null}
      {m.absorbed ? <div className="t-line">Float absorbed the slip</div> : null}
    </>
  );

  const hereTip: ReactNode = layout.here ? (
    <>
      <div className="t-title">We are here</div>
      <div className="t-line">
        Today, <span className="t-value">{formatDate(layout.here.date)}</span>
      </div>
      {layout.status ? <div className="t-line">The forecast was last re-worked at the end of {formatDate(layout.status.date)}</div> : <div className="t-line">Nothing has been recorded yet</div>}
    </>
  ) : null;

  const endTip = (lane: LaneLayout): ReactNode => (
    <>
      <div className="t-title">{lane.isDelivery ? 'Delivery' : lane.name}</div>
      <div className="t-line">
        Forecast finish <span className="t-value">{formatDate(lane.forecast.date)}</span>
      </div>
      {lane.planned ? <div className="t-line">Was due {formatDate(lane.planned.date)}</div> : null}
      <div className="t-line">{lane.status === 'MERGED' ? 'Back on its original date' : lane.planned ? signedDays(lane.currentDelta) : 'New work'}</div>
    </>
  );

  const dotTip = (d: DotLayout): ReactNode => {
    const { data } = d;
    const starts = d.shape === 'start';
    const moved = Math.abs(data.variance) > 1e-6;
    return (
      <>
        <div className="t-title">{data.name}</div>
        {data.original ? (
          <div className="t-line">
            {starts ? 'Planned to start' : 'Planned for'} <span className="t-value">{formatDate(data.original.date)}</span>
          </div>
        ) : (
          <div className="t-line">Added after the project started</div>
        )}
        {data.plan && data.original && data.plan.date !== data.original.date ? <div className="t-line">The plan now has it on {formatDate(data.plan.date)}</div> : null}
        <div className="t-line">
          Forecast <span className="t-value">{formatDate(data.forecast.date)}</span>
          {moved ? ` (${signedDays(data.variance)})` : data.plan ? ' (on plan)' : ''}
        </div>
        {data.critical ? <div className="t-line">On the critical path</div> : null}
        {data.notes.map((n) => (
          <div key={n} className="t-line">
            {n}
          </div>
        ))}
        {d.opens ? <div className="t-line muted">Click to open this module's own timeline</div> : null}
      </>
    );
  };

  /** One dot: its shape says what it is, its colour which module, solid or hollow whether it has been reached. */
  const dotMark = (d: DotLayout): ReactNode => {
    const { x, y, color, shape, reached } = d;
    const fill = reached ? color : SURFACE;
    switch (shape) {
      case 'start':
        return (
          <>
            <circle cx={x} cy={y} r={6.5} fill={color} className="ring" />
            {reached ? <circle cx={x} cy={y} r={2} fill={SURFACE} /> : null}
          </>
        );
      case 'delivery':
        return <circle cx={x} cy={y} r={7} fill="var(--ink)" className="ring" />;
      case 'milestone':
      case 'taskMilestone':
        return <path d={`M ${x} ${y - 7.5} l 7.5 7.5 l -7.5 7.5 l -7.5 -7.5 z`} fill={fill} stroke={color} strokeWidth={2} strokeLinejoin="round" />;
      case 'finish':
      case 'task':
        return <circle cx={x} cy={y} r={5.5} fill={fill} stroke={color} strokeWidth={2.5} />;
    }
  };

  return (
    <div className="chart-frame">
      <svg
        className="chart"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="group"
        aria-label={
          level === 'project'
            ? 'Multiverse timeline of the project: the original plan with a dot for each milestone, and one branch for each module that has deviated'
            : 'Multiverse timeline of one module: the original plan with a dot for each task, and one branch for each task that has deviated'
        }
        onPointerLeave={leave}
      >
        {/* Weekends and holidays sit behind everything. */}
        <g aria-hidden="true">
          {layout.weekends.map((b) => (
            <rect key={`w${b.date}`} className="weekend" x={b.x} y={top} width={b.width} height={layout.axisY - top} />
          ))}
          {layout.holidays.map((b) => (
            <g key={`h${b.date}`}>
              <rect className="holiday" x={b.x} y={top} width={b.width} height={layout.axisY - top} />
              <title>Holiday {formatDate(b.date)}</title>
            </g>
          ))}
          {layout.ticks.map((t) => (
            <line key={`g${t.date}`} className="grid-line" x1={t.x} x2={t.x} y1={top} y2={layout.axisY} />
          ))}
        </g>

        {/* The time axis. */}
        <g aria-hidden="true">
          <line className="axis-line" x1={layout.left} x2={layout.right} y1={layout.axisY} y2={layout.axisY} />
          {layout.ticks.map((t) => (
            <g key={`t${t.date}`}>
              <line className="axis-line" x1={t.x} x2={t.x} y1={layout.axisY} y2={layout.axisY + 5} />
              <text x={t.x} y={layout.axisY + 20} textAnchor="middle" className="faint">
                {t.label}
              </text>
            </g>
          ))}
        </g>

        {/* Row names in the left gutter. */}
        <text x={12} y={layout.markerY + 4} className="strong">
          Recorded changes
        </text>
        <text x={12} y={layout.originalY + 4} className="strong">
          Original plan
        </text>

        {/* Status and client date. */}
        {layout.status ? (
          <g>
            <line className="status-line" x1={layout.status.x} x2={layout.status.x} y1={top} y2={layout.axisY} />
            <text x={layout.status.x} y={top - 4} textAnchor="middle">
              Status date
            </text>
          </g>
        ) : null}
        {layout.client ? (
          <g>
            <line className="client-line" x1={layout.client.x} x2={layout.client.x} y1={top} y2={layout.axisY} />
            <text x={layout.client.x} y={top - 4} textAnchor="middle">
              Client date
            </text>
          </g>
        ) : null}

        {layout.here ? (
          <g
            role="img"
            tabIndex={0}
            aria-label={`We are here: ${formatDate(layout.here.date)}`}
            onPointerMove={hover(layout.here.x, hereTip)}
            onFocus={focus(layout.here.x, hereTip)}
            onBlur={leave}
          >
            <circle className="here-pulse" cx={layout.here.x} cy={layout.here.y} r={7} fill="var(--good)" />
            <circle cx={layout.here.x} cy={layout.here.y} r={11} fill="var(--good)" opacity={0.22} />
            <circle cx={layout.here.x} cy={layout.here.y} r={6.5} fill="var(--good)" className="ring" />
            <circle cx={layout.here.x} cy={layout.here.y} r={14} className="hit" />
            <text x={layout.here.x + 14} y={layout.here.y + 20} className="strong">
              We are here
            </text>
          </g>
        ) : null}

        {hoverX !== null ? <line className="crosshair" x1={hoverX} x2={hoverX} y1={top} y2={layout.axisY} /> : null}

        {/* The original line: what was planned, which never changes. */}
        <g>
          <line className="original-line" x1={layout.original.x0} x2={layout.original.x1} y1={layout.originalY} y2={layout.originalY} />
          {layout.plan ? (
            <g>
              <line className="plan-extension" x1={layout.original.x1} x2={layout.plan.x} y1={layout.originalY} y2={layout.originalY} />
              <path d={`M ${layout.plan.x} ${layout.originalY - 7} l 7 7 l -7 7 l -7 -7 z`} className="hollow ring" style={{ stroke: 'var(--muted)', strokeWidth: 2 }} />
              <text x={layout.plan.x} y={layout.originalY + 26} textAnchor="middle">
                Plan now {formatDate(layout.plan.date)}
              </text>
            </g>
          ) : null}
        </g>

        {/* The dots on it. */}
        {layout.dots.map((d) => {
          const open = d.opens && onOpenModule ? () => onOpenModule(d.opens as string) : null;
          const tip = dotTip(d);
          return (
            <g key={d.key} data-dot={d.key}>
              {d.added ? <circle cx={d.x} cy={d.y} r={10} fill="none" stroke="var(--muted)" strokeWidth={1.25} /> : null}
              {dotMark(d)}
              {d.labelled && d.label ? (
                <text x={d.x} y={d.y - 14} textAnchor="middle" className={d.shape === 'delivery' ? 'strong' : undefined}>
                  {d.shape === 'delivery' ? d.label : short(d.label, 14)}
                </text>
              ) : null}
              <circle
                cx={d.x}
                cy={d.y}
                r={d.slot === 0 ? 11 : 8}
                className="hit"
                tabIndex={0}
                role={open ? 'button' : 'img'}
                aria-label={open ? `${d.data.name}. Open this ${thing}'s timeline` : `${d.data.name}, forecast ${formatDate(d.data.forecast.date)}`}
                onPointerMove={hover(d.x, tip)}
                onFocus={focus(d.x, tip)}
                onBlur={leave}
                {...(open ? { onClick: open, onKeyDown: onKey(open) } : {})}
                style={open ? { cursor: 'pointer' } : { cursor: 'default' }}
              />
            </g>
          );
        })}

        {/* One branch for each thing that has moved from its plan. */}
        {layout.lanes.map((lane) => (
          <g key={lane.id}>
            <line className="grid-line" x1={layout.left} x2={layout.right} y1={lane.y} y2={lane.y} />
            <line x1={12} x2={30} y1={lane.y} y2={lane.y} stroke={lane.color} strokeWidth={lane.isDelivery ? 3 : 2} strokeLinecap="round" />
            <text x={36} y={lane.y + 4} className="lane-name">
              {lane.isDelivery ? 'Delivery forecast' : short(lane.name, 17)}
            </text>
            <path className={`lane-line${lane.isDelivery ? ' delivery' : ''}`} d={lane.path} stroke={lane.color} />
            {lane.mergePath ? <path className="lane-line" d={lane.mergePath} stroke={lane.color} /> : null}

            {lane.planned ? <circle cx={lane.planned.x} cy={lane.y} r={5} className="hollow" stroke={lane.color} strokeWidth={2} /> : null}
            {lane.slip ? (
              <g aria-hidden="true">
                <path
                  d={`M ${lane.slip.x0} ${lane.slip.y - 4} v 8 M ${lane.slip.x0} ${lane.slip.y} H ${lane.slip.x1} M ${lane.slip.x1} ${lane.slip.y - 4} v 8`}
                  fill="none"
                  stroke="var(--ink-2)"
                  strokeWidth={1}
                />
                <text x={(lane.slip.x0 + lane.slip.x1) / 2} y={lane.slip.y + 16} textAnchor="middle">
                  {lane.slip.label}
                </text>
              </g>
            ) : null}

            {/* Forecast finish. */}
            <circle
              cx={lane.endX}
              cy={lane.y}
              r={5}
              fill={lane.color}
              className="ring"
              tabIndex={0}
              role="img"
              aria-label={`${lane.isDelivery ? 'Delivery' : lane.name} forecast to finish ${formatDate(lane.forecast.date)}`}
              onPointerMove={hover(lane.endX, endTip(lane))}
              onFocus={focus(lane.endX, endTip(lane))}
              onBlur={leave}
            />
            <text x={lane.endLabel.x} y={lane.endLabel.y + 4} className="strong">
              {lane.endLabel.text}
            </text>

            {/* One node for each time something moved it. */}
            {lane.steps.map((s) => {
              const selected = selectedRevision === s.step.revision;
              const tip = stepTip(lane, s);
              const act = () => onSelect(s.step.revision);
              return (
                <g key={s.step.revision}>
                  {s.labelled ? (
                    <text x={s.x + 9} y={s.y - 9}>
                      {s.label}
                    </text>
                  ) : null}
                  <circle
                    cx={s.x}
                    cy={s.y}
                    r={5}
                    className={`ring${s.step.absorbed ? ' hollow' : ''}${selected ? ' selected' : ''}`}
                    fill={s.step.absorbed ? undefined : lane.color}
                    stroke={s.step.absorbed ? lane.color : undefined}
                    strokeWidth={s.step.absorbed ? 2 : undefined}
                    style={selected ? { stroke: 'var(--ink)', strokeWidth: 2.5 } : undefined}
                  />
                  <circle
                    cx={s.x}
                    cy={s.y}
                    r={13}
                    className="hit"
                    tabIndex={0}
                    role="button"
                    aria-label={`${entryTitle(s.step.eventId)}: ${lane.isDelivery ? 'delivery' : lane.name} ${s.step.added ? 'added' : signedDays(s.step.delta)}. Show details`}
                    onPointerMove={hover(s.x, tip)}
                    onFocus={focus(s.x, tip)}
                    onBlur={leave}
                    onClick={act}
                    onKeyDown={onKey(act)}
                  />
                </g>
              );
            })}
          </g>
        ))}

        {/* Everything that was recorded, whether or not it moved anything. */}
        {layout.markers.map((m) => (
          <MarkerGlyph
            key={m.marker.revision}
            m={m}
            selected={selectedRevision === m.marker.revision}
            title={entryTitle(m.marker.eventId)}
            tip={markerTip(m.marker)}
            onSelect={() => onSelect(m.marker.revision)}
            hover={hover}
            focus={focus}
            leave={leave}
          />
        ))}
      </svg>
      {tooltip.node}
    </div>
  );
}

interface MarkerGlyphProps {
  m: { x: number; y: number; marker: EventMarker };
  selected: boolean;
  title: string;
  tip: ReactNode;
  onSelect: () => void;
  hover: (x: number, c: ReactNode) => (e: PointerEvent<SVGElement>) => void;
  focus: (x: number, c: ReactNode) => (e: { currentTarget: SVGElement }) => void;
  leave: () => void;
}

/**
 * Circle = event, diamond = planning change, cross = withdrawn event. Solid when it moved the schedule or the plan,
 * hollow when it did not, so the shape and the fill each say something and colour is not needed.
 */
function MarkerGlyph({ m, selected, title, tip, onSelect, hover, focus, leave }: MarkerGlyphProps) {
  const { x, y, marker } = m;
  const solid = !marker.noScheduleEffect || marker.baselineStepDays !== 0;
  const stroke = 'var(--ink)';
  const fill = solid ? 'var(--ink)' : 'var(--surface)';
  return (
    <g>
      {marker.kind === 'EVENT' ? (
        <circle cx={x} cy={y} r={5.5} fill={fill} stroke={stroke} strokeWidth={selected ? 3 : 1.75} />
      ) : marker.kind === 'PLAN' ? (
        <path d={`M ${x} ${y - 7} l 7 7 l -7 7 l -7 -7 z`} fill={fill} stroke={stroke} strokeWidth={selected ? 3 : 1.75} strokeLinejoin="round" />
      ) : (
        <path d={`M ${x - 5} ${y - 5} l 10 10 M ${x + 5} ${y - 5} l -10 10`} stroke={stroke} strokeWidth={selected ? 3.5 : 2.25} strokeLinecap="round" />
      )}
      <circle
        cx={x}
        cy={y}
        r={12}
        className="hit"
        tabIndex={0}
        role="button"
        aria-label={`${KIND_LABEL[marker.kind]}: ${title}. Show details`}
        onPointerMove={hover(x, tip)}
        onFocus={focus(x, tip)}
        onBlur={leave}
        onClick={onSelect}
        onKeyDown={onKey(onSelect)}
      />
    </g>
  );
}
