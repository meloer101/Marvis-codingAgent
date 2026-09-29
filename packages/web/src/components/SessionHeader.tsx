import type { ReactNode } from 'react';
import { ChevronDown, Gauge } from 'lucide-react';

import { fmtTokens, fmtUSD } from '@harness-code/core/browser';
import type { PermissionMode, ReasoningEffort } from '@harness-code/core';

import { contextLevel } from '@/lib/format';
import type { SessionViewState } from '@/lib/sessionModel';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

const MODE_LABELS: Record<PermissionMode, string> = {
  ask: 'Ask',
  plan: 'Plan',
  acceptEdits: 'Accept edits',
  readOnly: 'Read only',
  yolo: 'YOLO',
  auto: 'Auto',
};

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

export function SessionHeader({ view }: { view: SessionViewState }) {
  const sync = useSync();
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4 text-sm">
      <ModelLabel modelRef={view.modelRef} />
      <ModePicker mode={view.mode} onChange={(mode) => void sync.setMode(view.id, mode)} />
      <EffortPicker
        effort={view.effort}
        levels={view.effortLevels}
        onChange={(effort) => void sync.setEffort(view.id, effort)}
      />
      <div className="flex-1" />
      <UsageMeter view={view} />
    </header>
  );
}

export function ModelLabel({ modelRef }: { modelRef: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2" title="Model">
      <span className="size-1.5 shrink-0 rounded-full bg-primary" />
      <span className="truncate font-mono text-xs text-muted-foreground">{modelRef}</span>
    </span>
  );
}

/** The permission-mode dropdown, over the modes the server offers. */
export function ModePicker({ mode, onChange }: { mode: PermissionMode; onChange: (mode: PermissionMode) => void }) {
  const modes = useAppStore((s) => s.info?.modes) ?? [mode];
  return (
    <HeaderSelect
      label="Permission mode"
      value={mode}
      options={modes.map((m) => ({ value: m, label: MODE_LABELS[m] }))}
      onChange={(m) => onChange(m as PermissionMode)}
    />
  );
}

/**
 * The reasoning-effort dropdown over the model's levels (Faster→Smarter);
 * nothing for a model without reasoning. A change applies from the next
 * message — a run in progress keeps the level it started with.
 */
export function EffortPicker({
  effort,
  levels,
  onChange,
}: {
  effort: ReasoningEffort | undefined;
  levels: readonly ReasoningEffort[];
  onChange: (effort: ReasoningEffort) => void;
}) {
  if (levels.length === 0) return null;
  // A level set elsewhere (settings, a flag) that the picker doesn't offer still shows as the current one.
  const shown = effort && !levels.includes(effort) ? [effort, ...levels] : levels;
  return (
    <HeaderSelect
      label="Reasoning effort"
      title="Reasoning effort — applies from your next message"
      icon={<Gauge className="size-3.5" />}
      value={effort ?? ''}
      options={shown.map((l) => ({ value: l, label: EFFORT_LABELS[l] }))}
      onChange={(l) => onChange(l as ReasoningEffort)}
    />
  );
}

/** A compact native select for the header row, with an optional leading icon. */
function HeaderSelect({
  label,
  title,
  icon,
  value,
  options,
  onChange,
}: {
  label: string;
  title?: string;
  icon?: ReactNode;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <span className="relative flex items-center" title={title}>
      {icon && (
        <span className="pointer-events-none absolute left-2 text-muted-foreground" aria-hidden>
          {icon}
        </span>
      )}
      <select
        aria-label={label}
        className={cn(
          'h-7 cursor-pointer appearance-none rounded-md border bg-card pr-7 text-xs font-medium shadow-xs transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none',
          icon ? 'pl-7' : 'pl-2.5',
        )}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </span>
  );
}

function UsageMeter({ view }: { view: SessionViewState }) {
  const { usage, context } = view;
  if (!usage && !context) return null;
  const level = context ? contextLevel(context.ratio) : 'ok';
  const pct = context ? Math.round(context.ratio * 100) : null;

  return (
    <div className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground tabular-nums">
      {usage && (
        <span title="Session tokens in / out">
          ↑{fmtTokens(usage.inputTokens)} ↓{fmtTokens(usage.outputTokens)}
        </span>
      )}
      {usage?.costUSD !== undefined && (
        <span title={usage.estimated ? 'Estimated cost' : 'Session cost'}>
          {usage.estimated ? '~' : ''}
          {fmtUSD(usage.costUSD)}
        </span>
      )}
      {context && pct !== null && (
        <span
          className="flex items-center gap-1.5"
          title={`Context ${fmtTokens(context.usedTokens)} / ${fmtTokens(context.windowTokens)}`}
        >
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
            <span
              className={cn(
                'block h-full rounded-full transition-[width] duration-300',
                level === 'danger' ? 'bg-destructive' : level === 'warn' ? 'bg-brass' : 'bg-primary/50',
              )}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </span>
          <span className={cn(level === 'danger' && 'text-destructive', level === 'warn' && 'text-brass')}>
            {pct}%
          </span>
        </span>
      )}
    </div>
  );
}
