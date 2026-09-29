/**
 * Terminal prompting for permission `ask` verdicts (and, in Step 3, plan
 * approval).
 *
 * Two problems this exists to solve:
 *
 *  - **Serialization.** `runToolCalls` collects every permission decision for a
 *    turn with `Promise.all`, so two tools needing approval in one turn would
 *    fire two `rl.question()` calls at once and race for the same line. Every
 *    prompt here is pushed onto one promise chain, the same fix the REPL uses
 *    for its input `queue`.
 *  - **readline ownership.** In REPL mode we borrow the outer `rl`: `rl.question()`
 *    intercepts exactly the next line without emitting `'line'`, so it doesn't
 *    fight the REPL's own handler. One-shot on a TTY has no outer `rl`, so the
 *    prompter makes its own and closes it when done.
 *
 * On a real terminal the choices are the same arrow-key menu the TUI shows
 * (`menu.ts`). Where that can't run — a dumb terminal, a piped stdout — they are
 * the same numbered list, answered by typing the number (or the old y/a/s/n).
 */

import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';

import type { AskHandler, PermissionEngine, PermissionMode, PromptOption } from '@harness-code/core';
import {
  askOptions,
  offerAutoSwitch,
  planOptions,
  toolDisplayName,
} from '@harness-code/core';

import { ESCAPE_TIMEOUT_MS, menuCapable, menuTitle, selectMenu } from './menu.js';
import type { MenuTerminal } from './menu.js';

export type ConfirmChoice = 'once' | 'always' | 'deny' | 'auto';

export interface ConfirmRequest {
  title: string;
  detail: string;
  /** Names the tool in "don't ask again for …", e.g. "Bash". Falls back to a generic phrase. */
  alwaysLabel?: string;
  /** Offer "yes, and switch to auto mode". */
  offerAuto?: boolean;
  signal?: AbortSignal;
}

export interface ConfirmResult {
  choice: ConfirmChoice;
  feedback?: string;
}

export interface ApproveRequest {
  title: string;
  body: string;
  autoAvailable?: boolean;
  yesMode?: PermissionMode;
  signal?: AbortSignal;
}

export interface Prompter {
  confirm(req: ConfirmRequest): Promise<ConfirmResult>;
  /** Show a body of text (a plan) and collect approve / revise-with-feedback. */
  approve(req: ApproveRequest): Promise<{ approved: boolean; feedback?: string; mode?: PermissionMode }>;
  askText(query: string, signal?: AbortSignal): Promise<string>;
  close(): void;
}

class ReadlinePrompter implements Prompter {
  private readonly rl: Interface;
  private readonly owned: boolean;
  /** Where the arrow-key menu runs; undefined = answer by typing at a `> ` prompt. */
  private readonly menuTerminal: MenuTerminal | undefined;
  /** Serializes every prompt so concurrent permission checks queue instead of racing. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(shared?: Interface, terminal?: MenuTerminal) {
    if (shared) {
      this.rl = shared;
      this.owned = false;
    } else {
      this.rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        escapeCodeTimeout: ESCAPE_TIMEOUT_MS,
      });
      this.owned = true;
    }
    // A readline `Interface` is in terminal mode exactly when it sits on a TTY,
    // which is the precondition for taking the keyboard from it.
    const candidate = terminal ?? (this.rl.terminal ? { input: process.stdin, output: process.stdout } : undefined);
    this.menuTerminal = candidate && menuCapable(candidate) ? candidate : undefined;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** One line of input, resolving to '' if the signal fires first. */
  private question(query: string, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve) => {
      if (signal?.aborted) {
        resolve('');
        return;
      }
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        resolve('');
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.rl.question(query, (answer) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(answer);
      });
    });
  }

  /**
   * Show `header`, offer `options`, and return the pick. `null` means cancelled
   * (menu) or aborted; a typed reason rides along as `text`. `fallback` handles
   * the answer typed at a plain `> ` prompt, and returns whether it took the
   * "no" branch (so the caller asks why).
   */
  private async choose<V extends string>(
    header: readonly string[],
    question: string,
    options: readonly PromptOption<V>[],
    signal: AbortSignal | undefined,
    typedAnswer: (raw: string, byNumber: PromptOption<V> | undefined) => V | undefined,
    whyPrompt: string,
  ): Promise<{ value: V; text?: string } | null> {
    if (this.menuTerminal) {
      return selectMenu({
        header: [...header, '', question],
        options,
        ...(signal ? { signal } : {}),
        terminal: this.menuTerminal,
      });
    }

    // Line mode: the same list, numbered. The whole block goes through the query
    // string so it lands on the readline's own output stream, not unconditionally
    // on process.stdout.
    const list = options.map((o, i) => `  ${i + 1}. ${o.label}`);
    const block = [...header, '', question, ...list, '> '].join('\n');
    const raw = (await this.question(block, signal)).trim().toLowerCase();
    if (signal?.aborted) return null;
    const byNumber = /^\d+$/.test(raw) ? options[Number(raw) - 1] : undefined;
    const picked = typedAnswer(raw, byNumber);
    if (picked !== undefined) return { value: picked };

    // Anything else is a "no"; ask why so the model gets a usable reason.
    const no = options.find((o) => o.input) ?? options[options.length - 1]!;
    const text = (await this.question(whyPrompt, signal)).trim();
    return { value: no.value, ...(text ? { text } : {}) };
  }

  confirm(req: ConfirmRequest): Promise<ConfirmResult> {
    return this.enqueue(async () => {
      if (req.signal?.aborted) return { choice: 'deny', feedback: '用户中断' };

      const options = askOptions({
        toolLabel: req.alwaysLabel ?? 'this tool',
        offerAuto: req.offerAuto === true,
      });
      const header = ['', menuTitle(req.title), ...req.detail.split('\n').map((l) => `    ${l}`)];
      const res = await this.choose(
        header,
        'Do you want to proceed?',
        options,
        req.signal,
        (raw, byNumber) => {
          if (byNumber && byNumber.value !== 'deny') return byNumber.value;
          if (raw === 'y' || raw === 'yes') return 'once';
          if (raw === 'a' || raw === 'always') return 'always';
          if (req.offerAuto && (raw === 's' || raw === 'auto')) return 'auto';
          return undefined;
        },
        '  why (optional, Enter to skip): ',
      );
      if (req.signal?.aborted) return { choice: 'deny', feedback: '用户中断' };
      if (!res || res.value === 'deny') {
        return res?.text ? { choice: 'deny', feedback: res.text } : { choice: 'deny' };
      }
      return { choice: res.value };
    });
  }

  approve(req: ApproveRequest): Promise<{ approved: boolean; feedback?: string; mode?: PermissionMode }> {
    return this.enqueue(async () => {
      if (req.signal?.aborted) return { approved: false, feedback: '用户中断' };

      const yesMode = req.yesMode ?? (req.autoAvailable ? 'auto' : 'acceptEdits');
      const header = ['', menuTitle(req.title), ...req.body.split('\n').map((l) => `  ${l}`)];
      const res = await this.choose(
        header,
        'Would you like to proceed?',
        planOptions(yesMode),
        req.signal,
        (raw, byNumber) => {
          if (byNumber && byNumber.value !== 'no') return byNumber.value;
          if (raw === 'y' || raw === 'yes') return 'yes';
          if (raw === 'm' || raw === 'manual') return 'manual';
          return undefined;
        },
        '  what should change (optional): ',
      );
      if (req.signal?.aborted) return { approved: false, feedback: '用户中断' };
      if (res?.value === 'yes') return { approved: true, mode: yesMode };
      if (res?.value === 'manual') return { approved: true, mode: 'ask' };
      return res?.text ? { approved: false, feedback: res.text } : { approved: false };
    });
  }

  askText(query: string, signal?: AbortSignal): Promise<string> {
    return this.enqueue(() => this.question(query, signal));
  }

  close(): void {
    if (this.owned) this.rl.close();
  }
}

