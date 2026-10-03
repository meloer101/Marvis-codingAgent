import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { offerAutoSwitch, planApprovalLabel } from '@harness-code/core/browser';
import type { PermissionMode } from '@harness-code/core';

import { MODES } from '@/components/ComposerControls';
import { Markdown } from '@/components/Markdown';
import { toolPreview } from '@/components/tools/registry';
import { Button } from '@/components/ui/button';
import type { SessionViewState } from '@/lib/sessionModel';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';

/** "`npm test` commands" with the backticked part set as code. */
function withCode(text: string): ReactNode[] {
  return text.split('`').map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="font-mono">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

/** The question a permission ask puts, by tool. */
function askQuestion(toolName: string): string {
  switch (toolName) {
    case 'bash':
      return 'Run this command?';
    case 'write':
      return 'Write this file?';
    case 'edit':
      return 'Make this edit?';
    case 'webfetch':
      return 'Fetch this page?';
    default:
      return `Allow ${toolName}?`;
  }
}

/** Why it asks, said once: "requires approval in Ask mode", without the tool's name again. */
function askReason(reason: string, toolName: string): string {
  const own = reason.startsWith(`${toolName} `) ? reason.slice(toolName.length + 1) : reason;
  const text = own.replace(/ in (\w+) mode$/, (_, mode: string) => ` in ${MODES[mode as PermissionMode]?.label ?? mode} mode`);
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Human-in-the-loop prompts, docked above the composer (opencode-style, no
 * modal). Edits are reviewed as a diff, writes as the file content, bash as
 * the highlighted command (`toolPreview`). Keys match the TUI: y / a / n / s
 * for a permission ask, y / m / e for a plan, Esc denies or keeps planning.
 * Feedback rides along with a deny or a rejection so the model learns why;
 * inside the feedback box, Esc or ⌘/Ctrl+Enter sends it.
 *
 * The dock takes focus when a prompt appears (the composer otherwise holds
 * it, and every key would land in the textarea instead) — unless the user is
 * mid-sentence in another text box, where a stray `y` must not answer.
 */
export function PendingDock({ view }: { view: SessionViewState }) {
  const sync = useSync();
  const modes = useAppStore((s) => s.info?.modes);
  const autoAvailable = (modes ?? []).includes('auto');
  const { pendingAsk, askId, pendingPlan, planId } = view;
  const [feedback, setFeedback] = useState('');
  const [noting, setNoting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const requestId = askId ?? planId;

  const offerAuto =
    !!pendingAsk &&
    offerAutoSwitch({
      mode: view.mode,
      autoAvailable,
      toolName: pendingAsk.toolName,
      forcedByRule: pendingAsk.forcedByRule === true,
    });

  // Approving sends no mode: the session applies its own resolved
  // planApprovedMode, which the server mirrors here for the label.
  const planYesMode = pendingPlan?.yesMode ?? 'acceptEdits';

  useEffect(() => {
    setFeedback('');
    setNoting(false);
    if (!requestId) return;
    const active = document.activeElement;
    const typing =
      (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) &&
      active.value.trim() !== '' &&
      !ref.current?.contains(active);
    if (!typing) ref.current?.focus();
  }, [requestId]);

  if (!requestId) return null;

  const deny = (): void => {
    if (askId) void sync.answerAsk(view.id, askId, 'deny', feedback);
  };
  /** Send the plan back with what was typed; with nothing typed, ask for it first. */
  const revise = (): void => {
    if (!planId) return;
    if (feedback.trim() === '') boxRef.current?.focus();
    else void sync.answerPlan(view.id, planId, false, feedback);
  };
  const keepPlanning = (): void => {
    if (planId) void sync.answerPlan(view.id, planId, false, feedback);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    const hit = (fn: () => void): void => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
      // Letters are feedback, not shortcuts. Esc and ⌘/Ctrl+Enter send the
      // feedback, and Esc must stop here: on the window it aborts the run.
      if (e.nativeEvent.isComposing) return;
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        hit(pendingAsk && askId ? deny : keepPlanning);
      }
      return;
    }
    const key = e.key.toLowerCase();
    if (pendingAsk && askId) {
      if (key === 'y') hit(() => void sync.answerAsk(view.id, askId, 'once'));
      else if (key === 'a' && pendingAsk.alwaysAllow) hit(() => void sync.answerAsk(view.id, askId, 'always'));
      else if (key === 's' && offerAuto) hit(() => void sync.answerAsk(view.id, askId, 'auto'));
      else if (key === 'n' || e.key === 'Escape') hit(deny);
    } else if (pendingPlan && planId) {
      if (key === 'y') hit(() => void sync.answerPlan(view.id, planId, true));
      else if (key === 'm') hit(() => void sync.answerPlan(view.id, planId, true, undefined, 'ask'));
      else if (key === 'e') hit(revise);
      else if (e.key === 'Escape') hit(keepPlanning);
    }
  };

  const feedbackBox = (placeholder: string) => (
    <textarea
      ref={boxRef}
      autoFocus={noting}
      rows={1}
      value={feedback}
      onChange={(e) => setFeedback(e.target.value)}
      placeholder={placeholder}
      className="field-sizing-content w-full resize-none rounded-md bg-background px-2.5 py-[7px] text-xs outline-none placeholder:text-faint focus:ring-2 focus:ring-ring/30"
    />
  );

  const Key = ({ children }: { children: string }) => (
    <kbd className="font-mono text-[11px] font-normal text-faint uppercase">{children}</kbd>
  );

  /** The block's first line: a dot that pulses as it arrives, the question, and why it is asked. */
  const Title = ({ children, meta }: { children: ReactNode; meta?: ReactNode }) => (
    <div className="flex min-w-0 items-center gap-2">
      <span className="size-1.5 shrink-0 animate-pulse-twice rounded-full bg-warning-dot" />
      <span className="min-w-0 truncate text-sm font-semibold">{children}</span>
      <span className="flex-1" />
      {meta && <span className="max-w-[55%] shrink-0 truncate text-xs text-faint">{meta}</span>}
    </div>
  );

  const dock =
    'group/dock flex animate-rise-lg flex-col gap-2.5 rounded-lg bg-warning-subtle px-3.5 pt-3 pb-3.5 text-sm outline-none';

  if (pendingAsk && askId) {
    const preview = toolPreview(pendingAsk.toolName, pendingAsk.input, { before: pendingAsk.before });
    return (
      <div ref={ref} tabIndex={-1} data-pending-dock="" onKeyDown={onKeyDown} className={dock}>
        <Title meta={`${pendingAsk.toolName} · ${askReason(pendingAsk.reason, pendingAsk.toolName)}`}>
          {askQuestion(pendingAsk.toolName)}
        </Title>
        {preview}
        {/* A note rides along with a deny; it is optional, so it waits to be asked for. */}
        {(noting || feedback !== '') && feedbackBox('Tell the model why — Esc or ⌘↵ denies with this note')}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" onClick={() => void sync.answerAsk(view.id, askId, 'once')}>
            Allow once<Key>y</Key>
          </Button>
          {pendingAsk.alwaysAllow && (
            <Button size="sm" variant="outline" onClick={() => void sync.answerAsk(view.id, askId, 'always')}>
              <span>Always allow {withCode(pendingAsk.alwaysAllow)}</span>
              <Key>a</Key>
            </Button>
          )}
          {offerAuto && (
            <Button size="sm" variant="outline" onClick={() => void sync.answerAsk(view.id, askId, 'auto')}>
              Yes, auto mode<Key>s</Key>
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={deny}>
            Deny<Key>n</Key>
          </Button>
          {!noting && feedback === '' && (
            <button
              type="button"
              onClick={() => setNoting(true)}
              className="ml-auto rounded-md px-1.5 py-1 text-xs text-faint transition-colors hover:text-foreground"
            >
              Add a note
            </button>
          )}
        </div>
      </div>
    );
  }

  if (pendingPlan && planId) {
    const label = planApprovalLabel(planYesMode);
    const yesLabel = label.charAt(0).toUpperCase() + label.slice(1);
    return (
      <div ref={ref} tabIndex={-1} data-pending-dock="" onKeyDown={onKeyDown} className={dock}>
        <Title meta="Plan mode · changes nothing until you approve">{pendingPlan.title || 'Plan ready for review'}</Title>
        <div className="max-h-72 overflow-auto rounded-md bg-background px-3 py-2">
          <Markdown text={pendingPlan.body} className="text-[13px]" />
        </div>
        {feedbackBox('What should change? Esc or ⌘↵ sends it back')}
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => void sync.answerPlan(view.id, planId, true)}>
            {yesLabel}
            <Key>y</Key>
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void sync.answerPlan(view.id, planId, true, undefined, 'ask')}
          >
            Yes, approve manually<Key>m</Key>
          </Button>
          <Button size="sm" variant="ghost" onClick={revise}>
            Revise<Key>e</Key>
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
