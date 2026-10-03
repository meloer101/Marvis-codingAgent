import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Activity, ChartColumn, Table2 } from 'lucide-react';

import { fmtTokens } from '@harness-code/core/browser';
import type { SessionStats, StatsSummary } from '@harness-code/protocol';

import { MainHeader, SidebarOpener } from '@/components/Regions';
import { SelectChip } from '@/components/ui/select-chip';
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
      <MainHeader>
        <SidebarOpener />
        <Activity className="size-[15px] shrink-0 text-muted-foreground" />
        <span className="text-sm font-semibold">Usage</span>
      </MainHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1040px] flex-col gap-8 px-5 pt-5 pb-6">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
            <div role="radiogroup" aria-label="Range" className="flex rounded-md bg-muted p-0.5">
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="radio"
                  aria-checked={range === r.id}
                  onClick={() => setRange(r.id)}
                  className={cn(
                    'rounded-[3px] px-2.5 py-[3px] text-xs transition-colors',
                    range === r.id ? 'bg-background font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <SelectChip label="Project" value={workspaceId} onChange={setWorkspaceId}>
              <option value="">All projects</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </SelectChip>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          {!data ? (
            <p className="text-xs text-muted-foreground">Reading the traces…</p>
          ) : data.rollup.sessions === 0 ? (
            <p className="py-16 text-center text-[13px] text-muted-foreground">
              No traced sessions in this range — usage is recorded as sessions run (unless telemetry is off).
            </p>
          ) : (
            // A refetch keeps the last render, faded, rather than flashing empty.
            <div className={cn('flex flex-col gap-8 transition-opacity', loading && 'opacity-60')}>
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
  const stat = (label: string, value: string, note?: string) => (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-[11px] font-medium tracking-[0.02em] text-muted-foreground">{label}</span>
      <span className="truncate text-xl leading-[26px] font-semibold">{value}</span>
      <span className="truncate text-[11px] text-faint">{note ?? '\u00a0'}</span>
    </div>
  );
  return (
    <section aria-label="Totals" className="flex flex-wrap items-end gap-x-12 gap-y-5 rounded-lg bg-subtle px-6 py-5">
      <div className="flex flex-col gap-0.5">
        <span className="text-[11px] font-medium tracking-[0.02em] text-muted-foreground">{priced ? 'Cost' : 'Tokens'}</span>
        <span className="text-4xl leading-[1.1] font-semibold tracking-[-0.02em]">
          {priced ? fmtPartialCost(r.totalCostUSD, unpriced > 0) : fmtTokens(tokens)}
        </span>
        <span className="text-[11px] text-faint">
          {unpriced > 0
            ? priced
              ? `${unpriced} ${unpriced === 1 ? 'session' : 'sessions'} on unpriced models`
              : 'No prices for these models'
            : '\u00a0'}
        </span>
      </div>
      <div className="flex min-w-80 flex-1 gap-6">
        {stat(
          'Sessions',
          r.sessions.toLocaleString(),
          priced ? `${fmtCost(r.avgCostPerSession)} each, on average` : `${fmtTokens(tokens / r.sessions)} tokens each`,
        )}
        {stat('Model calls', r.totalTurns.toLocaleString(), `${r.avgTurnsPerSession.toFixed(1)} a session`)}
        {stat(
          'Tool calls',
          r.totalToolCalls.toLocaleString(),
          r.totalDeniedToolCalls > 0 ? `${r.totalDeniedToolCalls.toLocaleString()} denied` : undefined,
        )}
        {stat(
          'Tokens',
          `↑${fmtTokens(r.totalInputTokens)} ↓${fmtTokens(r.totalOutputTokens)}`,
          `${Math.round(r.overallCacheHitRate * 100)}% of input cached`,
        )}
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
      label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + (width > 1 ? ' (week)' : ''),
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
    <section aria-label={priced ? 'Cost per day' : 'Tokens per day'} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{priced ? 'Cost per day' : 'Tokens per day'}</h2>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setAsTable(!asTable)}
          aria-pressed={asTable}
          title={asTable ? 'Show as a chart' : 'Show as a table'}
          className="-mr-1.5 flex items-center gap-[5px] rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {asTable ? <ChartColumn className="size-[13px]" /> : <Table2 className="size-[13px]" />}
          {asTable ? 'Chart' : 'Table'}
        </button>
      </div>
      {asTable ? (
        <div className="max-h-72 overflow-y-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>Day</th>
                <th className={cn(thClass, 'w-24 text-right')}>Sessions</th>
                <th className={cn(thClass, 'w-24 text-right')}>Tokens</th>
                <th className={cn(thClass, 'w-24 text-right')}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {data
                .filter((b) => b.sessions > 0)
                .map((b) => (
                  <tr key={b.start}>
                    <td className={cn(tdClass, 'text-[13px]')}>{b.label}</td>
                    <td className={numClass}>{b.sessions}</td>
                    <td className={numClass}>{fmtTokens(b.tokens)}</td>
                    <td className={costClass}>{fmtCost(b.costUSD)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex gap-2">
          {/* The y axis: three clean ticks, the values in muted text. */}
          <div className="-mt-[7px] flex h-[174px] w-9 shrink-0 flex-col justify-between text-right font-mono text-[11px] text-faint tabular-nums">
            <span>{fmt(top)}</span>
            <span>{fmt(top / 2)}</span>
            <span>{fmt(0)}</span>
          </div>
          <div className="relative min-w-0 flex-1">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-40">
              {[0, 0.5, 1].map((f) => (
                <div key={f} className="absolute inset-x-0 h-px bg-border" style={{ top: `calc(${f * 100}% - ${f}px)` }} />
              ))}
            </div>
            <div className="relative flex h-40 items-end gap-[2px] px-[3px]" onPointerLeave={() => setHover(null)}>
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
                      'w-full max-w-6 rounded-t-[2px] bg-chart-1 transition-colors group-focus-visible/col:ring-2 group-focus-visible/col:ring-ring/40',
                      hover === i && 'bg-ink',
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
                className="pointer-events-none absolute -top-1.5 z-10 flex -translate-y-full gap-1.5 rounded-md bg-ink px-2 py-1 text-xs whitespace-nowrap text-on-ink"
                // Centred on its column, but kept inside the card at either end.
                style={tooltipAt((hover + 0.5) / data.length)}
              >
                <span className="font-medium">{fmt(value(shown))}</span>
                <span className="text-faint">
                  {shown.label} · {shown.sessions} {shown.sessions === 1 ? 'session' : 'sessions'}
                </span>
              </div>
            )}
            <div className="mt-1.5 flex justify-between text-[11px] text-faint">
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
    <section aria-label="By model" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">By model</h2>
      <table className={tableClass}>
        <thead>
          <tr>
            <th className={thClass}>Model</th>
            {['Sessions', 'Calls', 'Input', 'Output', 'Cached', 'Cost'].map((h) => (
              <th key={h} className={cn(thClass, 'w-24 text-right')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rollup.byModel.map((m) => (
            <tr key={m.model}>
              <td className={cn(tdClass, 'max-w-64 truncate font-mono text-xs')}>{m.model}</td>
              <td className={numClass}>{m.sessions}</td>
              <td className={numClass}>{m.turns.toLocaleString()}</td>
              <td className={numClass}>{fmtTokens(m.inputTokens)}</td>
              <td className={numClass}>{fmtTokens(m.outputTokens)}</td>
              <td className={cn(numClass, m.inputTokens === 0 && 'text-faint')}>
                {m.inputTokens > 0 ? `${Math.round((m.cachedInputTokens / m.inputTokens) * 100)}%` : '—'}
              </td>
              <CostCell usd={m.costUSD} partial={m.costPartial} />
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Tables on the page: a grey head row, then rows with no rules between them. */
const tableClass = 'w-full table-fixed border-separate border-spacing-0 text-xs';
const thClass =
  'bg-subtle px-3 py-1.5 text-left text-[11px] font-medium tracking-[0.02em] text-muted-foreground first:rounded-l-md last:rounded-r-md';
const tdClass = 'px-3 py-[7px]';
const numClass = 'px-3 py-[7px] text-right font-mono text-muted-foreground tabular-nums';
const costClass = 'px-3 py-[7px] text-right font-mono font-medium tabular-nums';

/** A cost; an unknown one (no price) is a faint dash. */
function CostCell({ usd, partial }: { usd: number; partial: boolean }) {
  const text = fmtPartialCost(usd, partial);
  return <td className={cn(costClass, text === '—' && 'font-normal text-faint')}>{text}</td>;
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
    <section aria-label="Sessions" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">Sessions</h2>
      <table className={tableClass}>
        <thead>
          <tr>
            <th className={thClass}>Session</th>
            <th className={cn(thClass, 'w-24')}>Project</th>
            <th className={cn(thClass, 'w-24')}>Started</th>
            {['Calls', 'Tools', 'Tokens', 'Cost'].map((h) => (
              <th key={h} className={cn(thClass, 'w-24 text-right')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((s) => (
            <tr key={s.id}>
              <td className={cn(tdClass, 'truncate text-[13px] font-medium')}>
                <a
                  href={routeToHash({ kind: 'session', id: s.id })}
                  onClick={() => setPanel('trace')}
                  title="Open it, with its trace"
                  className="hover:underline"
                >
                  {titles.get(s.id) ?? s.id.slice(0, 8)}
                </a>
              </td>
              <td className={cn(tdClass, 'truncate text-muted-foreground')}>{names.get(s.workspaceId) ?? ''}</td>
              <td className={cn(tdClass, 'text-faint')}>{relativeTime(s.startedAt)}</td>
              <td className={numClass}>{s.turns}</td>
              <td className={numClass}>{s.toolCalls}</td>
              <td className={numClass}>{fmtTokens(s.inputTokens + s.outputTokens)}</td>
              <CostCell usd={s.costUSD} partial={s.costPartial} />
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > SESSIONS_SHOWN && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="self-start px-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {all ? 'Show fewer' : `Show all ${sorted.length}`}
        </button>
      )}
    </section>
  );
}
