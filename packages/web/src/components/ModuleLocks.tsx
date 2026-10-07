import { useState } from 'react';
import { api } from '../api/client';
import { formatDate } from '../lib/dates';
import { useProject } from '../state';
import { Card, ErrorNote } from './ui';

const KIND = { DELIVERABLE: 'Deliverable', SHARED: 'Shared systems', PROJECT: 'Integration and delivery' } as const;

/**
 * Locking a module says "work on this has started". From then on a change to it is an event (it counts as delay);
 * until then it is still being planned, and a change is a planning change. The first lock starts the project.
 */
export function ModuleLocks() {
  const { projectId, detail, refresh } = useProject();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const lock = async (moduleId: string) => {
    setBusy(moduleId);
    setError(null);
    try {
      await api.lockModule(projectId, moduleId);
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const started = detail.modules.filter((m) => m.lockedAt !== null).length;
  return (
    <Card
      title="Modules"
      sub={
        detail.started
          ? `${started} of ${detail.modules.length} started. Start a module when its work begins: from then on, changes to it are recorded as events.`
          : 'The project has not started. Start a module to begin: the original plan is frozen at that moment.'
      }
    >
      {error ? <ErrorNote error={error} /> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Module</th>
              <th>What it is</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {detail.modules.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td className="secondary">{KIND[m.kind]}</td>
                <td>{m.lockedAt ? <span>Started {formatDate(m.lockedAt.slice(0, 10))}</span> : <span className="secondary">Still being planned</span>}</td>
                <td style={{ textAlign: 'right' }}>
                  {m.lockedAt ? null : (
                    <button type="button" className="button small" disabled={busy !== null} onClick={() => void lock(m.id)} aria-label={`Start ${m.name}`}>
                      {busy === m.id ? 'Starting…' : detail.started ? 'Start module' : 'Start the project with this'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
