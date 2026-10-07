import { useMemo } from 'react';
import type { Attribution, PhaseModel, PhaseShare, RetroView } from '@multiverse/engine';
import { api } from '../api/client';
import { useResource } from '../api/useResource';
import { BarList, Card, Empty, ErrorNote, Frame, Status, Tile } from '../components/ui';
import type { BarRow } from '../components/ui';
import { formatDate } from '../lib/dates';
import { againstClientDate, againstPlan, healthOfSpare, healthOfVariance, num, percent, plural, signedDays, workingDays } from '../lib/format';
import { phaseName } from '../lib/templates';
import { useProject } from '../state';

/** The evidence-based retrospective: what was planned, what happened, and what the project can learn from it. */
export function RetroScreen() {
  const { projectId, version, detail } = useProject();
  const retro = useResource(projectId, version, (signal) => api.retro(projectId, signal));
  const events = useResource(projectId, version, (signal) => api.events(projectId, signal));
  const planEdits = useResource(projectId, version, (signal) => api.planEdits(projectId, signal));

  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of events.data ?? []) map.set(e.id, e.title);
    for (const p of planEdits.data ?? []) map.set(p.id, p.title);
    return map;
  }, [events.data, planEdits.data]);
  const teams = useMemo(() => new Map(detail.teams.map((t) => [t.id, t.name])), [detail.teams]);

  const error = retro.error ?? events.error ?? planEdits.error;
  const r = retro.data;
  return (
    <div className="screen">
      {error ? <ErrorNote error={error} onRetry={() => { retro.reload(); events.reload(); planEdits.reload(); }} /> : null}
      {r ? (
        <Frame loading={retro.loading}>
          <div className="screen">
            <Outcome r={r} />
            <Contributors r={r} titles={titles} />
            <div className="cols-2">
              <Feedback r={r} teams={teams} phases={detail.project.phases} />
              <Observations r={r} />
            </div>
            <Changes r={r} />
            <Ownership r={r} titles={titles} />
          </div>
        </Frame>
      ) : error ? null : (
        <Card>
          <Empty title="Loading the retrospective" />
        </Card>
      )}
    </div>
  );
}

function Outcome({ r }: { r: RetroView }) {
  const delivered = r.status === 'DELIVERED';
  return (
    <Card
      title="Planned against actual"
      sub={delivered ? 'The project has been delivered: these figures are what happened.' : 'The project is still under way: these figures are the current forecast, and will change.'}
    >
      <div className="tiles">
        <Tile label="Planned delivery" value={formatDate(r.planned.delivery.date)} detail={`${workingDays(r.planned.workingDays)} after the start`} />
        <Tile label={delivered ? 'Delivered' : 'Forecast delivery'} value={formatDate(r.outcome.delivery.date)} detail={`${workingDays(r.outcome.workingDays)} after the start`} />
        <Tile label="Against the plan" value={r.outcome.variance === 0 ? 'On plan' : `${signedDays(r.outcome.variance).replace(/ working days?/, ' d')}`} detail={<Status health={healthOfVariance(r.outcome.variance)}>{againstPlan(r.outcome.variance)}</Status>} />
        {r.target ? (
          <Tile label="Against the client date" value={formatDate(r.target.date)} detail={<Status health={healthOfSpare(r.target.daysToSpare)}>{againstClientDate(r.target.daysToSpare)}</Status>} />
        ) : null}
      </div>
    </Card>
  );
}

function Contributors({ r, titles }: { r: RetroView; titles: ReadonlyMap<string, string> }) {
  const { sequential, counterfactual } = r.contributors;
  return (
    <Card title="Where the delay came from" sub="Several changes can overlap, so there is no single right way to share the delay out. Here are two.">
      <div className="cols-2">
        <Strategy
          title="In the order it happened"
          how="Each change is charged for the delay it added at the moment it arrived. The shares always add up to the total."
          a={sequential}
          titles={titles}
        />
        <Strategy
          title="Each change on its own"
          how="Each change is charged for the delay it would have caused if it were the only one. What is left over is delay that only appears when changes combine."
          a={counterfactual}
          titles={titles}
        />
      </div>
    </Card>
  );
}

