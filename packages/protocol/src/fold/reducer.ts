/**
 * Shared (Ink/React-free) session fold: given a stream of coalesced agent
 * events, what does the transcript look like? Moved out of `packages/tui` so
 * the TUI and the web frontend fold events identically — see docs/web.md,
 * "Events": "Clients fold events with the same logic as EventBuffer."
 *
 * Frontend-only concerns are deliberately NOT here. `packages/tui/src/
 * state/reducer.ts` wraps `FoldState`/`foldReducer` with its own fields
 * (`overlay`, `expandedOutput`, `cwd`) and actions instead of forking this
 * logic; the web frontend will do the same.
 */

import type {
  AgentEvent,
  ContextSnapshot,
  Notice,
  PermissionMode,
  ReasoningEffort,
  ToolResult,
  Usage,
} from '@harness-code/core';

export interface ToolItem {
  id: string;
  name: string;
  input: unknown;
  running: boolean;
  result?: ToolResult;
  /**
   * What the tool has printed so far, while it runs (`tool_call_output`) — the
   * last `LIVE_OUTPUT_CHARS` of it. Dropped once the result arrives.
   */
  output?: string;
  /** How long it ran; known only for calls that finished while being watched. */
  durationMs?: number;
  /**
   * The calls of the sub-agent a `task` runs (`subagent_event`), in order.
   * Live only: a transcript read back from disk doesn't have them.
   */
  children?: ToolItem[];
}

/**
 * `children` with a sub-agent call started or ended — a new array, with a new
 * object for the call that changed, so memoised views notice.
 */
export function applySubagentEvent(
  children: readonly ToolItem[] | undefined,
  event: Extract<AgentEvent, { type: 'subagent_event' }>['event'],
): ToolItem[] {
  const list = children ?? [];
  if (event.type === 'tool_call_start') {
    return [...list, { id: event.id, name: event.name, input: event.input, running: true }];
  }
  return list.map((c) =>
    c.id === event.id
      ? { ...c, running: false, result: event.result, ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}) }
      : c,
  );
}

/** A finished `task`'s calls: any the sub-agent left running were stopped with it. */
export function settleChildren(children: readonly ToolItem[] | undefined): ToolItem[] | undefined {
  if (!children?.some((c) => c.running)) return children ? [...children] : undefined;
  return children.map((c) => (c.running ? { ...c, running: false } : c));
}

/** How much of a running tool's output a frontend keeps: the tail is what matters. */
export const LIVE_OUTPUT_CHARS = 32_000;

/**
 * `output` with `text` appended, cut to its last `LIVE_OUTPUT_CHARS` — from a
 * line start when one is near, and marked so the cut shows.
 */
export function appendOutput(output: string | undefined, text: string): string {
  const next = (output ?? '') + text;
  if (next.length <= LIVE_OUTPUT_CHARS) return next;
  let tail = next.slice(-LIVE_OUTPUT_CHARS);
  const nl = tail.indexOf('\n');
  if (nl !== -1 && nl < 1_000) tail = tail.slice(nl + 1);
  return `…\n${tail}`;
}

export interface LiveSnapshot {
  thinking: string;
  text: string;
  tools: ToolItem[];
}

export type Entry =
  | {
      kind: 'user';
      id: number;
      text: string;
      /** Workspace files attached to the message (read into it ahead of the text). */
      attachments?: string[];
    }
  | { kind: 'assistant'; id: number; thinking: string; text: string; tools: ToolItem[] }
  | { kind: 'notice'; id: number; notice: Notice };

export interface PendingAsk {
  toolName: string;
  input: unknown;
  reason: string;
  forcedByRule?: boolean;
  /** What "always allow" would cover ("`npm test` commands"); absent when it isn't offered. */
  alwaysAllow?: string;
}

export interface PendingPlan {
  title: string;
  body: string;
  /** Mode approving switches to (the session's resolved planApprovedMode). */
  yesMode?: PermissionMode;
}

export interface FoldState {
  entries: Entry[];
  live: LiveSnapshot;
  usage?: Usage;
  context?: ContextSnapshot;
  mode: PermissionMode;
  /** Reasoning-effort level; absent when the model has no reasoning channel. */
  effort?: ReasoningEffort;
  modelRef: string;
  pendingAsk: PendingAsk | null;
  pendingPlan: PendingPlan | null;
}

