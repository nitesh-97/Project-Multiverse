import { useMemo } from 'react';
import type { ControlRoomView, ProjectAdvisory, WatchTask } from '@multiverse/engine';
import { api } from '../api/client';
import { useResource } from '../api/useResource';
import { ForecastTrend } from '../components/ForecastTrend';
import { BarList, Card, Empty, ErrorNote, Frame, Meter, Status, Tile } from '../components/ui';
import type { BarRow } from '../components/ui';
import { formatDate } from '../lib/dates';
import { againstClientDate, againstPlan, healthOfSpare, healthOfVariance, num, percent, plural, sentence, signed, signedDays, workingDays } from '../lib/format';
import { taskName } from '../lib/templates';
import { useProject } from '../state';

/** The management view: are we on time, what is setting the pace, and what needs attention. */
export function ControlRoomScreen() {
  const { projectId, version } = useProject();
  const room = useResource(projectId, version, (signal) => api.controlRoom(projectId, signal));
  const events = useResource(projectId, version, (signal) => api.events(projectId, signal));
  const planEdits = useResource(projectId, version, (signal) => api.planEdits(projectId, signal));

  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of events.data ?? []) map.set(e.id, e.title);
    for (const p of planEdits.data ?? []) map.set(p.id, p.title);
    return map;
  }, [events.data, planEdits.data]);

  const error = room.error ?? events.error ?? planEdits.error;
  return (
    <div className="screen">
      {error ? <ErrorNote error={error} onRetry={() => { room.reload(); events.reload(); planEdits.reload(); }} /> : null}
      {room.data ? (
        <Frame loading={room.loading}>
          <div className="screen">
            <Summary room={room.data} />
            <div className="main-side">
              <Bottleneck room={room.data} />
              <Warnings advisories={room.data.advisories} />
            </div>
            <div className="cols-2">
              <Contributors room={room.data} />
              <Trend room={room.data} titles={titles} />
            </div>
            <Modules room={room.data} />
          </div>
        </Frame>
      ) : error ? null : (
        <Card>
          <Empty title="Loading the control room" />
        </Card>
      )}
    </div>
  );
}

function Summary({ room }: { room: ControlRoomView }) {
  const planMoved = room.plan.date !== room.original.date;
  const variance = room.variance;
  return (
    <Card>
      <div className="hero">
        <div>
          <div className="secondary">Forecast delivery</div>
          <div className="figure">{formatDate(room.forecast.date, { year: true })}</div>
        </div>
        <div className="caption">
          <div>
            <Status health={healthOfVariance(variance)}>{againstPlan(variance)}</Status>
            <span className="secondary"> against the plan</span>
          </div>
          {room.target ? (
            <div>
              <Status health={healthOfSpare(room.target.daysToSpare)}>{againstClientDate(room.target.daysToSpare)}</Status>
              <span className="secondary"> ({formatDate(room.target.date)})</span>
            </div>
          ) : (
            <div className="muted">No client date has been set.</div>
          )}
        </div>
      </div>
      <div className="tiles" style={{ marginTop: 16 }}>
        <Tile label="Original plan" value={formatDate(room.original.date)} detail="When the project started" />
        {planMoved ? <Tile label="Plan now" value={formatDate(room.plan.date)} detail={`${signedDays(room.plan.offset - room.original.offset)} from planning changes`} /> : null}
        <Tile label="Against the plan" value={variance === 0 ? 'On plan' : `${signed(variance)} d`} detail={againstPlan(variance)} />
        {room.target ? (
          <Tile
            label="Against the client date"
            value={room.target.daysToSpare === 0 ? 'On the day' : room.target.daysToSpare > 0 ? `${num(room.target.daysToSpare)} d spare` : `${num(-room.target.daysToSpare)} d late`}
            detail={againstClientDate(room.target.daysToSpare)}
          />
        ) : null}
        <Tile label="Progress" value={percent(room.progress.percent)} detail={`${workingDays(room.progress.doneEffort)} of ${workingDays(room.progress.totalEffort)} of effort`}>
          <div style={{ marginTop: 8 }}>
            <Meter percent={room.progress.percent} confirmed={room.progress.confirmedPercent} label={`${room.progress.percent}% done, ${room.progress.confirmedPercent}% confirmed`} />
          </div>
          <div className="detail" style={{ marginTop: 6 }}>
            {percent(room.progress.confirmedPercent)} confirmed by someone
            {room.progress.confirmedPercent < room.progress.percent ? '; the rest is what the forecast assumes' : ''}
          </div>
        </Tile>
        <Tile label="Status date" value={room.asOf ? formatDate(room.asOf) : 'Not started'} detail="The forecast is as of the end of this day" />
      </div>
    </Card>
  );
}

