import { useMemo, useState } from 'react';
import type { CurrentTask } from '@multiverse/engine';
import { api } from '../api/client';
import { formatDate } from '../lib/dates';
import { taskName } from '../lib/templates';
import { useProject } from '../state';
import { Card, ErrorNote } from './ui';

/**
 * Module starts and finishes are dots on the project view on their own. This is for the rest: any other task the
 * project manager wants to see as a checkpoint ("Client sign-off", "Content freeze") can be flagged here.
 */
export function MilestoneFlags({ flaggedTaskIds, tasks }: { flaggedTaskIds: readonly string[]; tasks: readonly CurrentTask[] }) {
  const { projectId, detail, refresh } = useProject();
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const candidates = useMemo(() => {
    const flagged = new Set(flaggedTaskIds);
    const byModule = new Map<string, CurrentTask[]>();
    for (const t of tasks) {
      if (flagged.has(t.id)) continue;
      byModule.set(t.moduleId, [...(byModule.get(t.moduleId) ?? []), t]);
    }
    return [...byModule.entries()];
  }, [tasks, flaggedTaskIds]);

  const set = async (taskId: string, flagged: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.setMilestoneFlag(projectId, taskId, flagged);
      setChoice('');
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const label = (t: CurrentTask): string => taskName({ modules: detail.modules }, t);

  return (
    <Card title="Project milestones" sub="Each module's start and finish is a dot on its own. Flag any other task to add a dot for it.">
      {error ? <ErrorNote error={error} /> : null}
      {flaggedTaskIds.length > 0 ? (
        <ul className="plain-list" style={{ marginBottom: 12 }}>
          {flaggedTaskIds.map((id) => {
            const t = byId.get(id);
            return (
              <li key={id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600 }}>{t ? label(t) : id}</span>
                {t ? <span className="secondary">due {formatDate(t.finishDate)}</span> : <span className="muted">no longer in the plan</span>}
                <button type="button" className="button small quiet" disabled={busy} onClick={() => void set(id, false)} aria-label={`Remove the flag from ${t ? label(t) : id}`}>
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="secondary" style={{ marginBottom: 12 }}>
          Nothing flagged yet.
        </p>
      )}
      <div className="form-actions">
        <label htmlFor="flag-task" className="sr-only">
          Task to flag as a milestone
        </label>
        <select id="flag-task" value={choice} onChange={(e) => setChoice(e.target.value)} style={{ minWidth: 260 }}>
          <option value="">Choose a task to flag…</option>
          {candidates.map(([moduleId, list]) => (
            <optgroup key={moduleId} label={detail.modules.find((m) => m.id === moduleId)?.name ?? moduleId}>
              {list.map((t) => (
                <option key={t.id} value={t.id}>
                  {label(t)}
                  {t.kind === 'MILESTONE' ? ' (milestone)' : ''} · due {formatDate(t.finishDate)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button type="button" className="button" disabled={busy || choice === ''} onClick={() => void set(choice, true)}>
          Flag as a milestone
        </button>
      </div>
    </Card>
  );
}
