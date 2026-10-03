/**
 * One session's client-side state, folded from the server's wire events with
 * the shared protocol logic (`EventBuffer` + `foldReducer`) so the web view and
 * the TUI agree on what a transcript looks like (docs/web.md, "Events").
 *
 * `SessionModel` is plain TS, no React: the sync layer feeds it events as they
 * arrive and pulls `state` once per animation frame. Deltas only touch the
 * mutable `EventBuffer`; the `live` snapshot is copied out lazily in `state`,
 * so a burst of 30 frames costs one allocation, not 30. Committed entries are
 * never recreated, so memoised rows keep their object identity.
 */

import type { AgentStopReason, ContextSnapshot, ReasoningEffort } from '@harness-code/core';
import {
  EventBuffer,
  appendOutput,
  applySubagentEvent,
  entriesFromTranscript,
  foldProcesses,
  foldReducer,
  initialFoldState,
  settleChildren,
} from '@harness-code/protocol';
import type {
  FoldAction,
  FoldState,
  QueuedMessage,
  SessionProcess,
  SessionSnapshot,
  SessionWorktree,
  ToolItem,
  WireEvent,
} from '@harness-code/protocol';

// `entriesFromTranscript` now lives in `@harness-code/protocol` (shared with the
// TUI); re-exported here so existing importers of this module keep working.
export { entriesFromTranscript };

export interface SessionViewState extends FoldState {
  id: string;
  /** The project the session runs in. */
  workspaceId?: string;
  /** The git worktree it works in, apart from the project's checkout. */
  worktree?: SessionWorktree;
  running: boolean;
  /** The model's effort levels, Faster→Smarter; empty without reasoning (no picker). */
  effortLevels: readonly ReasoningEffort[];
  /** True while `session.open` is hydrating a disk session after `session.preview`. */
  hydrating: boolean;
  /** Ids of the pending requests, for `ask.answer` / `plan.answer`. */
  askId: string | null;
  planId: string | null;
  /** Messages waiting for the run to end, oldest first. */
  queue: readonly QueuedMessage[];
  /** Commands it started in the background, oldest first, each with the tail of what it printed. */
  processes?: readonly SessionProcess[];
}

/** Fields to set on a card; `undefined` removes one. */
type ToolPatch = { [K in keyof ToolItem]?: ToolItem[K] | undefined };

const STOP_NOTICES: Partial<Record<AgentStopReason, string>> = {
  aborted: 'Interrupted.',
  max_turns: 'Stopped: turn limit reached.',
  max_cost: 'Stopped: cost budget reached.',
  max_tokens: 'Stopped: output token limit reached.',
  content_filter: 'Stopped by the provider content filter.',
  context_limit: 'Stopped: context window full.',
};

export class SessionModel {
  #buffer = new EventBuffer();
  #state: SessionViewState;
  #liveDirty = false;
  #lastSeq: number;
  #epoch: string | undefined;