function Bottleneck({ room }: { room: ControlRoomView }) {
  const { detail } = useProject();
  const teams = new Map(detail.teams.map((t) => [t.id, t.name]));
  const label = (t: WatchTask): string => taskName({ modules: detail.modules }, t);
  const { current, chain, next, watchlist } = room.bottleneck;

  if (!current) {
    return (
      <Card title="What is setting the pace">
        <Empty title="Nothing is left to do">Every task on the critical path is finished.</Empty>
      </Card>
    );
  }
  return (
    <Card title="What is setting the pace" sub="The chain of work that decides the delivery date. A day lost on any of it is a day lost on delivery.">
      <p>
        <strong>{label(current)}</strong>
        <span className="secondary">
          {' '}
          ({teams.get(current.teamId) ?? current.teamId}) is the one to watch: {current.state === 'IN_PROGRESS' ? 'under way, finishing' : 'next, finishing'} {formatDate(current.finishDate)}.
        </span>
      </p>
      <h3 style={{ margin: '14px 0 8px' }}>The critical chain, in order</h3>
      <ol className="chain" aria-label="Critical chain">
        {chain.map((t, i) => (
          <li key={t.taskId}>
            <span className={`chip${i === 0 ? ' current' : ''}`} title={`${label(t)}: ${formatDate(t.startDate)} to ${formatDate(t.finishDate)}`}>
              {label(t)}
            </span>
          </li>
        ))}
      </ol>

      <h3 style={{ margin: '18px 0 8px' }}>Likely next bottleneck</h3>
      {next ? (
        <>
          <p>
            <strong>{label(next)}</strong>
            <span className="secondary">
              {' '}
              has {workingDays(next.totalFloat)} of float. If it slips by more than that, it becomes the critical path.
            </span>
          </p>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <caption className="sr-only">Work with little float, least first</caption>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Team</th>
                  <th>Finishes</th>
                  <th className="num">Float</th>
                </tr>
              </thead>
              <tbody>
                {watchlist.map((t) => (
                  <tr key={t.taskId}>
                    <td>{label(t)}</td>
                    <td>{teams.get(t.teamId) ?? t.teamId}</td>
                    <td className="nowrap">{formatDate(t.finishDate)}</td>
                    <td className="num">{workingDays(t.totalFloat).replace(' working', '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="secondary">Nothing else is close to critical: every other task has more than two working days of float.</p>
      )}
    </Card>
  );
}

const GROUPS: Record<string, { title: string; icon: 'warning' | 'info' }> = {
  UNCONFIRMED_COMPLETION: { title: 'Finished, but nobody has confirmed it', icon: 'warning' },
  COMMON_FEATURE_WITHOUT_SHARED_TASK: { title: 'A shared feature with no shared task', icon: 'warning' },
  MODULE_STARTED_NOT_LOCKED: { title: 'Started, but not locked', icon: 'warning' },
};

function Warnings({ advisories }: { advisories: readonly ProjectAdvisory[] }) {
  const groups = useMemo(() => {
    const byRule = new Map<string, ProjectAdvisory[]>();
    for (const a of advisories) byRule.set(a.rule, [...(byRule.get(a.rule) ?? []), a]);
    return [...byRule.entries()];
  }, [advisories]);

  return (
    <Card title="Needs attention" sub="The forecast is quietly assuming these. Confirm or correct them.">
      {groups.length === 0 ? (
        <Empty title="Nothing to confirm">Everything the forecast relies on has been recorded.</Empty>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          {groups.map(([rule, items]) => {
            const g = GROUPS[rule] ?? { title: sentence(rule), icon: 'warning' as const };
            const shown = items.slice(0, 2);
            const rest = items.slice(2);
            return (
              <div key={rule}>
                <Status health={items.some((i) => i.severity === 'WARNING') ? g.icon : 'info'}>
                  {g.title} ({items.length})
                </Status>
                <ul className="plain-list" style={{ marginTop: 6 }}>
                  {shown.map((a, i) => (
                    <AdvisoryItem key={i} a={a} />
                  ))}
                </ul>
                {rest.length > 0 ? (
                  <details style={{ marginTop: 6 }}>
                    <summary className="secondary" style={{ cursor: 'pointer' }}>
                      {plural(rest.length, 'more')}
                    </summary>
                    <ul className="plain-list" style={{ marginTop: 6 }}>
                      {rest.map((a, i) => (
                        <AdvisoryItem key={i} a={a} />
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function AdvisoryItem({ a }: { a: ProjectAdvisory }) {
  return (
    <li>
      <div>{a.message}</div>
      <div className="secondary">{a.recommendation}</div>
    </li>
  );
}

function Contributors({ room }: { room: ControlRoomView }) {
  const rows: BarRow[] = room.contributors.byCategory
    .filter((c) => Math.abs(c.days) > 1e-9)
    .map((c) => ({
      key: c.category,
      label: c.category,
      value: c.days,
      text: signedDays(c.days).replace(/ working days?/, ' d'),
      negative: c.days < 0,
      title: `${c.eventIds.length} ${c.eventIds.length === 1 ? 'event' : 'events'}`,
    }));
  const total = room.contributors.totalVariance;
  return (
    <Card title="Where the delay came from" sub={total === 0 ? undefined : `${againstPlan(total)} in total, shared out in the order things happened. The retrospective shows other ways of sharing it.`}>
      {rows.length === 0 ? (
        <Empty title="No delay to explain">{total === 0 ? 'The forecast is on the plan.' : 'Changes cancelled each other out.'}</Empty>
      ) : (
        <BarList rows={rows} />
      )}
    </Card>
  );
}

function Trend({ room, titles }: { room: ControlRoomView; titles: ReadonlyMap<string, string> }) {
  const breach = room.firstBreach;
  return (
    <Card title="How the forecast has moved" sub="Working days later (up) or earlier (down) than the plan, at each re-forecast.">
      <ForecastTrend points={room.trend} titles={titles} />
      <p className="secondary" style={{ marginTop: 8 }}>
        {breach
          ? `First later than the plan after ${breach.eventId ? `“${titles.get(breach.eventId) ?? breach.eventId}”` : 'a change'}${breach.asOf ? ` on ${formatDate(breach.asOf)}` : ''}: delivery ${formatDate(breach.forecastDelivery.date)} (${signedDays(breach.variance)}).`
          : 'The forecast has never been later than the plan.'}
      </p>
    </Card>
  );
}

function Modules({ room }: { room: ControlRoomView }) {
  return (
    <Card title="Modules" sub="Progress is weighted by effort, so a ten-day task counts for ten times a one-day task.">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Module</th>
              <th style={{ minWidth: 150 }}>Progress</th>
              <th className="num">Confirmed</th>
              <th>Due</th>
              <th>Forecast</th>
              <th className="num">Against plan</th>
              <th className="num">Open tasks</th>
            </tr>
          </thead>
          <tbody>
            {room.modules.map((m) => (
              <tr key={m.moduleId}>
                <td>
                  {m.name}
                  {!m.locked ? <span className="tag" style={{ marginLeft: 6 }}>not started</span> : null}
                </td>
                <td>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(70px, 1fr) auto', gap: 8, alignItems: 'center' }}>
                    <Meter percent={m.percent} confirmed={m.confirmedPercent} label={`${m.name}: ${m.percent}% done`} />
                    <span className="num" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {percent(m.percent)}
                    </span>
                  </div>
                </td>
                <td className="num">{percent(m.confirmedPercent)}</td>
                <td className="nowrap">{m.baselineFinish ? formatDate(m.baselineFinish.date) : '—'}</td>
                <td className="nowrap">{formatDate(m.forecastFinish.date)}</td>
                <td className="num">
                  {Math.abs(m.variance) < 1e-6 ? (
                    <span className="secondary">on plan</span>
                  ) : (
                    <Status health={m.variance > 0 ? 'warning' : 'good'}>{signedDays(m.variance).replace(/ working days?/, ' d')}</Status>
                  )}
                </td>
                <td className="num">{m.openTasks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