export type FoldAction =
  | { type: 'FLUSH'; live: LiveSnapshot }
  | {
      /** Commit the in-flight agentic step to the transcript and clear live. */
      type: 'COMMIT_LIVE';
      live: LiveSnapshot;
    }
  | { type: 'TURN_END'; live: LiveSnapshot; usage?: Usage; context?: ContextSnapshot }
  | { type: 'NOTICE'; notice: Notice }
  | { type: 'USER'; text: string; attachments?: string[] }
  | { type: 'SET_MODE'; mode: PermissionMode }
  | { type: 'SET_EFFORT'; effort: ReasoningEffort }
  /** A model switch: the effort goes with it (absent: none), and the meter when given. */
  | { type: 'SET_MODEL'; modelRef: string; effort?: ReasoningEffort; context?: ContextSnapshot }
  | { type: 'PENDING_ASK'; ask: PendingAsk }
  | { type: 'RESOLVE_ASK' }
  | { type: 'PENDING_PLAN'; plan: PendingPlan }
  | { type: 'RESOLVE_PLAN' }
  | { type: 'NEW_SESSION' }
  | {
      /**
       * Replace the whole transcript at once — used when a frontend switches to
       * a different (e.g. resumed) session and rebuilds `entries` from its
       * persisted history via `entriesFromTranscript`. Clears the live region
       * and any pending ask/plan; sets usage/context/mode when supplied.
       */
      type: 'HYDRATE';
      entries: Entry[];
      usage?: Usage;
      context?: ContextSnapshot;
      mode?: PermissionMode;
      effort?: ReasoningEffort;
    };

export function emptyLive(): LiveSnapshot {
  return { thinking: '', text: '', tools: [] };
}

export function initialFoldState(opts: {
  mode: PermissionMode;
  modelRef: string;
  effort?: ReasoningEffort;
}): FoldState {
  return {
    entries: [],
    live: emptyLive(),
    mode: opts.mode,
    modelRef: opts.modelRef,
    pendingAsk: null,
    pendingPlan: null,
    ...(opts.effort ? { effort: opts.effort } : {}),
  };
}

export function foldReducer(state: FoldState, action: FoldAction): FoldState {
  switch (action.type) {
    case 'FLUSH':
      return { ...state, live: action.live };
    case 'COMMIT_LIVE': {
      const entries = commitLive(state.entries, action.live);
      return { ...state, entries, live: emptyLive() };
    }
    case 'TURN_END': {
      const entries = commitLive(state.entries, action.live);
      return {
        ...state,
        entries,
        live: emptyLive(),
        ...(action.usage ? { usage: action.usage } : {}),
        ...(action.context ? { context: action.context } : {}),
      };
    }
    case 'NOTICE':
      return {
        ...state,
        entries: [...state.entries, { kind: 'notice', id: state.entries.length, notice: action.notice }],
      };
    case 'USER':
      return {
        ...state,
        entries: [
          ...state.entries,
          {
            kind: 'user',
            id: state.entries.length,
            text: action.text,
            ...(action.attachments?.length ? { attachments: action.attachments } : {}),
          },
        ],
      };
    case 'SET_MODE':
      return { ...state, mode: action.mode };
    case 'SET_EFFORT':
      return { ...state, effort: action.effort };
    case 'SET_MODEL': {
      const { effort: _dropped, ...rest } = state;
      return {
        ...rest,
        modelRef: action.modelRef,
        ...(action.effort ? { effort: action.effort } : {}),
        ...(action.context ? { context: action.context } : {}),
      };
    }
    case 'PENDING_ASK':
      return { ...state, pendingAsk: action.ask };
    case 'RESOLVE_ASK':
      return { ...state, pendingAsk: null };
    case 'PENDING_PLAN':
      return { ...state, pendingPlan: action.plan };
    case 'RESOLVE_PLAN':
      return { ...state, pendingPlan: null };
    case 'NEW_SESSION':
      return initialFoldState({ mode: state.mode, modelRef: state.modelRef });
    case 'HYDRATE':
      return {
        ...state,
        entries: action.entries,
        live: emptyLive(),
        pendingAsk: null,
        pendingPlan: null,
        ...(action.usage ? { usage: action.usage } : {}),
        ...(action.context ? { context: action.context } : {}),
        ...(action.mode ? { mode: action.mode } : {}),
        ...(action.effort ? { effort: action.effort } : {}),
      };
  }
}

function commitLive(entries: Entry[], live: LiveSnapshot): Entry[] {
  if (live.thinking === '' && live.text === '' && live.tools.length === 0) return entries;
  return [
    ...entries,
    {
      kind: 'assistant',
      id: entries.length,
      thinking: live.thinking,
      text: live.text,
      tools: live.tools,
    },
  ];
}
