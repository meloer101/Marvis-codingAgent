/**
 * The event stream carried by `{ t: 'evt' }` server frames. Verbatim from
 * docs/web.md, "Events". `AgentEvent`, `Notice`, `AgentStopReason`, `Usage`,
 * and `PermissionMode` are `import type`-only from core — never redefined
 * here, so they can't drift from the loop's actual event shapes.
 */

import type {
  AgentEvent,
  AgentStopReason,
  ContextSnapshot,
  ImageInput,
  Notice,
  PermissionMode,
  ReasoningEffort,
  TranscriptItem,
  Usage,
} from '@harness-code/core';

import type { QueuedMessage } from './methods.js';

export type WireEvent =
  // AgentEvent, forwarded verbatim (deltas coalesced by EventBuffer)
  | AgentEvent
  // Notice, forwarded verbatim
  | { type: 'notice'; notice: Notice }
  // run lifecycle — brackets one runTurn()
  | { type: 'run_start'; runId: string; input: string; attachments?: string[]; images?: ImageInput[] }
  | { type: 'run_end'; runId: string; stopReason: AgentStopReason; usage: Usage; sessionUsage: Usage }
  | { type: 'run_error'; runId: string; message: string }
  // human-in-the-loop
  | {
      type: 'ask';
      askId: string;
      toolName: string;
      input: unknown;
      reason: string;
      forcedByRule?: boolean;
      /** What "always allow" would cover; absent when it isn't offered. */
      alwaysAllow?: string;
      /** A `write` over an existing file: the file as it is (text, up to 128 KB), to show what would change. */
      before?: string;
    }
  | { type: 'plan'; planId: string; title: string; body: string; yesMode?: PermissionMode }
  | { type: 'resolved'; requestId: string; by: 'user' | 'abort' }
  /** The conversation was rewound (`session.rewind`): the transcript as it stands now. */
  | { type: 'rewound'; transcript: TranscriptItem[] }
  // state changes not otherwise visible
  /** The messages waiting — for the run to end, or (`steer`) its next step — the whole queue, after every change. */
  | { type: 'queue'; queue: QueuedMessage[] }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'effort'; effort: ReasoningEffort }
  /**
   * The model was switched. Carries what changes with it: the effort levels,
   * the effort (absent on a model without reasoning) and the context meter
   * read against the new window.
   */
  | {
      type: 'model';
      modelRef: string;
      effortLevels: ReasoningEffort[];
      effort?: ReasoningEffort;
      context?: ContextSnapshot;
    };
