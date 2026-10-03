import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Activity, ChartColumn, Table2 } from 'lucide-react';

import { fmtTokens } from '@harness-code/core/browser';
import type { SessionStats, StatsSummary } from '@harness-code/protocol';

import { fmtCost, fmtPartialCost, relativeTime } from '@/lib/format';
import { setPanel } from '@/lib/panel';
import { routeToHash } from '@/lib/route';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

const RANGES = [
  { id: '7', label: '7 days', days: 7 },
  { id: '30', label: '30 days', days: 30 },
  { id: '90', label: '90 days', days: 90 },
  { id: 'all', label: 'All time', days: 0 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

const DAY = 86_400_000;
const SESSIONS_SHOWN = 25;

/**
 * What the recorded sessions cost and did (`stats.summary`), over a range of
 * days, in one project or all: the totals, the cost (or, unpriced, the tokens)
 * per day, each model's share and the sessions themselves, the costliest
 * first — each opening to its trace.
 */
export function StatsView() {
  const sync = useSync();
  const workspaces = useAppStore((s) => s.workspaces);
  const connected = useAppStore((s) => s.status === 'open');
  const [range, setRange] = useState<RangeId>('30');
  const [workspaceId, setWorkspaceId] = useState('');
  const [data, setData] = useState<StatsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const days = RANGES.find((r) => r.id === range)!.days;

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    setLoading(true);
    const since = days ? startOfDay(Date.now()) - (days - 1) * DAY : undefined;
    sync
      .loadStats({ ...(workspaceId ? { workspaceId } : {}), ...(since !== undefined ? { since } : {}) })
      .then(
        (d) => {
          if (cancelled) return;
          setData(d);
          setError(null);
        },
        (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [sync, connected, workspaceId, days]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 text-sm">
        <Activity className="size-3.5 text-muted-foreground" />
        <span className="text-[13px] font-medium">Usage</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-6">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
            <div role="radiogroup" aria-label="Range" className="flex rounded-md border p-0.5">
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="radio"
                  aria-checked={range === r.id}
                  onClick={() => setRange(r.id)}
                  className={cn(
                    'rounded px-2 py-0.5 text-xs transition-colors',
                    range === r.id ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <select
              aria-label="Project"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              className="h-7 rounded-md border bg-card px-2 text-xs shadow-xs focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
            >
              <option value="">All projects</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          {!data ? (
            <p className="text-xs text-muted-foreground">Reading the traces…</p>
          ) : data.rollup.sessions === 0 ? (
            <p className="py-16 text-center font-serif text-sm text-muted-foreground italic">
              No traced sessions in this range — usage is recorded as sessions run (unless telemetry is off).
            </p>
          ) : (
            // A refetch keeps the last render, faded, rather than flashing empty.
            <div className={cn('flex flex-col gap-6 transition-opacity', loading && 'opacity-60')}>
              <Figures data={data} />
              <PerDay sessions={data.sessions} days={days} />
              <ByModel data={data} />
              <Sessions sessions={data.sessions} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The headline — the cost, or the tokens when nothing in range has a price — and four tiles beside it. */
function Figures({ data }: { data: StatsSummary }) {
  const r = data.rollup;
  const priced = r.totalCostUSD > 0;
  const tokens = r.totalInputTokens + r.totalOutputTokens;
  const unpriced = r.sessionsWithPartialCost;
  const tile = (label: string, value: string, note?: string) => (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border bg-card px-3 py-2 shadow-xs">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="truncate text-lg font-semibold">{value}</span>
      {note && <span className="truncate text-[11px] text-muted-foreground">{note}</span>}
    </div>
  );
  return (
    <section aria-label="Totals" className="flex flex-wrap items-end gap-x-8 gap-y-4">
      <div className="flex flex-col">
        <span className="text-[11px] text-muted-foreground">{priced ? 'Cost' : 'Tokens'}</span>
        <span className="text-5xl font-semibold tracking-tight">
          {priced ? fmtPartialCost(r.totalCostUSD, unpriced > 0) : fmtTokens(tokens)}
        </span>
        {unpriced > 0 && (
          <span className="text-[11px] text-muted-foreground">
            {priced
              ? `${unpriced} ${unpriced === 1 ? 'session' : 'sessions'} on unpriced models`
              : 'No prices for these models'}
          </span>
        )}
      </div>
      <div className="@container min-w-64 flex-1">
        <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
          {tile(
            'Sessions',
            r.sessions.toLocaleString(),
            priced ? `${fmtCost(r.avgCostPerSession)} each, on average` : `${fmtTokens(tokens / r.sessions)} tokens each`,
          )}
          {tile('Model calls', r.totalTurns.toLocaleString(), `${r.avgTurnsPerSession.toFixed(1)} a session`)}
          {tile(
            'Tool calls',
            r.totalToolCalls.toLocaleString(),
            r.totalDeniedToolCalls > 0 ? `${r.totalDeniedToolCalls.toLocaleString()} denied` : undefined,
          )}
          {tile(
            'Tokens',
            `↑${fmtTokens(r.totalInputTokens)} ↓${fmtTokens(r.totalOutputTokens)}`,
            `${Math.round(r.overallCacheHitRate * 100)}% of input cached`,
          )}
        </div>
      </div>
    </section>
  );
}

interface Bucket {
  start: number;
  label: string;
  costUSD: number;
  tokens: number;
  sessions: number;
}

/** Days (or, over long spans, weeks) from the range's start — the earliest session's, for all time — to today. */
function buckets(sessions: readonly SessionStats[], days: number): Bucket[] {
  const today = startOfDay(Date.now());
  const earliest = Math.min(today, ...sessions.map((s) => startOfDay(s.startedAt)));
  const from = days ? today - (days - 1) * DAY : earliest;
  const span = Math.round((today - from) / DAY) + 1;
  const width = span > 120 ? 7 : 1;
  const count = Math.ceil(span / width);
  const out: Bucket[] = Array.from({ length: count }, (_, i) => {
    const start = from + i * width * DAY;
    const d = new Date(start);
    return {
      start,
      label: d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + (width > 1 ? ' (week)' : ''),
      costUSD: 0,
      tokens: 0,
      sessions: 0,
    };
  });
  for (const s of sessions) {
    const i = Math.floor((startOfDay(s.startedAt) - from) / (width * DAY));
    const b = out[Math.min(Math.max(i, 0), count - 1)];
    if (!b) continue;
    b.costUSD += s.costUSD;
    b.tokens += s.inputTokens + s.outputTokens;
    b.sessions++;
  }
  return out;
}

/** A clean top for the axis: 1, 2 or 5 times a power of ten, at or above `max`. */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  return ([1, 2, 5, 10].map((m) => m * p).find((v) => v >= max) ?? 10 * p);
}

function tooltipAt(f: number): CSSProperties {
  if (f < 0.2) return { left: 0 };
  if (f > 0.8) return { right: 0 };
  return { left: `${f * 100}%`, translate: '-50% -100%' };
}

/** Cost per day — tokens per day when no session in range has a price — as columns, with a table view. */
function PerDay({ sessions, days }: { sessions: readonly SessionStats[]; days: number }) {
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const data = useMemo(() => buckets(sessions, days), [sessions, days]);
  const priced = data.some((b) => b.costUSD > 0);
  const value = (b: Bucket): number => (priced ? b.costUSD : b.tokens);
  const fmt = (v: number): string => (priced ? fmtCost(v) : fmtTokens(v));
  const top = niceMax(Math.max(...data.map(value)));
  const shown = hover !== null ? data[hover] : undefined;
  return (
    <section aria-label={priced ? 'Cost per day' : 'Tokens per day'} className="rounded-lg border bg-card p-4 shadow-xs">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-medium">{priced ? 'Cost per day' : 'Tokens per day'}</h2>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setAsTable(!asTable)}
          aria-pressed={asTable}
          title={asTable ? 'Show as a chart' : 'Show as a table'}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {asTable ? <ChartColumn className="size-3.5" /> : <Table2 className="size-3.5" />}
          {asTable ? 'Chart' : 'Table'}
        </button>
      </div>
      {asTable ? (
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="text-left">
                <th className="py-1 font-medium">Day</th>
                <th className="py-1 text-right font-medium">Sessions</th>
                <th className="py-1 text-right font-medium">Tokens</th>
                <th className="py-1 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {data
                .filter((b) => b.sessions > 0)
                .map((b) => (
                  <tr key={b.start} className="border-t">
                    <td className="py-1 font-sans">{b.label}</td>
                    <td className="py-1 text-right">{b.sessions}</td>
                    <td className="py-1 text-right">{fmtTokens(b.tokens)}</td>
                    <td className="py-1 text-right">{fmtCost(b.costUSD)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex gap-2">
          {/* The y axis: three clean ticks, the values in muted text. */}
          <div className="flex h-40 flex-col justify-between py-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
            <span>{fmt(top)}</span>
            <span>{fmt(top / 2)}</span>
            <span>{fmt(0)}</span>
          </div>
          <div className="relative min-w-0 flex-1">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-40">
              {[0, 0.5, 1].map((f) => (
                <div key={f} className="absolute inset-x-0 border-t border-border" style={{ top: `${f * 100}%` }} />
              ))}
            </div>
            <div className="relative flex h-40 items-end gap-[2px]" onPointerLeave={() => setHover(null)}>
              {data.map((b, i) => (
                <button
                  key={b.start}
                  type="button"
                  aria-label={`${b.label}: ${fmt(value(b))}, ${b.sessions} ${b.sessions === 1 ? 'session' : 'sessions'}`}
                  onPointerEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  // The whole column is the hit target, not just the painted bar.
                  className="group/col flex h-full min-w-0 flex-1 items-end justify-center outline-none"
                >
                  <span
                    className={cn(
                      'w-full max-w-6 rounded-t bg-chart-1 transition-opacity group-hover/col:opacity-80 group-focus-visible/col:ring-2 group-focus-visible/col:ring-ring/40',
                      value(b) === 0 && 'opacity-0',
                    )}
                    style={{ height: `${Math.max(value(b) > 0 ? 2 : 0, (value(b) / top) * 100)}%` }}
                  />
                </button>
              ))}
            </div>
            {shown && hover !== null && (
              <div
                role="tooltip"
                className="pointer-events-none absolute -top-2 z-10 -translate-y-full rounded-md border bg-popover px-2 py-1 text-xs whitespace-nowrap shadow-md"
                // Centred on its column, but kept inside the card at either end.
                style={tooltipAt((hover + 0.5) / data.length)}
              >
                <span className="font-semibold">{fmt(value(shown))}</span>{' '}
                <span className="text-muted-foreground">
                  {shown.label} · {shown.sessions} {shown.sessions === 1 ? 'session' : 'sessions'}
                </span>
              </div>
            )}
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>{data[0]?.label}</span>
              {data.length > 2 && <span>{data[Math.floor(data.length / 2)]?.label}</span>}
              <span>{data.at(-1)?.label}</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ByModel({ data }: { data: StatsSummary }) {
  return (
    <section aria-label="By model" className="rounded-lg border bg-card p-4 shadow-xs">
      <h2 className="mb-2 text-sm font-medium">By model</h2>
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="text-left">
            <th className="py-1 font-medium">Model</th>
            <th className="py-1 text-right font-medium">Sessions</th>
            <th className="py-1 text-right font-medium">Calls</th>
            <th className="py-1 text-right font-medium">Input</th>
            <th className="py-1 text-right font-medium">Output</th>
            <th className="py-1 text-right font-medium">Cached</th>
            <th className="py-1 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {data.rollup.byModel.map((m) => (
            <tr key={m.model} className="border-t">
              <td className="max-w-64 truncate py-1">{m.model}</td>
              <td className="py-1 text-right">{m.sessions}</td>
              <td className="py-1 text-right">{m.turns.toLocaleString()}</td>
              <td className="py-1 text-right">{fmtTokens(m.inputTokens)}</td>
              <td className="py-1 text-right">{fmtTokens(m.outputTokens)}</td>
              <td className="py-1 text-right">
                {m.inputTokens > 0 ? `${Math.round((m.cachedInputTokens / m.inputTokens) * 100)}%` : '—'}
              </td>
              <td className="py-1 text-right">{fmtPartialCost(m.costUSD, m.costPartial)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** The sessions in range, the costliest first (the newest, unpriced), each opening to its trace. */
function Sessions({ sessions }: { sessions: readonly SessionStats[] }) {
  const rows = useAppStore((s) => s.sessions);
  const workspaces = useAppStore((s) => s.workspaces);
  const [all, setAll] = useState(false);
  const titles = useMemo(() => new Map(rows.map((r) => [r.id, r.title])), [rows]);
  const names = useMemo(() => new Map(workspaces.map((w) => [w.id, w.name])), [workspaces]);
  const sorted = useMemo(
    () => [...sessions].sort((a, b) => b.costUSD - a.costUSD || b.startedAt - a.startedAt),
    [sessions],
  );
  const shown = all ? sorted : sorted.slice(0, SESSIONS_SHOWN);
  return (
    <section aria-label="Sessions" className="rounded-lg border bg-card p-4 shadow-xs">
      <h2 className="mb-2 text-sm font-medium">Sessions</h2>
      <table className="w-full table-fixed text-xs">
        <thead className="text-muted-foreground">
          <tr className="text-left">
            <th className="w-[40%] py-1 font-medium">Session</th>
            <th className="py-1 font-medium">Project</th>
            <th className="py-1 font-medium">Started</th>
            <th className="py-1 text-right font-medium">Calls</th>
            <th className="py-1 text-right font-medium">Tools</th>
            <th className="py-1 text-right font-medium">Tokens</th>
            <th className="py-1 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((s) => (
            <tr key={s.id} className="border-t">
              <td className="truncate py-1">
                <a
                  href={routeToHash({ kind: 'session', id: s.id })}
                  onClick={() => setPanel('trace')}
                  title="Open it, with its trace"
                  className="hover:underline"
                >
                  {titles.get(s.id) ?? s.id.slice(0, 8)}
                </a>
              </td>
              <td className="truncate py-1 text-muted-foreground">{names.get(s.workspaceId) ?? ''}</td>
              <td className="py-1 text-muted-foreground">{relativeTime(s.startedAt)}</td>
              <td className="py-1 text-right font-mono tabular-nums">{s.turns}</td>
              <td className="py-1 text-right font-mono tabular-nums">{s.toolCalls}</td>
              <td className="py-1 text-right font-mono tabular-nums">{fmtTokens(s.inputTokens + s.outputTokens)}</td>
              <td className="py-1 text-right font-mono tabular-nums">{fmtPartialCost(s.costUSD, s.costPartial)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > SESSIONS_SHOWN && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="mt-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {all ? 'Show fewer' : `Show all ${sorted.length}`}
        </button>
      )}
    </section>
  );
}