function Strategy({ title, how, a, titles }: { title: string; how: string; a: Attribution; titles: ReadonlyMap<string, string> }) {
  const rows: BarRow[] = a.byCategory
    .filter((c) => Math.abs(c.days) > 1e-9)
    .map((c) => ({ key: c.category, label: c.category, value: c.days, text: signedDays(c.days).replace(/ working days?/, ' d'), negative: c.days < 0, title: `${plural(c.eventIds.length, 'change')}` }));
  if (Math.abs(a.interaction) > 1e-9) {
    rows.push({ key: '__interaction', label: 'Only in combination', value: a.interaction, text: signedDays(a.interaction).replace(/ working days?/, ' d'), quiet: true, negative: a.interaction < 0, title: 'Delay no single change accounts for' });
  }
  return (
    <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
      <div>
        <h3 style={{ color: 'var(--ink)' }}>{title}</h3>
        <p className="secondary">{how}</p>
      </div>
      {rows.length === 0 ? <p className="secondary">No delay to share out ({againstPlan(a.totalVariance)}).</p> : <BarList rows={rows} />}
      {a.contributions.length > 0 ? (
        <details>
          <summary className="secondary" style={{ cursor: 'pointer' }}>
            {plural(a.contributions.length, 'change')}, one by one
          </summary>
          <div className="table-wrap" style={{ marginTop: 6 }}>
            <table>
              <thead>
                <tr>
                  <th>Change</th>
                  <th>Counted as</th>
                  <th className="num">Delay</th>
                  <th className="num">Effort</th>
                </tr>
              </thead>
              <tbody>
                {a.contributions.map((c) => (
                  <tr key={c.eventId}>
                    <td>{titles.get(c.eventId) ?? c.eventId}</td>
                    <td>{c.category}</td>
                    <td className="num">{signedDays(c.days).replace(/ working days?/, ' d')}</td>
                    <td className="num">{signedDays(c.effortDays).replace(/ working days?/, ' d')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function Feedback({ r, teams, phases }: { r: RetroView; teams: ReadonlyMap<string, string>; phases: PhaseModel }) {
  const f = r.feedback;
  // From the project's own "first phase after building" on, feedback arrived once building had finished.
  const afterBuild = new Set(phases.phases.slice(Math.max(0, phases.phases.findIndex((p) => p.id === phases.afterBuild))).map((p) => p.id));
  const rows: BarRow[] = f.byPhase.map((p: PhaseShare) => ({
    key: p.phase,
    label: phaseName(phases, p.phase),
    value: p.count,
    text: `${p.count} · ${percent(p.percent)}`,
    quiet: !afterBuild.has(p.phase),
  }));
  return (
    <Card title="When feedback arrived" sub="Feedback found after development has finished is the expensive kind: it means rework.">
      {f.total === 0 ? (
        <Empty title="No feedback recorded">Record client or internal feedback on the Record tab and it will be counted here.</Empty>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          <p>
            <strong>{percent(f.afterDevelopment.percent)}</strong> of the feedback ({f.afterDevelopment.count} of {f.total}) arrived after development had finished.
          </p>
          <BarList rows={rows} />
          <p className="muted" style={{ fontSize: 12.5 }}>
            Blue bars: after development had finished. Grey bars: earlier.
          </p>
          {f.bySourceTeam.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>From</th>
                    <th className="num">Items</th>
                    <th className="num">After development</th>
                  </tr>
                </thead>
                <tbody>
                  {f.bySourceTeam.map((t) => (
                    <tr key={t.teamId ?? 'none'}>
                      <td>{t.teamId ? (teams.get(t.teamId) ?? t.teamId) : 'No team given'}</td>
                      <td className="num">{t.total}</td>
                      <td className="num">{percent(t.afterDevelopmentPercent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function Observations({ r }: { r: RetroView }) {
  return (
    <Card title="What the project learned" sub="Plain findings, only for things that actually happened.">
      {r.observations.length === 0 ? (
        <Empty title="Nothing to report yet">Findings appear here as changes are recorded.</Empty>
      ) : (
        <ul className="plain-list">
          {r.observations.map((o) => (
            <li key={o} style={{ display: 'flex', gap: 8 }}>
              <span aria-hidden="true" style={{ color: 'var(--muted)' }}>
                {'•'}
              </span>
              <span>{o}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Changes({ r }: { r: RetroView }) {
  const none = (n: number): string => (n === 0 ? 'none' : String(n));
  return (
    <Card title="The kinds of change" sub="How much each kind cost, in schedule days (what moved delivery) and effort (work added).">
      <div className="tiles">
        <Tile
          label="Scope and requirements"
          value={none(r.scope.changes)}
          detail={r.scope.changes === 0 ? undefined : `${r.scope.afterDevelopmentStarted} after development started · ${signedDays(r.scope.scheduleDays)} schedule · ${num(r.scope.effortDays)} d effort`}
        />
        <Tile label="Capacity and calendar" value={none(r.resources.changes)} detail={r.resources.changes === 0 ? undefined : `${signedDays(r.resources.scheduleDays)} schedule`} />
        <Tile
          label="Rework and defects"
          value={none(r.rework.count)}
          detail={r.rework.count === 0 ? undefined : `${signedDays(r.rework.scheduleDays)} schedule · ${num(r.rework.effortDays)} d effort`}
        />
        <Tile label="Dependencies and blockers" value={none(r.dependencies.count)} detail={r.dependencies.count === 0 ? undefined : `${signedDays(r.dependencies.scheduleDays)} schedule`} />
        <Tile label="Planning changes" value={none(r.planning.edits)} detail={r.planning.edits === 0 ? undefined : `The plan moved ${signedDays(r.planning.planMovedDays)}: planning, not delay`} />
        <Tile
          label="Could have been found earlier"
          value={r.couldHaveBeenEarlier.of === 0 ? 'none' : `${r.couldHaveBeenEarlier.flagged} of ${r.couldHaveBeenEarlier.of}`}
          detail={r.couldHaveBeenEarlier.of === 0 ? undefined : 'Events someone marked as avoidable'}
        />
      </div>
    </Card>
  );
}

function Ownership({ r, titles }: { r: RetroView; titles: ReadonlyMap<string, string> }) {
  if (r.ownership.transfers.length === 0) return null;
  return (
    <Card title="Who tasks moved between" sub="A record, not a scorecard: it shows what a hand-over cost, not who is to blame.">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Task</th>
              <th>Handed to</th>
              <th className="num">Catch-up</th>
              <th>Recorded as</th>
            </tr>
          </thead>
          <tbody>
            {r.ownership.transfers.map((t) => (
              <tr key={`${t.eventId}:${t.taskId}`}>
                <td className="nowrap">{formatDate(t.asOf)}</td>
                <td>{t.taskId}</td>
                <td>{t.toPersonId}</td>
                <td className="num">{t.contextCost > 0 ? workingDays(t.contextCost) : '—'}</td>
                <td>{titles.get(t.eventId) ?? t.eventId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
