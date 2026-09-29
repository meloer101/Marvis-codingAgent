/**
 * How full the context is and what the session has cost: a ring in the
 * composer's footer, and the breakdown behind it in a popover.
 */

import type { ReactElement } from 'react';
import { Popover } from 'radix-ui';

import { fmtTokens, fmtUSD } from '@harness-code/core/browser';
import type { ContextSnapshot, Usage } from '@harness-code/core';

import { contextLevel } from '@/lib/format';
import { cn } from '@/lib/utils';

const LEVEL_STROKE = { ok: 'stroke-primary/70', warn: 'stroke-brass', danger: 'stroke-destructive' } as const;
const LEVEL_FILL = { ok: 'bg-primary/60', warn: 'bg-brass', danger: 'bg-destructive' } as const;

/** A ring filled to the context ratio; empty (dashed) before the first turn has measured it. */
export function ContextRing({ context, size = 16 }: { context: ContextSnapshot | undefined; size?: number }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const ratio = context ? Math.min(1, Math.max(0, context.ratio)) : 0;
  const level = context ? contextLevel(context.ratio) : 'ok';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={2}
        className="stroke-border"
        {...(context ? {} : { strokeDasharray: '2 2' })}
      />
      {context && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={`${c * ratio} ${c}`}
          className={cn('transition-[stroke-dasharray] duration-300', LEVEL_STROKE[level])}
        />
      )}
    </svg>
  );
}

/** The ring as a footer button opening the usage breakdown. */
export function ContextButton({
  context,
  usage,
  modelRef,
  open,
  onOpenChange,
}: {
  context?: ContextSnapshot;
  usage?: Usage;
  modelRef: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const pct = context ? Math.round(context.ratio * 100) : null;
  const level = context ? contextLevel(context.ratio) : 'ok';
  return (
    <UsagePopover
      context={context}
      usage={usage}
      modelRef={modelRef}
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <button
        type="button"
        aria-label="Context and usage"
        title={context ? `Context ${pct}% full — ${fmtTokens(context.usedTokens)} of ${fmtTokens(context.windowTokens)}` : 'Context and usage'}
        className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1.5 font-mono text-[11px] text-muted-foreground tabular-nums transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-accent"
      >
        <ContextRing context={context} />
        {pct !== null && (
          <span className={cn(level === 'danger' && 'text-destructive', level === 'warn' && 'text-brass')}>{pct}%</span>
        )}
      </button>
    </UsagePopover>
  );
}

/** A popover with the context breakdown and the session's usage, around any trigger. */
export function UsagePopover({
  context,
  usage,
  modelRef,
  children,
  side = 'top',
  open,
  onOpenChange,
}: {
  context: ContextSnapshot | undefined;
  usage: Usage | undefined;
  modelRef: string;
  children: ReactElement;
  side?: 'top' | 'bottom';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Popover.Root {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align="end"
          sideOffset={6}
          className="z-50 w-80 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <UsageDetails context={context} usage={usage} modelRef={modelRef} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function UsageDetails({ context, usage, modelRef }: { context?: ContextSnapshot; usage?: Usage; modelRef: string }) {
  return (
    <div className="flex flex-col gap-3 text-xs">
      <section className="flex flex-col gap-2">
        <Heading>Context</Heading>
        {context ? <ContextBreakdownView context={context} /> : <p className="text-muted-foreground">Measured after the first reply.</p>}
      </section>
      <section className="flex flex-col gap-1.5 border-t pt-3">
        <Heading>This session</Heading>
        {usage ? (
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums">
            <Stat label="Input" value={fmtTokens(usage.inputTokens)} />
            <Stat label="  cached" value={fmtTokens(usage.cachedInputTokens)} muted />
            <Stat label="Output" value={fmtTokens(usage.outputTokens)} />
            {usage.costUSD !== undefined && (
              <Stat label={usage.estimated ? 'Cost (estimated)' : 'Cost'} value={`${usage.estimated ? '~' : ''}${fmtUSD(usage.costUSD)}`} />
            )}
          </dl>
        ) : (
          <p className="text-muted-foreground">Nothing spent yet.</p>
        )}
        <p className="truncate font-mono text-[10px] text-muted-foreground" title={modelRef}>
          {modelRef}
        </p>
      </section>
    </div>
  );
}

const BUCKETS: Array<{ key: 'system' | 'toolSchemas' | 'projectMemory' | 'skills' | 'history'; label: string }> = [
  { key: 'history', label: 'Conversation' },
  { key: 'system', label: 'System prompt' },
  { key: 'toolSchemas', label: 'Tools' },
  { key: 'projectMemory', label: 'Project memory' },
  { key: 'skills', label: 'Skills' },
];

function ContextBreakdownView({ context }: { context: ContextSnapshot }) {
  const level = contextLevel(context.ratio);
  const pct = Math.round(context.ratio * 100);
  const { breakdown } = context;
  return (
    <>
      <div className="flex items-baseline justify-between font-mono text-[11px] tabular-nums">
        <span>
          {fmtTokens(context.usedTokens)} <span className="text-muted-foreground">of {fmtTokens(context.windowTokens)}</span>
        </span>
        <span className={cn(level === 'danger' && 'text-destructive', level === 'warn' && 'text-brass')}>{pct}%</span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
        <span className={cn('h-full rounded-full', LEVEL_FILL[level])} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      {breakdown && (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums">
          {BUCKETS.filter((b) => breakdown[b.key] > 0).map((b) => (
            <Stat key={b.key} label={b.label} value={fmtTokens(breakdown[b.key])} />
          ))}
        </dl>
      )}
      <p className="text-[11px] text-muted-foreground">History is compacted automatically near 92%, or now with /compact.</p>
    </>
  );
}

function Heading({ children }: { children: string }) {
  return <h3 className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">{children}</h3>;
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <>
      <dt className={cn('font-sans whitespace-pre', muted ? 'text-muted-foreground' : 'text-foreground/85')}>{label}</dt>
      <dd className={cn('text-right', muted && 'text-muted-foreground')}>{value}</dd>
    </>
  );
}
