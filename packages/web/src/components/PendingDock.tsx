import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { ClipboardList, ShieldQuestion } from 'lucide-react';
import { planApprovalLabel } from '@harness-code/core/browser';

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

/**
 * Human-in-the-loop prompts, docked above the composer (opencode-style, no
 * modal). Edits are reviewed as a diff, writes as the file content, bash as
 * the highlighted command (`toolPreview`). Keys match the TUI: y / a / n / s
 * for a permission ask, y / m / e for a plan, Esc denies or keeps planning.
 * Feedback rides along with a deny or a rejection so the model learns why.
 *
 * The dock takes focus when a prompt appears (the composer otherwise holds
 * it, and every key would land in the textarea instead).
 */
export function PendingDock({ view }: { view: SessionViewState }) {
  const sync = useSync();
  const modes = useAppStore((s) => s.info?.modes);
  const autoAvailable = (modes ?? []).includes('auto');
  const { pendingAsk, askId, pendingPlan, planId } = view;
  const [feedback, setFeedback] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const requestId = askId ?? planId;

  const offerAuto =
    !!pendingAsk &&
    autoAvailable &&
    (view.mode === 'ask' || view.mode === 'acceptEdits') &&
    pendingAsk.toolName.toLowerCase() === 'bash' &&
    !pendingAsk.forcedByRule;

  // Approving sends no mode: the session applies its own resolved
  // planApprovedMode, which the server mirrors here for the label.
  const planYesMode = pendingPlan?.yesMode ?? 'acceptEdits';

  useEffect(() => {
    setFeedback('');
    if (requestId) ref.current?.focus();
  }, [requestId]);

  if (!requestId) return null;

  /** Shortcuts fire only outside the feedback box. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return;
    const key = e.key.toLowerCase();
    const hit = (fn: () => void): void => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (pendingAsk && askId) {
      if (key === 'y') hit(() => void sync.answerAsk(view.id, askId, 'once'));
      else if (key === 'a' && pendingAsk.alwaysAllow) hit(() => void sync.answerAsk(view.id, askId, 'always'));
      else if (key === 's' && offerAuto) hit(() => void sync.answerAsk(view.id, askId, 'auto'));
      else if (key === 'n' || e.key === 'Escape') hit(() => void sync.answerAsk(view.id, askId, 'deny', feedback));
    } else if (pendingPlan && planId) {
      if (key === 'y') hit(() => void sync.answerPlan(view.id, planId, true));
      else if (key === 'm') hit(() => void sync.answerPlan(view.id, planId, true, undefined, 'ask'));
      else if (key === 'e') hit(() => void sync.answerPlan(view.id, planId, false, 'revise'));
      else if (e.key === 'Escape') hit(() => void sync.answerPlan(view.id, planId, false, feedback));
    }
  };

  const feedbackBox = (placeholder: string) => (
    <textarea
      rows={1}
      value={feedback}
      onChange={(e) => setFeedback(e.target.value)}
      placeholder={placeholder}
      className="mt-3 w-full resize-none rounded-md border bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring/40"
    />
  );

  const Key = ({ children }: { children: string }) => (
    <kbd className="ml-1 rounded border bg-muted/60 px-1 font-mono text-[10px] opacity-70">{children}</kbd>
  );

  if (pendingAsk && askId) {
    const preview = toolPreview(pendingAsk.toolName, pendingAsk.input);
    return (
      <div
        ref={ref}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="animate-rise rounded-xl border border-brass/40 bg-brass-subtle/60 p-3 text-sm shadow-xs outline-none"
      >
        <div className="flex items-center gap-2 font-medium">
          <ShieldQuestion className="size-4 text-brass" />
          Allow <span className="font-mono">{pendingAsk.toolName}</span>?
        </div>
        {preview && <div className="mt-2">{preview}</div>}
        {pendingAsk.reason && <p className="mt-2 text-xs text-muted-foreground">{pendingAsk.reason}</p>}
        {feedbackBox('Optional: tell the model why, if you deny')}
        <div className="mt-3 flex flex-wrap gap-2">
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
          <Button size="sm" variant="ghost" onClick={() => void sync.answerAsk(view.id, askId, 'deny', feedback)}>
            Deny<Key>n</Key>
          </Button>
        </div>
      </div>
    );
  }

  if (pendingPlan && planId) {
    const label = planApprovalLabel(planYesMode);
    const yesLabel = label.charAt(0).toUpperCase() + label.slice(1);
    return (
      <div
        ref={ref}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="animate-rise rounded-xl border border-primary/35 bg-primary/[0.04] p-3 text-sm shadow-xs outline-none"
      >
        <div className="flex items-center gap-2 font-medium">
          <ClipboardList className="size-4 text-primary" />
          {pendingPlan.title || 'Plan ready for review'}
        </div>
        <div className="mt-2 max-h-72 overflow-auto rounded-md bg-muted/60 px-3 py-2">
          <Markdown text={pendingPlan.body} className="text-xs" />
        </div>
        {feedbackBox('Optional: what should change, if you reject')}
        <div className="mt-3 flex flex-wrap gap-2">
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
          <Button size="sm" variant="ghost" onClick={() => void sync.answerPlan(view.id, planId, false, 'revise')}>
            Revise<Key>e</Key>
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