  constructor(snapshot: SessionSnapshot, opts: { hydrating?: boolean } = {}) {
    this.#state = stateFromSnapshot(snapshot, opts);
    this.#lastSeq = snapshot.lastSeq;
    this.#epoch = snapshot.epoch;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** The live host `lastSeq` counts in; undefined for a disk-only preview. */
  get epoch(): string | undefined {
    return this.#epoch;
  }

  /** Current view state; the live region is materialised here, at most once per change. */
  get state(): SessionViewState {
    if (this.#liveDirty) {
      this.#liveDirty = false;
      this.#dispatch({ type: 'FLUSH', live: this.#buffer.snapshot() });
    }
    return this.#state;
  }

  /** Replace everything with a server snapshot (first open, or a `reset` on resubscribe). */
  reset(snapshot: SessionSnapshot, opts: { hydrating?: boolean } = {}): void {
    this.#buffer.reset();
    this.#liveDirty = false;
    this.#state = stateFromSnapshot(snapshot, opts);
    this.#lastSeq = snapshot.lastSeq;
    this.#epoch = snapshot.epoch;
  }

  setHydrating(hydrating: boolean): void {
    this.#state = { ...this.#state, hydrating };
  }

  /** Fold one event. Returns false when it was a duplicate (`seq <= lastSeq`) and was dropped. */
  apply(seq: number, event: WireEvent): boolean {
    if (seq <= this.#lastSeq) return false;
    this.#lastSeq = seq;

    switch (event.type) {
      case 'tool_call_start':
        // Opened mid-run: the assistant message (tool_use included) is
        // recorded before its permission ask, but `tool_call_start` only fires
        // once the ask is answered — so the card may already be in the
        // snapshot. Update it there rather than adding a second card.
        if (this.#patchCommittedTool(event.id, () => ({ running: true }))) return true;
        this.#buffer.onEvent(event);
        this.#liveDirty = true;
        return true;
      case 'tool_call_output':
        if (!this.#buffer.snapshot().tools.some((t) => t.id === event.id)) {
          this.#patchCommittedTool(event.id, (t) => (t.running ? { output: appendOutput(t.output, event.text) } : {}));
          return true;
        }
        this.#buffer.onEvent(event);
        this.#liveDirty = true;
        return true;
      case 'subagent_event':
        if (!this.#buffer.snapshot().tools.some((t) => t.id === event.id)) {
          this.#patchCommittedTool(event.id, (t) =>
            t.running ? { children: applySubagentEvent(t.children, event.event) } : {},
          );
          return true;
        }
        this.#buffer.onEvent(event);
        this.#liveDirty = true;
        return true;
      case 'tool_call_end':
        if (!this.#buffer.snapshot().tools.some((t) => t.id === event.id)) {
          this.#patchCommittedTool(event.id, (t) => ({
            running: false,
            result: event.result,
            output: undefined,
            children: settleChildren(t.children),
            ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          }));
          return true;
        }
        this.#buffer.onEvent(event);
        this.#liveDirty = true;
        this.#commitCompletedBatch();
        return true;
      case 'text_delta':
      case 'thinking_delta':
      case 'turn_retry':
        this.#buffer.onEvent(event);
        this.#liveDirty = true;
        this.#commitCompletedBatch();
        return true;
      case 'context': {
        this.#buffer.onEvent(event);
        const context: ContextSnapshot = {
          usedTokens: event.usedTokens,
          windowTokens: event.windowTokens,
          ratio: event.ratio,
          breakdown: event.breakdown,
        };
        this.#state = { ...this.#state, context };
        return true;
      }
      case 'turn_end':
      case 'stop':
      case 'compaction':
        // `run_end` carries the session totals; compaction also arrives as a
        // `notice` (kind 'compaction'), which is what renders the divider.
        return true;
      case 'notice':
        this.#dispatch({ type: 'NOTICE', notice: event.notice });
        return true;
      case 'process_start':
      case 'process_output':
      case 'process_end':
        // Background commands run on between runs: their own list, not the transcript.
        this.#state = { ...this.#state, processes: foldProcesses(this.#state.processes ?? [], event) };
        return true;
      case 'rewound':
        // The conversation was taken back: start over from the transcript as it stands.
        this.#buffer.reset();
        this.#liveDirty = false;
        this.#state = { ...this.#state, entries: entriesFromTranscript(event.transcript), live: this.#buffer.snapshot() };
        return true;
      case 'user_input':
        // A message sent mid-run was read here: after the step that just finished.
        this.#dispatch({ type: 'COMMIT_LIVE', live: this.#takeLive() });
        this.#dispatch({
          type: 'USER',
          text: event.text,
          ...(event.attachments ? { attachments: event.attachments } : {}),
          ...(event.images ? { images: event.images } : {}),
        });
        return true;
      case 'run_start':
        this.#buffer.reset();
        this.#liveDirty = false;
        this.#dispatch({
          type: 'USER',
          text: event.input,
          ...(event.attachments ? { attachments: event.attachments } : {}),
          ...(event.images ? { images: event.images } : {}),
        });
        this.#state = { ...this.#state, running: true };
        return true;
      case 'run_end': {
        this.#endRun();
        this.#dispatch({ type: 'TURN_END', live: this.#takeLive(), usage: event.sessionUsage });
        const stop = STOP_NOTICES[event.stopReason];
        if (stop) this.#dispatch({ type: 'NOTICE', notice: { kind: 'error', level: 'warn', text: stop } });
        return true;
      }
      case 'run_error':
        this.#endRun();
        this.#dispatch({ type: 'TURN_END', live: this.#takeLive() });
        this.#dispatch({ type: 'NOTICE', notice: { kind: 'error', level: 'error', text: event.message } });
        return true;
      case 'ask':
        this.#dispatch({
          type: 'PENDING_ASK',
          ask: {
            toolName: event.toolName,
            input: event.input,
            reason: event.reason,
            ...(event.forcedByRule ? { forcedByRule: true } : {}),
            ...(event.alwaysAllow ? { alwaysAllow: event.alwaysAllow } : {}),
            ...(event.before !== undefined ? { before: event.before } : {}),
          },
        });
        this.#state = { ...this.#state, askId: event.askId };
        return true;
      case 'plan':
        this.#dispatch({
          type: 'PENDING_PLAN',
          plan: {
            title: event.title,
            body: event.body,
            ...(event.yesMode ? { yesMode: event.yesMode } : {}),
          },
        });
        this.#state = { ...this.#state, planId: event.planId };
        return true;
      case 'resolved':
        if (event.requestId === this.#state.askId) {
          this.#dispatch({ type: 'RESOLVE_ASK' });
          this.#state = { ...this.#state, askId: null };
        } else if (event.requestId === this.#state.planId) {
          this.#dispatch({ type: 'RESOLVE_PLAN' });
          this.#state = { ...this.#state, planId: null };
        }
        return true;
      case 'queue':
        this.#state = { ...this.#state, queue: event.queue };
        return true;
      case 'mode':
        this.#dispatch({ type: 'SET_MODE', mode: event.mode });
        return true;
      case 'effort':
        this.#dispatch({ type: 'SET_EFFORT', effort: event.effort });
        return true;
      case 'model':
        this.#dispatch({
          type: 'SET_MODEL',
          modelRef: event.modelRef,
          ...(event.effort ? { effort: event.effort } : {}),
          ...(event.context ? { context: event.context } : {}),
        });
        this.#state = { ...this.#state, effortLevels: event.effortLevels };
        return true;
    }
  }

  /** Update a tool card that is already committed; false if no entry has it. */
  /** Update a card already committed (it came with the snapshot); false when there is none. */
  #patchCommittedTool(id: string, patch: (tool: ToolItem) => ToolPatch): boolean {
    const entries = this.#state.entries;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.kind !== 'assistant' || !e.tools.some((t) => t.id === id)) continue;
      const tools = e.tools.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t, ...patch(t) } as ToolItem;
        // `undefined` in a patch removes the field (exactOptionalPropertyTypes).
        for (const k of Object.keys(next) as Array<keyof ToolItem>) if (next[k] === undefined) delete next[k];
        return next;
      });
      const next = [...entries];
      next[i] = { ...e, tools };
      this.#state = { ...this.#state, entries: next };
      return true;
    }
    return false;
  }

  #commitCompletedBatch(): void {
    const batch = this.#buffer.takeCompletedBatch();
    if (batch) {
      this.#liveDirty = false;
      this.#dispatch({ type: 'COMMIT_LIVE', live: batch });
    }
  }

  #takeLive() {
    const live = this.#buffer.snapshot();
    this.#buffer.reset();
    this.#liveDirty = false;
    return live;
  }

  #endRun(): void {
    // A finished run can't still be waiting on the user.
    this.#state = { ...this.#state, running: false, pendingAsk: null, pendingPlan: null, askId: null, planId: null };
  }

  #dispatch(action: FoldAction): void {
    const { id, workspaceId, running, hydrating, askId, planId, effortLevels, queue } = this.#state;
    this.#state = {
      ...foldReducer(this.#state, action),
      id,
      ...(workspaceId ? { workspaceId } : {}),
      running,
      hydrating,
      askId,
      planId,
      effortLevels,
      queue,
    };
  }
}

