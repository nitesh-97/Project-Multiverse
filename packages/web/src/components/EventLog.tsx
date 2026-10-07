import { useState } from 'react';
import type { CurrentTask, EventLogItem, PlanEditLogItem } from '@multiverse/engine';
import { api } from '../api/client';
import { formatDate } from '../lib/dates';
import { describeEffect } from '../lib/describe';
import type { Names } from '../lib/describe';
import { sentence } from '../lib/format';
import { phaseName } from '../lib/templates';
import { useProject } from '../state';
import { Card, Empty, ErrorNote } from './ui';

type Entry = { kind: 'EVENT'; seq: number; item: EventLogItem } | { kind: 'PLAN'; seq: number; item: PlanEditLogItem };

/** Everything recorded so far, oldest first: the history the timeline is built from. */
export function EventLog({ events, planEdits, tasks, defaultDate }: { events: readonly EventLogItem[]; planEdits: readonly PlanEditLogItem[]; tasks: readonly CurrentTask[]; defaultDate: string }) {
  const { detail } = useProject();
  const names: Names = {
    task: (id) => tasks.find((t) => t.id === id)?.name ?? id,
    team: (id) => detail.teams.find((t) => t.id === id)?.name ?? id,
    module: (id) => detail.modules.find((m) => m.id === id)?.name ?? id,
  };
  const entries: Entry[] = [
    ...events.map((item): Entry => ({ kind: 'EVENT', seq: item.seq, item })),
    ...planEdits.map((item): Entry => ({ kind: 'PLAN', seq: item.seq, item })),
  ].sort((a, b) => a.seq - b.seq);

  return (
    <Card title="History" sub="Everything is kept. A mistake is withdrawn, not deleted, so the record of what was believed stays.">
      {entries.length === 0 ? (
        <Empty title="Nothing recorded yet">Pick something above when it happens.</Empty>
      ) : (
        <ul className="log-list">
          {entries.map((e) => (e.kind === 'EVENT' ? <EventRow key={`e${e.item.id}`} e={e.item} names={names} defaultDate={defaultDate} /> : <PlanRow key={`p${e.item.id}`} p={e.item} names={names} />))}
        </ul>
      )}
    </Card>
  );
}

function Glyph({ kind }: { kind: 'EVENT' | 'PLAN' }) {
  return (
    <svg className="log-glyph" viewBox="-10 -10 20 20" aria-hidden="true">
      {kind === 'EVENT' ? <circle r="5.5" fill="none" stroke="var(--ink)" strokeWidth="2" /> : <path d="M 0 -8 l 8 8 l -8 8 l -8 -8 z" fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinejoin="round" />}
    </svg>
  );
}

function EventRow({ e, names, defaultDate }: { e: EventLogItem; names: Names; defaultDate: string }) {
  const { projectId, refresh, recordingAs, detail } = useProject();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [asOf, setAsOf] = useState(defaultDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const voided = e.status === 'VOIDED';

  const withdraw = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.voidEvent(projectId, e.id, { asOf, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      setOpen(false);
      refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`log-item${voided ? ' voided' : ''}`}>
      <Glyph kind="EVENT" />
      <div style={{ minWidth: 0 }}>
        <div className="log-title">{e.title}</div>
        <div className="log-meta">
          <span className="tag">{sentence(e.type)}</span>
          <span className="tag">{phaseName(detail.project.phases, e.phase)}</span>
          {voided ? <span className="tag">withdrawn</span> : null}
          {e.couldHaveBeenEarlier ? <span className="tag">could have been found earlier</span> : null}
          {formatDate(e.asOf, { year: true })} · {e.createdBy}
        </div>
        {e.description ? <div className="secondary">{e.description}</div> : null}
        {e.effects.length > 0 ? (
          <ul className="plain-list secondary" style={{ marginTop: 4 }}>
            {e.effects.slice(0, 4).map((fx, i) => (
              <li key={i}>{describeEffect(fx, names)}</li>
            ))}
            {e.effects.length > 4 ? <li className="muted">and {e.effects.length - 4} more</li> : null}
          </ul>
        ) : (
          <div className="muted">No schedule effect: recorded for the history.</div>
        )}
        {open ? (
          <div className="form" style={{ marginTop: 10 }}>
            <div className="form-grid">
              <div className="field">
                <label htmlFor={`void-date-${e.id}`}>Withdrawn on</label>
                <input id={`void-date-${e.id}`} type="date" value={asOf} onChange={(ev) => setAsOf(ev.target.value)} />
              </div>
              <div className="field">
                <label htmlFor={`void-why-${e.id}`}>Why (optional)</label>
                <input id={`void-why-${e.id}`} type="text" value={reason} onChange={(ev) => setReason(ev.target.value)} />
              </div>
            </div>
            {error ? <ErrorNote error={error} /> : null}
            <div className="form-actions">
              <button type="button" className="button primary small" disabled={busy} onClick={() => void withdraw()}>
                {busy ? 'Withdrawing…' : `Withdraw as ${recordingAs || 'me'}`}
              </button>
              <button type="button" className="button small quiet" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {!voided && !open ? (
        <button type="button" className="button small quiet" onClick={() => setOpen(true)} aria-label={`Withdraw ${e.title}`}>
          Withdraw
        </button>
      ) : (
        <span />
      )}
    </li>
  );
}

function PlanRow({ p, names }: { p: PlanEditLogItem; names: Names }) {
  return (
    <li className="log-item">
      <Glyph kind="PLAN" />
      <div style={{ minWidth: 0 }}>
        <div className="log-title">{p.title}</div>
        <div className="log-meta">
          <span className="tag">Planning change</span>
          {formatDate(p.asOf, { year: true })} · {p.createdBy}
        </div>
        {p.reason ? <div className="secondary">{p.reason}</div> : null}
        <ul className="plain-list secondary" style={{ marginTop: 4 }}>
          {p.effects.slice(0, 4).map((fx, i) => (
            <li key={i}>{describeEffect(fx, names)}</li>
          ))}
        </ul>
      </div>
      <span />
    </li>
  );
}
