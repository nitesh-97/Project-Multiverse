import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Health } from '../lib/format';
import { describeError } from '../api/client';

/** Status never rides on colour alone: every state has its own shape and a word. */
export type IconKind = Health | 'info';

export function StatusIcon({ health }: { health: IconKind }) {
  if (health === 'info') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8 7.2v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8" cy="4.8" r="1" fill="currentColor" />
      </svg>
    );
  }
  if (health === 'good') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M4.6 8.3l2.2 2.2 4.6-4.9" fill="none" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (health === 'warning') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 1.6l7 12.2H1z" fill="currentColor" strokeLinejoin="round" />
        <path d="M8 6v4" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8" cy="12" r="1" fill="var(--surface)" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="currentColor" />
      <path d="M5.3 5.3l5.4 5.4M10.7 5.3l-5.4 5.4" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function Status({ health, children }: { health: IconKind; children: ReactNode }) {
  return (
    <span className={`status status--${health}`}>
      <StatusIcon health={health} />
      <span>{children}</span>
    </span>
  );
}

export function Card({ title, sub, actions, children, className }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card${className ? ` ${className}` : ''}`}>
      {title || actions ? (
        <div className="card-head">
          <div>
            {title ? <h2>{title}</h2> : null}
            {sub ? <div className="sub">{sub}</div> : null}
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Tile({ label, value, detail, children }: { label: ReactNode; value: ReactNode; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {detail ? <div className="detail">{detail}</div> : null}
      {children}
    </div>
  );
}

export function Empty({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="notice error" role="alert">
      <StatusIcon health="critical" />
      <div style={{ flex: 1 }}>{describeError(error)}</div>
      {onRetry ? (
        <button type="button" className="button small" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** Holds the previous render, dimmed, while fresh data loads: no skeleton, no jump. */
export function Frame({ loading, children }: { loading: boolean; children: ReactNode }) {
  return (
    <div className={loading ? 'dim' : undefined} aria-busy={loading}>
      {children}
    </div>
  );
}

export interface BarRow {
  key: string;
  label: ReactNode;
  value: number;
  /** What is printed at the tip of the bar. */
  text: string;
  /** A bar that is not the point, drawn in the neutral tone. */
  quiet?: boolean;
  /** Drawn in the second hue, for values that go the other way. */
  negative?: boolean;
  title?: string;
}

/** Horizontal bars from one baseline, value at the tip. One hue: the bars are one measure, not different things. */
export function BarList({ rows, max }: { rows: BarRow[]; max?: number }) {
  const top = Math.max(max ?? 0, ...rows.map((r) => Math.abs(r.value)), 1e-9);
  return (
    <div className="bars" role="list">
      {rows.map((r) => (
        <div className="bar-row" role="listitem" key={r.key} title={r.title}>
          <div className="bar-label">{r.label}</div>
          <div className="bar-track" aria-hidden="true">
            <div className={`bar${r.quiet ? ' muted-bar' : ''}${r.negative ? ' negative' : ''}`} style={{ width: `${Math.max(0, (Math.abs(r.value) / top) * 100)}%` }} />
          </div>
          <div className="bar-value">{r.text}</div>
        </div>
      ))}
    </div>
  );
}

export function Meter({ percent, confirmed, label }: { percent: number; confirmed?: number; label: string }) {
  return (
    <div className="meter" role="img" aria-label={label}>
      <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      {confirmed !== undefined ? <span className="confirmed" style={{ width: `${Math.min(100, Math.max(0, confirmed))}%` }} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Tooltip: one floating readout, following the pointer, the same on keyboard focus. Content is React, so anything
// that came from the API (an event title, a module name) is escaped rather than parsed as HTML.
// ---------------------------------------------------------------------------------------------------------------

export interface TooltipApi {
  show: (target: { clientX: number; clientY: number }, content: ReactNode) => void;
  hide: () => void;
  node: ReactNode;
}

export function useTooltip(): TooltipApi {
  const [state, setState] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const show = useCallback((target: { clientX: number; clientY: number }, content: ReactNode) => setState({ x: target.clientX, y: target.clientY, content }), []);
  const hide = useCallback(() => setState(null), []);

  // Keep the readout inside the window.
  useEffect(() => {
    const el = ref.current;
    if (!el || !state) return;
    const { innerWidth, innerHeight } = window;
    const rect = el.getBoundingClientRect();
    let left = state.x + 14;
    let top = state.y + 16;
    if (left + rect.width > innerWidth - 8) left = Math.max(8, state.x - rect.width - 14);
    if (top + rect.height > innerHeight - 8) top = Math.max(8, state.y - rect.height - 16);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [state]);

  const node = state ? (
    <div className="tooltip" ref={ref} role="tooltip" style={{ left: state.x + 14, top: state.y + 16 }}>
      {state.content}
    </div>
  ) : null;
  return { show, hide, node };
}
