import type { ChangeExplanation } from '@multiverse/engine';
import { formatDate } from '../lib/dates';
import { describeOrigin, summarizeChange } from '../lib/explain';
import { signedDays } from '../lib/format';
import { Card } from './ui';

export interface EntryInfo {
  title: string;
  kind: 'EVENT' | 'PLAN' | 'VOID';
  type?: string;
  phase?: string;
  by?: string;
  description?: string;
  couldHaveBeenEarlier?: boolean;
}

const KIND = { EVENT: 'Event', PLAN: 'Planning change', VOID: 'Event withdrawn' } as const;

/** Why the forecast moved at one step: the answer a project manager asks for first when a date changes. */
export function ChangeDetail({
  explanation,
  entry,
  moduleNames,
  taskNames,
  onClose,
}: {
  explanation: ChangeExplanation;
  entry?: EntryInfo | undefined;
  moduleNames: ReadonlyMap<string, string>;
  taskNames: ReadonlyMap<string, string>;
  onClose?: (() => void) | undefined;
}) {
  const { headline, facts } = summarizeChange(explanation, taskNames);
  const kind = entry?.kind ?? (explanation.kind === 'PLAN' ? 'PLAN' : explanation.kind === 'VOID' ? 'VOID' : 'EVENT');
  return (
    <Card
      title={entry?.title ?? `Revision ${explanation.revision}`}
      sub={`${KIND[kind]}${explanation.asOf ? ` · ${formatDate(explanation.asOf, { year: true })}` : ''}${entry?.by ? ` · recorded by ${entry.by}` : ''}`}
      actions={
        onClose ? (
          <button type="button" className="button small quiet" onClick={onClose}>
            Close
          </button>
        ) : undefined
      }
      className="explain"
    >
      <p className="headline">{headline}</p>
      {facts.map((f) => (
        <p key={f} className="secondary">
          {f}
        </p>
      ))}
      {entry?.description ? <p className="secondary">“{entry.description}”</p> : null}
      {entry?.type || entry?.phase || entry?.couldHaveBeenEarlier ? (
        <p>
          {entry.type ? <span className="tag">{entry.type.toLowerCase().replace(/_/g, ' ')}</span> : null}
          {entry.phase ? <span className="tag">found in {entry.phase}</span> : null}
          {entry.couldHaveBeenEarlier ? <span className="tag">could have been found earlier</span> : null}
        </p>
      ) : null}

      {explanation.modules.length > 0 ? (
        <>
          <h3>Modules that moved</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Module</th>
                  <th>Finish</th>
                  <th className="num">Change</th>
                  <th className="num">Now vs plan</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {explanation.modules.map((m) => (
                  <tr key={m.moduleId}>
                    <td>{moduleNames.get(m.moduleId) ?? m.moduleId}</td>
                    <td className="nowrap">
                      {formatDate(m.finishBefore)} {'→'} {formatDate(m.finishAfter)}
                    </td>
                    <td className="num">{signedDays(m.delta)}</td>
                    <td className="num">{signedDays(m.variance)}</td>
                    <td>
                      {describeOrigin(m, moduleNames)}
                      {m.absorbed ? '; float absorbed it' : ''}
                      {m.onCriticalPath && !m.absorbed ? '; on the critical path' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {explanation.tasks.length > 0 ? (
        <>
          <h3>Tasks</h3>
          <ul className="plain-list">
            {explanation.tasks.slice(0, 12).map((t) => (
              <li key={t.taskId} className="secondary">
                <strong style={{ color: 'var(--ink)' }}>{taskNames.get(t.taskId) ?? t.taskId}</strong>{' '}
                {t.change === 'ADDED'
                  ? `added, finishing ${t.finishAfter ? formatDate(t.finishAfter) : 'later'}`
                  : t.change === 'REMOVED'
                    ? 'removed'
                    : `${signedDays(t.finishDelta)}: ${t.finishBefore ? formatDate(t.finishBefore) : ''} → ${t.finishAfter ? formatDate(t.finishAfter) : ''}`}
              </li>
            ))}
            {explanation.tasks.length > 12 ? <li className="muted">and {explanation.tasks.length - 12} more</li> : null}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
