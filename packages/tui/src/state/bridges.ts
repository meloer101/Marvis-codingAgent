/**
 * Ask / plan bridges as a plain mutable store (no React) — they are *inputs* to
 * `AgentSession.create`, which runs before the app mounts, so they can't be
 * hooks. The app polls `pendingAsk` / `pendingPlan` / `notices` on its flush
 * loop and routes key presses back through `answerAsk` / `answerPlan`.
 */

import { alwaysAllowFor } from '@harness-code/core';
import type { AskHandler, Notice, PermissionDecision, PermissionMode } from '@harness-code/core';

import type { PendingAsk, PendingPlan } from './reducer.js';

export class UiStore {
  pendingAsk: PendingAsk | null = null;
  pendingPlan: PendingPlan | null = null;
  private notices: Notice[] = [];
  /** The rules "always allow" adds for the pending ask. */
  private askRules: string[] = [];
  private resolveAsk: ((d: PermissionDecision) => void) | null = null;
  private resolvePlan: ((r: { approved: boolean; feedback?: string; mode?: PermissionMode }) => void) | null =
    null;

  constructor(private readonly addAllow: (rule: string) => void) {}

  readonly ask: AskHandler = (req) =>
    new Promise<PermissionDecision>((resolve) => {
      const always = alwaysAllowFor(req.toolName, req.input);
      this.askRules = always?.rules ?? [];
      this.resolveAsk = resolve;
      this.pendingAsk = {
        toolName: req.toolName,
        input: req.input,
        reason: req.reason,
        ...(always ? { alwaysAllow: always.label } : {}),
        ...(req.forcedByRule ? { forcedByRule: true } : {}),
      };
      req.signal?.addEventListener(
        'abort',
        () => {
          if (this.resolveAsk !== resolve) return;
          this.resolveAsk = null;
          this.pendingAsk = null;
          resolve({ decision: 'deny', reason: 'Aborted' });
        },
        { once: true },
      );
    });

  readonly confirm = (req: { title: string; body: string }) =>
    new Promise<{ approved: boolean; feedback?: string; mode?: PermissionMode }>((resolve) => {
      this.resolvePlan = resolve;
      this.pendingPlan = { title: req.title, body: req.body };
    });

  pushNotice(n: Notice): void {
    // A mode or effort switch (Shift+Tab, /effort) is already shown by the
    // status line; a transcript row per switch just piles up.
    if (n.kind === 'mode-changed' || n.kind === 'effort-changed') return;
    this.notices.push(n);
  }

  drainNotices(): Notice[] {
    const out = this.notices;
    this.notices = [];
    return out;
  }

  answerAsk(v: 'once' | 'always' | 'deny', feedback?: string): void {
    const resolve = this.resolveAsk;
    this.resolveAsk = null;
    this.pendingAsk = null;
    if (!resolve) return;
    if (v === 'always') for (const rule of this.askRules) this.addAllow(rule);
    resolve(
      v === 'deny'
        ? { decision: 'deny', reason: feedback ? `User declined: ${feedback}` : 'User declined' }
        : { decision: 'allow' },
    );
  }

  answerPlan(approved: boolean, feedback?: string, mode?: PermissionMode): void {
    const resolve = this.resolvePlan;
    this.resolvePlan = null;
    this.pendingPlan = null;
    resolve?.({
      approved,
      ...(feedback ? { feedback } : {}),
      ...(mode ? { mode } : {}),
    });
  }
}