export function stateFromSnapshot(
  s: SessionSnapshot,
  opts: { hydrating?: boolean } = {},
): SessionViewState {
  const base = initialFoldState({ mode: s.mode, modelRef: s.modelRef, ...(s.effort ? { effort: s.effort } : {}) });
  return {
    ...base,
    entries: entriesFromTranscript(s.transcript),
    ...(s.usage ? { usage: s.usage } : {}),
    ...(s.context ? { context: s.context } : {}),
    pendingAsk: s.pendingAsk
      ? {
          toolName: s.pendingAsk.toolName,
          input: s.pendingAsk.input,
          reason: s.pendingAsk.reason,
          ...(s.pendingAsk.forcedByRule ? { forcedByRule: true } : {}),
          ...(s.pendingAsk.alwaysAllow ? { alwaysAllow: s.pendingAsk.alwaysAllow } : {}),
          ...(s.pendingAsk.before !== undefined ? { before: s.pendingAsk.before } : {}),
        }
      : null,
    pendingPlan: s.pendingPlan
      ? {
          title: s.pendingPlan.title,
          body: s.pendingPlan.body,
          ...(s.pendingPlan.yesMode ? { yesMode: s.pendingPlan.yesMode } : {}),
        }
      : null,
    id: s.id,
    ...(s.workspaceId ? { workspaceId: s.workspaceId } : {}),
    ...(s.worktree ? { worktree: s.worktree } : {}),
    running: s.running,
    effortLevels: s.effortLevels ?? [],
    hydrating: opts.hydrating ?? false,
    askId: s.pendingAsk?.askId ?? null,
    planId: s.pendingPlan?.planId ?? null,
    queue: s.queue ?? [],
    ...(s.processes ? { processes: s.processes } : {}),
  };
}