/** `terminal` overrides where the arrow-key menu runs (tests); default is the process's own. */
export function createPrompter(shared?: Interface, terminal?: MenuTerminal): Prompter {
  return new ReadlinePrompter(shared, terminal);
}

// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

// Re-exported from core (shared with the TUI's tool cards).
import { describeToolInput } from '@harness-code/core';
export { describeToolInput } from '@harness-code/core';

export interface InteractiveAskOptions {
  /** Called right before a prompt is shown — used to flush a half-open [thinking] block. */
  onBeforePrompt?: () => void;
  /** Echoes the "+ allow X (this session)" confirmation line. */
  echo?: (line: string) => void;
  /** Current permission mode, used to decide whether to offer `[s]`. */
  getMode?: () => PermissionMode;
  /** Whether auto mode can be switched to from this prompt. */
  getAutoAvailable?: () => boolean;
  /** Switch the live session into auto mode after `[s]`. */
  onAuto?: () => void;
}

/**
 * Turn a {@link Prompter} into an {@link AskHandler}: show the call, map the
 * choice, and on "always" append a whole-tool allow rule to the engine so the
 * same tool isn't asked again this session.
 */
export function interactiveAskHandler(
  engine: Pick<PermissionEngine, 'addAllowRule'>,
  prompter: Prompter,
  opts: InteractiveAskOptions = {},
): AskHandler {
  return async ({ toolName, input, reason, forcedByRule, signal }) => {
    opts.onBeforePrompt?.();
    const label = toolDisplayName(toolName);
    const offerAuto = offerAutoSwitch({
      mode: opts.getMode?.() ?? 'ask',
      autoAvailable: opts.getAutoAvailable?.() ?? false,
      toolName,
      ...(forcedByRule ? { forcedByRule: true } : {}),
    });
    const res = await prompter.confirm({
      title: reason.startsWith('mcp__') ? reason : capitalize(reason),
      detail: describeToolInput(toolName, input),
      alwaysLabel: label,
      offerAuto,
      ...(signal ? { signal } : {}),
    });
    if (res.choice === 'once') return { decision: 'allow' };
    if (res.choice === 'always') {
      engine.addAllowRule(label);
      opts.echo?.(`+ allow ${label} (this session)`);
      return { decision: 'allow' };
    }
    if (res.choice === 'auto') {
      opts.onAuto?.();
      return { decision: 'allow' };
    }
    return {
      decision: 'deny',
      reason: res.feedback ? `User declined: ${res.feedback}` : 'User declined this call.',
    };
  };
}
