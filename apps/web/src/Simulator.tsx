import { useMemo, useState } from "react";
import series from "../../../packages/simulator/reports/series.json";

type Point = { day: number; burned: number; supply: number; hearth: number; threshold: number };
const SCENARIOS = series as unknown as Record<string, Point[]>;
const NAMES = Object.keys(SCENARIOS);

const MEASURES: { key: keyof Point; title: string; unit: string; note: string }[] = [
  { key: "supply", title: "EMBER supply", unit: "EMBER", note: "Falls only when accepted work burns the counted EMBER." },
  { key: "threshold", title: "Next round's threshold", unit: "EMBER", note: "Up ×1.05 after a winner, down ×0.85 when nothing qualifies." },
  { key: "hearth", title: "Hearth", unit: "NEAR", note: "Stoked daily; pays creators only for accepted work." },
];

const fmt = (value: number, unit: string) =>
  `${value.toLocaleString("en-US", { maximumFractionDigits: unit === "NEAR" ? 2 : 0 })} ${unit}`;

/** Static charts of the seeded 60-day simulation that chose the live rule values. */
export function SimulatorPage() {
  const [name, setName] = useState(NAMES[0]!);
  const points = SCENARIOS[name]!;
  const last = points[points.length - 1]!;

  return (
    <div className="narrow">
      <section className="card">
        <h2>The simulation behind the rules</h2>
        <p>Sixty simulated days per scenario, a round every three days, averaged over seven seeds. The rule values the contract runs were chosen from these runs: ×1.05 / ×0.85 for the threshold, 25% of the Hearth per round, and a target of four times the threshold.</p>
        <p className="hint">These are assumption-driven scenarios, not forecasts. The full report in the source has the spread across seeds, the strategy table and the rule sweeps.</p>
        <label className="field">
          <span>Scenario</span>
          <select value={name} onChange={(e) => setName(e.target.value)}>
            {NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <dl className="facts">
          <div><dt>Burned by day 60</dt><dd>{last.burned.toLocaleString("en-US")}</dd></div>
          <div><dt>Final threshold</dt><dd>{last.threshold.toLocaleString("en-US")}</dd></div>
          <div><dt>Final Hearth</dt><dd>{last.hearth.toFixed(1)} <small>NEAR</small></dd></div>
        </dl>
      </section>

      {MEASURES.map((m) => (
        <section className="card" key={m.key}>
          <h2>{m.title}</h2>
          <p className="hint">{m.note}</p>
          <LineChart points={points} measure={m.key} unit={m.unit} label={`${m.title} over 60 days, ${name}`} />
        </section>
      ))}

      <section className="card">
        <h2>What the simulation found against the design</h2>
        <p>A whale that abstains until the threshold halves, then wins as cheaply as it can, pays about 84% less per win and takes 8.1 of 20 rounds where the crowd alone can't reach the threshold. Nothing in the contract prevents this; it is listed in the README's Limits.</p>
        <details>
          <summary>Table of the selected scenario</summary>
          <table className="table">
            <thead><tr><th>Day</th><th>Supply</th><th>Burned</th><th>Threshold</th><th>Hearth</th></tr></thead>
            <tbody>
              {points.filter((p) => p.day % 5 === 0 || p.day === last.day).map((p) => (
                <tr key={p.day}><td>{p.day}</td><td>{p.supply.toLocaleString("en-US")}</td><td>{p.burned.toLocaleString("en-US")}</td><td>{p.threshold.toLocaleString("en-US")}</td><td>{p.hearth.toFixed(2)}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>
    </div>
  );
}

const W = 600;
const H = 200;
const PAD = { left: 64, right: 12, top: 12, bottom: 26 };

function niceDomain(values: number[]): [number, number] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || Math.abs(hi) || 1;
  return [Math.max(0, lo - span * 0.08), hi + span * 0.08];
}

function LineChart({ points, measure, unit, label }: { points: Point[]; measure: keyof Point; unit: string; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = points.map((p) => p[measure]);
  const [lo, hi] = useMemo(() => niceDomain(values), [values]);
  const maxDay = points[points.length - 1]!.day;
  const x = (day: number) => PAD.left + (day / maxDay) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.day).toFixed(1)},${y(p[measure]).toFixed(1)}`).join("");
  const ticks = [lo, (lo + hi) / 2, hi];
  const shown = hover === null ? null : points[hover]!;

  const onMove = (event: React.PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const day = ((event.clientX - box.left) / box.width) * maxDay;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(day))));
  };

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="grid" />
            <text x={PAD.left - 8} y={y(t)} className="axis" textAnchor="end" dominantBaseline="middle">{compact(t, unit)}</text>
          </g>
        ))}
        {[0, Math.round(maxDay / 2), maxDay].map((d) => (
          <text key={d} x={x(d)} y={H - 6} className="axis" textAnchor="middle">day {d}</text>
        ))}
        <path d={path} className="line" />
        {shown && (
          <>
            <line x1={x(shown.day)} x2={x(shown.day)} y1={PAD.top} y2={H - PAD.bottom} className="crosshair" />
            <circle cx={x(shown.day)} cy={y(shown[measure])} r={5} className="dot" />
          </>
        )}
        <rect
          x={PAD.left} y={PAD.top} width={W - PAD.left - PAD.right} height={H - PAD.top - PAD.bottom}
          fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)}
        />
      </svg>
      {shown && (
        <div className="tip" style={{ left: `clamp(72px, ${(x(shown.day) / W) * 100}%, calc(100% - 72px))` }}>
          <strong>Day {shown.day}</strong> {fmt(shown[measure], unit)}
        </div>
      )}
    </div>
  );
}

function compact(value: number, unit: string): string {
  if (unit === "NEAR") return value.toFixed(value < 10 ? 1 : 0);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return Math.round(value).toString();
}
