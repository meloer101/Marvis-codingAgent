/**
 * The composer's footer: what the next message runs under — permission mode,
 * model, reasoning effort — and how full the context is. Each control is a
 * small ghost button opening a menu above the composer.
 */

import type { ReactNode } from 'react';
import { AlertTriangle, Check, ChevronDown, Eye, Gauge, Hand, ListChecks, Loader2, PencilLine, Sparkles, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';

import type { PermissionMode, ReasoningEffort } from '@harness-code/core';
import type { ModelInfo } from '@harness-code/protocol';

import { fmtRate, fmtWindow } from '@/lib/format';
import { cn } from '@/lib/utils';

export const MODES: Record<PermissionMode, { label: string; hint: string; icon: LucideIcon; tone: string }> = {
  ask: { label: 'Ask', hint: 'Asks before it edits a file or runs a command', icon: Hand, tone: '' },
  acceptEdits: {
    label: 'Accept edits',
    hint: 'Edits files without asking; still asks before commands',
    icon: PencilLine,
    tone: 'bg-primary/10 text-primary hover:bg-primary/15',
  },
  plan: {
    label: 'Plan',
    hint: 'Reads and plans; changes nothing until you approve the plan',
    icon: ListChecks,
    tone: 'bg-primary/10 text-primary hover:bg-primary/15',
  },
  readOnly: { label: 'Read only', hint: 'Never changes anything', icon: Eye, tone: '' },
  auto: {
    label: 'Auto',
    hint: 'A classifier approves what is safe and asks about the rest',
    icon: Sparkles,
    tone: 'bg-primary/10 text-primary hover:bg-primary/15',
  },
  yolo: {
    label: 'YOLO',
    hint: 'Runs everything without asking',
    icon: Zap,
    tone: 'bg-destructive/10 text-destructive hover:bg-destructive/15',
  },
};

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

const triggerClass =
  'flex h-7 max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:opacity-50 data-[state=open]:bg-accent data-[state=open]:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0';
const contentClass =
  'z-50 max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] min-w-48 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95';
const itemClass =
  'relative flex cursor-default items-start gap-2 rounded-md py-1.5 pr-2 pl-7 text-[13px] outline-none select-none data-[disabled]:opacity-55 data-[highlighted]:bg-accent';
const labelClass = 'px-2 pt-1.5 pb-1 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase';

/** A footer menu: a trigger and a single-choice list opening above it. */
function ChoiceMenu({
  trigger,
  label,
  title,
  heading,
  value,
  onChange,
  onOpenChange,
  disabled,
  children,
  wide,
}: {
  trigger: ReactNode;
  label: string;
  title?: string;
  heading?: string;
  value: string;
  onChange: (value: string) => void;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <DropdownMenu.Root {...(onOpenChange ? { onOpenChange } : {})}>
      <DropdownMenu.Trigger asChild disabled={disabled === true}>
        <button type="button" aria-label={label} title={title ?? label} className={triggerClass}>
          {trigger}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="top" align="start" sideOffset={6} className={cn(contentClass, wide && 'w-96')}>
          {heading && <DropdownMenu.Label className={labelClass}>{heading}</DropdownMenu.Label>}
          <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
            {children}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Choice({ value, disabled, children }: { value: string; disabled?: boolean; children: ReactNode }) {
  return (
    <DropdownMenu.RadioItem value={value} disabled={disabled === true} className={itemClass}>
      <DropdownMenu.ItemIndicator className="absolute top-2 left-2 text-primary">
        <Check className="size-3.5" />
      </DropdownMenu.ItemIndicator>
      {children}
    </DropdownMenu.RadioItem>
  );
}

/** The permission mode as a chip; Shift+Tab in the composer cycles it. */
export function ModeChip({
  mode,
  modes,
  onChange,
}: {
  mode: PermissionMode;
  modes: readonly PermissionMode[];
  onChange: (mode: PermissionMode) => void;
}) {
  const meta = MODES[mode];
  const Icon = meta.icon;
  // A mode the list doesn't offer (set elsewhere) still shows as the current one.
  const shown = modes.includes(mode) ? modes : [mode, ...modes];
  return (
    <ChoiceMenu
      label="Permission mode"
      title={`${meta.label} — ${meta.hint}. Shift+Tab to switch`}
      heading="Permission mode"
      value={mode}
      onChange={(m) => onChange(m as PermissionMode)}
      trigger={
        <span className={cn('-mx-2 flex h-7 items-center gap-1.5 rounded-md px-2', meta.tone)}>
          <Icon />
          <span>{meta.label}</span>
        </span>
      }
    >
      {shown.map((m) => {
        const { label, hint, icon: ItemIcon } = MODES[m];
        return (
          <Choice key={m} value={m}>
            <ItemIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span>{label}</span>
              <span className="text-[11px] text-muted-foreground">{hint}</span>
            </span>
          </Choice>
        );
      })}
    </ChoiceMenu>
  );
}

/** `deepseek/deepseek-v4-pro` → `deepseek-v4-pro`: the part people say out loud. */
export function modelName(ref: string): string {
  const slash = ref.indexOf('/');
  return slash === -1 ? ref : ref.slice(slash + 1);
}

/**
 * The model the next message goes to. The list loads when the menu opens;
 * models that can't run here (no key) are listed but can't be picked.
 */
export function ModelPicker({
  modelRef,
  models,
  onOpen,
  onChange,
  disabledReason,
}: {
  modelRef: string;
  /** Undefined while loading. */
  models: readonly ModelInfo[] | undefined;
  onOpen: () => void;
  onChange: (ref: string) => void;
  /** Why it can't be changed right now (a run is going). */
  disabledReason?: string;
}) {
  // The current model is always listed, even when settings no longer offer it.
  const list = models && !models.some((m) => m.ref === modelRef) ? [{ ref: modelRef } as ModelInfo, ...models] : models;
  return (
    <ChoiceMenu
      label="Model"
      title={disabledReason ?? `${modelRef} — the model your next message goes to`}
      heading="Model"
      value={modelRef}
      onChange={onChange}
      onOpenChange={(open) => open && onOpen()}
      {...(disabledReason ? { disabled: true } : {})}
      wide
      trigger={
        <>
          <span className="size-1.5 shrink-0 rounded-full bg-primary" />
          <span className="truncate font-mono">{modelName(modelRef)}</span>
          <ChevronDown className="opacity-60" />
        </>
      }
    >
      {list === undefined ? (
        <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading models…
        </div>
      ) : (
        list.map((m) => (
          <Choice key={m.ref} value={m.ref} {...(m.problem ? { disabled: true } : {})}>
            <ModelRow model={m} />
          </Choice>
        ))
      )}
    </ChoiceMenu>
  );
}

function ModelRow({ model }: { model: ModelInfo }) {
  const facts: string[] = [];
  if (model.contextWindow) {
    facts.push(
      model.qualityContextWindow
        ? `${fmtWindow(model.contextWindow)} context · ${fmtWindow(model.qualityContextWindow)} reliable`
        : `${fmtWindow(model.contextWindow)} context`,
    );
  }
  if (model.effortLevels?.length) facts.push('reasoning');
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{model.ref}</span>
        {model.pricing && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums" title="Input / output, per million tokens">
            {model.pricing.inputPerMTok === 0 && model.pricing.outputPerMTok === 0
              ? 'free'
              : `${fmtRate(model.pricing.inputPerMTok)} / ${fmtRate(model.pricing.outputPerMTok)}`}
          </span>
        )}
      </span>
      {model.problem ? (
        <span className="flex items-start gap-1 text-[11px] text-brass-strong" title={model.problem}>
          <AlertTriangle className="mt-px size-3 shrink-0" />
          <span className="line-clamp-2">{model.problem}</span>
        </span>
      ) : (
        facts.length > 0 && <span className="text-[11px] text-muted-foreground">{facts.join(' · ')}</span>
      )}
    </span>
  );
}

/**
 * Reasoning effort over the model's levels (Faster→Smarter); nothing for a
 * model without reasoning. A change applies from the next message.
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
    <ChoiceMenu
      label="Reasoning effort"
      title="Reasoning effort — applies from your next message"
      heading="Reasoning effort"
      value={effort ?? ''}
      onChange={(l) => onChange(l as ReasoningEffort)}
      trigger={
        <>
          <Gauge />
          <span>{effort ? EFFORT_LABELS[effort] : 'Effort'}</span>
        </>
      }
    >
      {[...shown].reverse().map((l) => (
        <Choice key={l} value={l}>
          {EFFORT_LABELS[l]}
        </Choice>
      ))}
    </ChoiceMenu>
  );
}
