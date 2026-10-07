import { useMemo, useState } from 'react';
import type { PointerEvent } from 'react';
import type { DriftPoint } from '@multiverse/engine';
import { formatDate } from '../lib/dates';
import { signed, signedDays } from '../lib/format';
import { useWidth } from './useWidth';
import { useTooltip } from './ui';

const HEIGHT = 190;
const M = { top: 16, right: 140, bottom: 28, left: 58 };

/** Round tick values up to something a person would write: 0, 1, 2, 5, 10. */
function niceTicks(lo: number, hi: number): number[] {
  const span = Math.max(hi - lo, 1);
  const step = span <= 4 ? 1 : span <= 10 ? 2 : span <= 25 ? 5 : 10;
  const ticks: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + 1e-9; v += step) ticks.push(v);
  return ticks;
}

/**
 * How the delivery forecast has drifted from the plan, one point for each time it was re-forecast: days late (up) or
 * early (down). One series, one hue; the end of the line is labelled and everything else is a hover away.
 */
export function ForecastTrend({ points, titles }: { points: readonly DriftPoint[]; titles: ReadonlyMap<string, string> }) {
  const [ref, width] = useWidth<HTMLDivElement>(640);
  const tip = useTooltip();
  const [hover, setHover] = useState<number | null>(null);

  const geometry = useMemo(() => {
    const values = points.map((p) => p.variance);
    const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
    const lo = ticks[0] ?? 0;
    const hi = ticks[ticks.length - 1] ?? 1;
    const plotW = Math.max(120, width - M.left - M.right);
    const plotH = HEIGHT - M.top - M.bottom;
    const x = (i: number): number => M.left + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
    const y = (v: number): number => M.top + (1 - (v - lo) / Math.max(hi - lo, 1e-9)) * plotH;
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.variance).toFixed(1)}`).join(' ');
    return { ticks, x, y, path, plotW };
  }, [points, width]);

  const nearest = (clientX: number, el: SVGSVGElement): number => {
    const box = el.getBoundingClientRect();
    const px = clientX - box.left;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(geometry.x(i) - px) < Math.abs(geometry.x(best) - px)) best = i;
    return best;
  };

  const readout = (p: DriftPoint) => (
    <>
      <div className="t-title">{p.kind === 'BASELINE' ? 'The plan, at the start' : (p.eventId && titles.get(p.eventId)) || `Revision ${p.revision}`}</div>
      <div className="t-line">
        Delivery <span className="t-value">{formatDate(p.forecastDelivery.date)}</span>
      </div>
      <div className="t-line">
        Against plan <span className="t-value">{signedDays(p.variance)}</span>
      </div>
      {p.asOf ? <div className="t-line muted">Status date {formatDate(p.asOf)}</div> : null}
    </>
  );

  const move = (e: PointerEvent<SVGSVGElement>) => {
    const i = nearest(e.clientX, e.currentTarget);
    setHover(i);
    const p = points[i];
    if (p) tip.show(e, readout(p));
  };
  const leave = () => {
    setHover(null);
    tip.hide();
  };

  if (points.length === 0) return null;
  const last = points[points.length - 1] as DriftPoint;
  const zeroY = geometry.y(0);

  return (
    <div ref={ref}>
      <svg
        width={Math.max(width, 280)}
        height={HEIGHT}
        role="img"
        aria-label={`Forecast delivery against the plan over ${points.length} forecasts. Now ${signedDays(last.variance)}.`}
        onPointerMove={move}
        onPointerLeave={leave}
        className="chart"
        style={{ touchAction: 'pan-y' }}
      >
        {geometry.ticks.map((v) => (
          <g key={v}>
            <line className="grid-line" x1={M.left} x2={M.left + geometry.plotW} y1={geometry.y(v)} y2={geometry.y(v)} />
            <text x={M.left - 8} y={geometry.y(v) + 4} textAnchor="end" className="faint">
              {v === 0 ? 'on plan' : signed(v)}
            </text>
          </g>
        ))}
        <line className="axis-line" x1={M.left} x2={M.left + geometry.plotW} y1={zeroY} y2={zeroY} />
        <text x={M.left} y={HEIGHT - 6} className="faint">
          plan at start
        </text>
        <text x={M.left + geometry.plotW} y={HEIGHT - 6} textAnchor="end" className="faint">
          latest forecast
        </text>
        <path d={geometry.path} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {hover !== null ? <line className="crosshair" x1={geometry.x(hover)} x2={geometry.x(hover)} y1={M.top} y2={HEIGHT - M.bottom} /> : null}
        {points.map((p, i) =>
          i === points.length - 1 || i === hover ? <circle key={p.revision} cx={geometry.x(i)} cy={geometry.y(p.variance)} r={5} fill="var(--series-1)" className="ring" /> : null,
        )}
        <text x={geometry.x(points.length - 1) + 12} y={geometry.y(last.variance) + 4} className="strong">
          {signedDays(last.variance)}
        </text>
      </svg>
      {tip.node}
    </div>
  );
}
