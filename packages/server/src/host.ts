/**
 * `SessionHost` — one live `AgentSession` wrapped for many network clients.
 *
 * It is the server-side analogue of the TUI's `UiStore` (`packages/tui/src/
 * state/bridges.ts`), rewritten for N sockets instead of one terminal:
 *
 *  - **Event log.** Every wire event gets a per-session monotonic `seq` and is
 *    kept in a bounded ring buffer so a reconnecting client can replay the gap.
 *  - **Delta coalescing.** Consecutive `text_delta` / `thinking_delta` are
 *    buffered and flushed as one event every ~30 ms, and immediately before any
 *    non-delta event — the same rule as `packages/protocol`'s `EventBuffer`,
 *    moved to the server so every socket sees ~30 frames/s. A running tool's
 *    `tool_call_output` coalesces the same way, keeping only the tail of a
 *    burst too big to be worth sending.
 *  - **Busy flag and queue.** One run at a time: a message sent while one is
 *    going waits in a queue every client sees, and goes when the run ends.
 *    Abort empties the queue, handing its messages back to the caller.
 *  - **Run lifecycle.** `run_start` / `run_end` / `run_error` bracket each run.
 *  - **Pending ask/plan.** Live on the host, not the socket, so a reload
 *    mid-prompt shows the prompt again; the first answer wins and every client
 *    gets `resolved`; abort settles a pending ask/plan as a deny. Parallel
 *    tool calls ask concurrently; those asks queue and are shown one at a time.
 *  - **Slash handling.** `/compact`, `/plan`, and MCP prompts are resolved
 *    server-side so every client behaves the same.
 */

import { randomUUID } from 'node:crypto';

import type {
  AgentEvent,
  AgentSession,
  AgentStopReason,
  Notice,
  PermissionDecision,
  PermissionMode,
  ReasoningEffort,
  SlashCommandInfo,
  Usage,
} from '@harness-code/core';
import { AttachmentError, alwaysAllowFor, loadTranscript, sessionTitleFrom, updateSessionMeta } from '@harness-code/core';
import type { AlwaysAllow, SessionMetaPatch } from '@harness-code/core';
import type {
  QueuedMessage,
  SendResult,
  ServerFrame,
  SessionSnapshot,
  SkillInfo,
  WireEvent,
} from '@harness-code/protocol';

/** The current run's events plus enough history to serve a reconnect gap. */
const RING_CAPACITY = 5000;
/** Delta flush cadence — coalesce deltas into ~30 frames/s. */
const COALESCE_MS = 30;
/**
 * Most of one flush of tool output that is sent; a command printing faster
 * than this has its burst cut to the tail (a client keeps only the tail anyway).
 */
const OUTPUT_BURST_CHARS = 16_000;

/** A run of same-kind deltas awaiting flush: model text, or one tool's output. */
type Coalesced =
  | { type: 'text_delta' | 'thinking_delta'; text: string }
  | { type: 'tool_call_output'; id: string; text: string };
/** Wire events after which the session's list row (running / pending / title) may differ. */
const SUMMARY_EVENTS: ReadonlySet<WireEvent['type']> = new Set([
  'run_start',
  'run_end',
  'run_error',
  'ask',
  'plan',
  'resolved',
]);

/** Thrown by `send` when a run is already active. The WS layer maps it to `busy`. */
export class BusyError extends Error {
  constructor(message = 'a run is already active for this session') {
    super(message);
    this.name = 'BusyError';
  }
}

/** Thrown for a request the session can't honour as asked. The WS layer maps it to `bad_request`. */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

/** Thrown when an RPC names a session that has no live host. The WS layer maps it to `not_found`. */
export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`no live session "${id}"`);
    this.name = 'SessionNotFoundError';
  }
}

interface RingEntry {
  seq: number;
  frame: ServerFrame;
}

interface PendingAsk {
  askId: string;
  toolName: string;
  input: unknown;
  reason: string;
  forcedByRule?: boolean;
  /** What "always allow" adds and how it reads; absent when it isn't offered. */
  always?: AlwaysAllow;
  resolve: (decision: PermissionDecision) => void;
}

interface PendingPlan {
  planId: string;
  title: string;
  body: string;
  yesMode: PermissionMode;
  resolve: (result: { approved: boolean; feedback?: string; mode?: PermissionMode }) => void;
}

/** A subscriber's frame sink. Registered on `subscribe`, dropped on disconnect. */
export type Listener = (frame: ServerFrame) => void;

export class SessionHost {
  /** Assigned after `attach`. */
  id = '';
  /** This host instance: a session resumed after its host closed gets a new epoch, and `seq` restarts. */
  readonly epoch = randomUUID();

  readonly #agentDir: string;
  readonly #cwd: string | undefined;
  readonly #workspaceId: string | undefined;
  readonly #onSummaryChange: (() => void) | undefined;
  #session: AgentSession | undefined;
  /** The first message sent here — the list title until the log has one. */
  #firstInput: string | undefined;
  #modelRef = '';
  /** Last mode broadcast (or snapshotted) — `mode` events fire only on change. */
  #lastMode: PermissionMode | undefined;
  /** Likewise for effort. */
  #lastEffort: ReasoningEffort | undefined;
  /**
   * The metadata sidecar is written in full when this host's first run starts
   * (a session nobody sent anything to has no transcript and gets none) and
   * patched on every mode/effort change once it exists.
   */
  #metaExists: boolean;
  #metaSynced = false;
  /** The latest sidecar write; `close` waits for it so shutdown never tears one. */
  #metaWrite: Promise<unknown> = Promise.resolve();

  #seq = 0;
  readonly #ring: RingEntry[] = [];
  readonly #listeners = new Set<Listener>();

  #busy = false;
  /** Set by `close`: a run ending then sends nothing more. */
  #closing = false;
  /** Messages sent while a run was going, oldest first; the next goes when the run ends. */
  readonly #queue: QueuedMessage[] = [];
  #currentRunId: string | undefined;
  /** Settles when the current run (if any) has fully wound down. */
  #runDone: Promise<void> = Promise.resolve();
  /**
   * The current run's abort signal, handed to `runTurn`. The session's own
   * `abort()` only reaches a loop that has started, and `runTurn` records the
   * message before starting one — an abort landing in between would be lost.
   */
  #runAbort: AbortController | undefined;
  /** Last event emitted, or last listener gone — what idle eviction measures from. */
  #lastActive = Date.now();

  /**
   * Outstanding permission asks, oldest first. Parallel tool calls ask
   * concurrently, but clients see one at a time: only the head has been
   * announced (`ask` event / snapshot); the next is announced when it settles.
   */
  readonly #asks: PendingAsk[] = [];
  #pendingPlan: PendingPlan | null = null;

  // Delta coalescing buffer: a run of same-kind deltas awaiting flush.
  #pending: Coalesced | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * `hasMeta`: resuming a session whose sidecar exists — patch it from the start.
   * `onSummaryChange`: called after any event that may change the session's list
   * row, so the registry can push the new row to every client.
   */
  constructor(opts: {
    agentDir: string;
    cwd?: string;
    workspaceId?: string;
    hasMeta?: boolean;
    onSummaryChange?: () => void;
  }) {
    this.#agentDir = opts.agentDir;
    this.#cwd = opts.cwd;
    this.#workspaceId = opts.workspaceId;
    this.#metaExists = opts.hasMeta === true;
    this.#onSummaryChange = opts.onSummaryChange;
  }

  /** Wire the live session in. Called once, right after `AgentSession.create`. */
  attach(session: AgentSession, modelRef: string): void {
    this.#session = session;
    this.#lastMode = session.mode;
    this.#lastEffort = session.effort;
    this.id = session.id;
    this.#modelRef = modelRef;
    // Startup notices (skills, MCP, session-start…) are emitted while
    // `AgentSession.create` runs — before the id is known — so their frames
    // were stamped with an empty sessionId. Backfill it so a replay from seq 0
    // routes them to the right session.
    for (const entry of this.#ring) {
      if (entry.frame.t === 'evt' && entry.frame.sessionId === '') {
        entry.frame = { ...entry.frame, sessionId: this.id };
      }
    }
  }

  #requireSession(): AgentSession {
    if (!this.#session) throw new Error('SessionHost has no session attached');
    return this.#session;
  }

  // -- state accessors (for SessionRegistry.list) ---------------------------

  get running(): boolean {
    return this.#busy;
  }

  /** The ask clients currently see — the head of the queue. */
  get #pendingAsk(): PendingAsk | null {
    return this.#asks[0] ?? null;
  }

  get pending(): boolean {
    return this.#pendingAsk !== null || this.#pendingPlan !== null;
  }

  get lastSeq(): number {
    return this.#seq;
  }

  /** Sockets subscribed right now. */
  get listenerCount(): number {
    return this.#listeners.size;
  }

  /** Ms since this host last emitted an event or lost its last subscriber. */
  idleFor(now = Date.now()): number {
    return now - this.#lastActive;
  }

  /** A title from the first message sent here, for a session whose log has none yet. */
  get title(): string | undefined {
    return this.#firstInput === undefined ? undefined : sessionTitleFrom(this.#firstInput) || undefined;
  }

  // -- seams handed to AgentSession.create ----------------------------------

  readonly onAgentEvent = (event: AgentEvent): void => {
    if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'tool_call_output') {
      this.#bufferDelta(event);
      return;
    }
    // Any non-delta event flushes the coalesced run first, preserving order.
    this.#emit(event);
  };

  readonly onNotice = (notice: Notice): void => {
    this.#emit({ type: 'notice', notice });
    // The session changes mode on its own too (plan approval → acceptEdits),
    // announcing it only as a notice: turn that into the `mode` event clients
    // key their mode picker on.
    if (notice.kind === 'mode-changed') this.#syncMode();
    if (notice.kind === 'effort-changed') this.#syncEffort();
  };

  /** Broadcast the session's current mode if it differs from the last one sent. */
  #syncMode(): void {
    const mode = this.#session?.mode;
    if (mode === undefined || mode === this.#lastMode) return;
    this.#lastMode = mode;
    this.#emit({ type: 'mode', mode });
    this.#patchMeta({ mode });
  }

  /** Broadcast (and record) the session's effort if it differs from the last one sent. */
  #syncEffort(): void {
    const effort = this.#session?.effort;
    if (effort === undefined || effort === this.#lastEffort) return;
    this.#lastEffort = effort;
    this.#emit({ type: 'effort', effort });
    this.#patchMeta({ effort });
  }

  /** Write the whole sidecar (this host's first run), stamping `createdAt` if it is new. */
  #writeMeta(): void {
    const session = this.#session;
    if (!session) return;
    this.#metaSynced = true;
    this.#metaExists = true;
    const patch: SessionMetaPatch = { model: this.#modelRef, mode: session.mode };
    if (session.effort) patch.effort = session.effort;
    if (this.#cwd) patch.cwd = this.#cwd;
    this.#trackMeta(updateSessionMeta(this.#agentDir, this.id, patch, { createdAt: Date.now() }));
  }

  #patchMeta(patch: SessionMetaPatch): void {
    if (!this.#metaExists) return; // the first run writes everything
    this.#trackMeta(updateSessionMeta(this.#agentDir, this.id, patch));
  }

  #trackMeta(write: Promise<unknown>): void {
    // Metadata is a convenience (resume defaults, titles): never fail a run over it.
    this.#metaWrite = write.catch(() => {});
  }

  readonly ask = (req: {
    toolName: string;
    input: unknown;
    reason: string;
    forcedByRule?: boolean;
    signal?: AbortSignal;
  }): Promise<PermissionDecision> =>
    new Promise<PermissionDecision>((resolve) => {
      // A run aborted mid-stream can still reach its next tool call (not every
      // provider stops on the signal). Its signal has already fired, so a
      // listener would never hear it: refuse now, or the ask waits forever.
      if (req.signal?.aborted || this.#runAbort?.signal.aborted) {
        resolve({ decision: 'deny', reason: 'Aborted' });
        return;
      }
      const askId = randomUUID();
      const always = alwaysAllowFor(req.toolName, req.input);
      this.#asks.push({
        askId,
        toolName: req.toolName,
        input: req.input,
        reason: req.reason,
        ...(req.forcedByRule ? { forcedByRule: true } : {}),
        ...(always ? { always } : {}),
        resolve,
      });
      if (this.#asks.length === 1) this.#announceAsk();
      req.signal?.addEventListener(
        'abort',
        () => {
          const i = this.#asks.findIndex((a) => a.askId === askId);
          if (i === -1) return; // already settled
          if (i === 0) {
            this.#settleAsk('abort', { decision: 'deny', reason: 'Aborted' });
          } else {
            // Never announced — drop it quietly.
            this.#asks.splice(i, 1)[0]!.resolve({ decision: 'deny', reason: 'Aborted' });
          }
        },
        { once: true },
      );
    });

  readonly confirm = (
    req: { title: string; body: string },
  ): Promise<{ approved: boolean; feedback?: string; mode?: PermissionMode }> =>
    new Promise((resolve) => {
      if (this.#runAbort?.signal.aborted) {
        resolve({ approved: false }); // as with asks: the run is over, nobody is to answer
        return;
      }
      const planId = randomUUID();
      const yesMode = this.#requireSession().planApprovedMode;
      this.#pendingPlan = { planId, title: req.title, body: req.body, yesMode, resolve };
      this.#emit({ type: 'plan', planId, title: req.title, body: req.body, yesMode });
    });

  // -- human-in-the-loop answers --------------------------------------------

  /** First answer wins; a stale/duplicate `askId` is a no-op. */
  answerAsk(askId: string, decision: 'once' | 'always' | 'deny' | 'auto', feedback?: string): void {
    const p = this.#pendingAsk;
    if (!p || p.askId !== askId) return;
    // An `always` the ask didn't offer (an older client) is a plain yes.
    if (decision === 'always') for (const rule of p.always?.rules ?? []) this.#requireSession().engine.addAllowRule(rule);
    if (decision === 'auto') this.setMode('auto');
    const verdict: PermissionDecision =
      decision === 'deny'
        ? { decision: 'deny', reason: feedback ? `User declined: ${feedback}` : 'User declined' }
        : { decision: 'allow' };
    this.#settleAsk('user', verdict);
  }

  answerPlan(planId: string, approved: boolean, feedback?: string, mode?: PermissionMode): void {
    const p = this.#pendingPlan;
    if (!p || p.planId !== planId) return;
    this.#pendingPlan = null;
    p.resolve({
      approved,
      ...(feedback ? { feedback } : {}),
      ...(mode ? { mode } : {}),
    });
    this.#emit({ type: 'resolved', requestId: planId, by: 'user' });
  }

  /** Settle the head ask, then announce the next queued one (if any). */
  #settleAsk(by: 'user' | 'abort', decision: PermissionDecision): void {
    const p = this.#asks.shift();
    if (!p) return;
    p.resolve(decision);
    this.#emit({ type: 'resolved', requestId: p.askId, by });
    this.#announceAsk();
  }

  #announceAsk(): void {
    const head = this.#pendingAsk;
    if (!head) return;
    this.#emit({
      type: 'ask',
      askId: head.askId,
      toolName: head.toolName,
      input: head.input,
      reason: head.reason,
      ...(head.forcedByRule ? { forcedByRule: true } : {}),
      ...(head.always ? { alwaysAllow: head.always.label } : {}),
    });
  }

  // -- control --------------------------------------------------------------

  /**
   * Send a message: start a run for it, or — while one is going — queue it to
   * be sent when that run ends. Attachments the session may not read are
   * refused (`InvalidRequestError`) before either.
   */
  async send(text: string, attachments: readonly string[] = []): Promise<SendResult> {
    if (attachments.length > 0) await this.checkAttachments(attachments);
    if (!this.#busy) return this.run(text, attachments);
    const queued: QueuedMessage = { id: randomUUID(), text, ...(attachments.length > 0 ? { attachments: [...attachments] } : {}) };
    this.#queue.push(queued);
    this.#emitQueue();
    return { queued };
  }

  /** Refuse attachments the session may not read, as a bad request. */
  async checkAttachments(paths: readonly string[]): Promise<void> {
    try {
      await this.#requireSession().checkAttachments(paths);
    } catch (err) {
      if (err instanceof AttachmentError) throw new InvalidRequestError(err.message);
      throw err;
    }
  }

  /** Take a queued message back before it goes; null when it is no longer queued. */
  unqueue(queuedId: string): QueuedMessage | null {
    const i = this.#queue.findIndex((q) => q.id === queuedId);
    if (i === -1) return null;
    const [taken] = this.#queue.splice(i, 1);
    this.#emitQueue();
    return taken ?? null;
  }

  #emitQueue(): void {
    this.#emit({ type: 'queue', queue: this.#queue.map((q) => ({ ...q })) });
  }

  /** A run ended: send the oldest queued message, if any. */
  #sendNext(): void {
    if (this.#closing) return;
    const next = this.#queue.shift();
    if (!next) return;
    this.#emitQueue();
    this.run(next.text, next.attachments);
  }

  /**
   * Start a run for `text`. Returns immediately with the run id; events stream
   * asynchronously and the run is bracketed by `run_start` / `run_end` (or
   * `run_error`). Throws `BusyError` if a run is already active.
   * `attachments` are read into the message (checked by `send`).
   */
  run(text: string, attachments: readonly string[] = []): { runId: string } {
    if (this.#busy) throw new BusyError();
    const runId = randomUUID();
    this.#busy = true;
    this.#currentRunId = runId;
    if (!this.#metaSynced) this.#writeMeta();
    this.#firstInput ??= text;
    this.#emit({ type: 'run_start', runId, input: text, ...(attachments.length > 0 ? { attachments: [...attachments] } : {}) });
    const abort = new AbortController();
    this.#runAbort = abort;
    this.#runDone = this.#execute(runId, text, attachments, abort.signal);
    return { runId };
  }

  async #execute(runId: string, text: string, attachments: readonly string[], signal: AbortSignal): Promise<void> {
    const session = this.#requireSession();
    try {
      const trimmed = text.trim();
      if (trimmed === '/plan') {
        session.setMode('plan');
        this.#syncMode();
        this.#endRun(runId, { stopReason: 'end_turn' });
        return;
      }
      if (trimmed === '/compact') {
        await session.compactNow();
        this.#endRun(runId, { stopReason: 'end_turn' });
        return;
      }
      let effective = text;
      if (trimmed.startsWith('/')) {
        const expanded = await session.expandSlash(trimmed);
        if (expanded === null) {
          this.#emit({ type: 'run_error', runId, message: `unknown command "${trimmed.split(/\s+/)[0]}"` });
          return;
        }
        effective = expanded;
      }
      const result = await session.runTurn(effective, {
        signal,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      this.#endRun(runId, {
        stopReason: result.stopReason,
        usage: result.usage,
      });
    } catch (err) {
      this.#emit({
        type: 'run_error',
        runId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (this.#currentRunId === runId) {
        this.#currentRunId = undefined;
        this.#runAbort = undefined;
      }
      this.#busy = false;
      this.#sendNext();
    }
  }

  #endRun(runId: string, opts: { stopReason: AgentStopReason; usage?: Usage }): void {
    const session = this.#requireSession();
    const emptyUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    this.#emit({
      type: 'run_end',
      runId,
      stopReason: opts.stopReason,
      usage: opts.usage ?? emptyUsage,
      sessionUsage: session.sessionUsage ?? opts.usage ?? emptyUsage,
    });
  }

  /**
   * Abort the in-flight run; settle any pending ask/plan as a deny. Stopping
   * stops what was queued behind it too: those messages are returned (for the
   * composer they came from), not sent.
   */
  abort(): { unqueued: QueuedMessage[] } {
    const unqueued = this.#queue.splice(0);
    if (unqueued.length > 0) this.#emitQueue();
    // Queued asks were never announced: settle them silently, then the head.
    for (const queued of this.#asks.splice(1)) queued.resolve({ decision: 'deny', reason: 'Aborted' });
    if (this.#pendingAsk) this.#settleAsk('abort', { decision: 'deny', reason: 'Aborted' });
    if (this.#pendingPlan) {
      const p = this.#pendingPlan;
      this.#pendingPlan = null;
      p.resolve({ approved: false });
      this.#emit({ type: 'resolved', requestId: p.planId, by: 'abort' });
    }
    this.#runAbort?.abort();
    this.#session?.abort();
    return { unqueued };
  }

  setMode(mode: PermissionMode): void {
    this.#requireSession().setMode(mode);
    this.#syncMode();
  }

  /**
   * Switch the session's model; the next message goes to it. Not while a run
   * is going, and a model that can't be resolved (unknown provider, missing
   * key) is refused. The `model` event carries the effort and meter that come
   * with it.
   */
  setModel(ref: string): void {
    if (this.#busy) throw new BusyError('the session is running; switch models between messages');
    const session = this.#requireSession();
    if (ref === this.#modelRef) return;
    try {
      session.setModel(ref);
    } catch (err) {
      throw new InvalidRequestError(err instanceof Error ? err.message : String(err));
    }
    this.#modelRef = session.modelRef;
    const effort = session.effort;
    const context = session.contextSnapshot;
    this.#emit({
      type: 'model',
      modelRef: this.#modelRef,
      effortLevels: [...session.effortLevels],
      ...(effort ? { effort } : {}),
      ...(context ? { context } : {}),
    });
    this.#patchMeta({ model: this.#modelRef });
  }

  /**
   * Change the reasoning effort for the session's next message. Unlike core's
   * `setEffort` — which silently ignores a model without reasoning and takes
   * any value — an effort the model doesn't offer is refused.
   */
  setEffort(effort: ReasoningEffort): void {
    const session = this.#requireSession();
    const levels = session.effortLevels;
    if (levels.length === 0) throw new InvalidRequestError(`${this.#modelRef} has no reasoning effort to set`);
    if (!levels.includes(effort)) {
      throw new InvalidRequestError(`"${effort}" is not an effort level of ${this.#modelRef} (${levels.join(', ')})`);
    }
    session.setEffort(effort);
    this.#syncEffort();
  }

  /** Compaction replaces the history a running turn is still appending to: not while one runs. */
  async compact(): Promise<{ tokensBefore: number; tokensAfter: number } | null> {
    if (this.#busy) throw new BusyError();
    return this.#requireSession().compactNow();
  }

  slashCommands(): SlashCommandInfo[] {
    return this.#requireSession().listSlashCommands();
  }

  skills(): SkillInfo[] {
    return this.#requireSession().listSkills();
  }

  // -- subscribe / replay ---------------------------------------------------

  addListener(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      if (this.#listeners.delete(listener) && this.#listeners.size === 0) this.#lastActive = Date.now();
    };
  }

  /**
   * True if the ring still covers every event after `sinceSeq`, so the gap can
   * be replayed without a full reset.
   */
  canReplay(sinceSeq: number): boolean {
    if (sinceSeq === this.#seq) return true; // exactly caught up — nothing to replay
    // Client ahead of us: this host was resurrected from disk (its `seq` restarts
    // at 0) while the client still holds a higher `sinceSeq`. It must reset.
    if (sinceSeq > this.#seq) return false;
    const oldest = this.#ring[0];
    if (!oldest) return false; // events were produced but the ring is empty
    return oldest.seq <= sinceSeq + 1;
  }

  /** Buffered frames with `seq > sinceSeq`, oldest first. */
  since(sinceSeq: number): ServerFrame[] {
    return this.#ring.filter((e) => e.seq > sinceSeq).map((e) => e.frame);
  }

  async snapshot(): Promise<SessionSnapshot> {
    const session = this.#requireSession();
    const snapshot: SessionSnapshot = {
      id: this.id,
      modelRef: this.#modelRef,
      mode: session.mode,
      transcript: await this.#loadTranscript(),
      running: this.#busy,
      lastSeq: this.#seq,
      epoch: this.epoch,
      effortLevels: [...session.effortLevels],
    };
    if (this.#workspaceId) snapshot.workspaceId = this.#workspaceId;
    if (session.effort) snapshot.effort = session.effort;
    if (session.sessionUsage) snapshot.usage = session.sessionUsage;
    if (session.contextSnapshot) snapshot.context = session.contextSnapshot;
    if (this.#pendingAsk) {
      snapshot.pendingAsk = {
        askId: this.#pendingAsk.askId,
        toolName: this.#pendingAsk.toolName,
        input: this.#pendingAsk.input,
        reason: this.#pendingAsk.reason,
        ...(this.#pendingAsk.forcedByRule ? { forcedByRule: true } : {}),
        ...(this.#pendingAsk.always ? { alwaysAllow: this.#pendingAsk.always.label } : {}),
      };
    }
    if (this.#queue.length > 0) snapshot.queue = this.#queue.map((q) => ({ ...q }));
    if (this.#pendingPlan) {
      snapshot.pendingPlan = {
        planId: this.#pendingPlan.planId,
        title: this.#pendingPlan.title,
        body: this.#pendingPlan.body,
        yesMode: this.#pendingPlan.yesMode,
      };
    }
    return snapshot;
  }

  async #loadTranscript(): Promise<SessionSnapshot['transcript']> {
    try {
      return await loadTranscript(this.#agentDir, this.id);
    } catch {
      // No on-disk record yet (recorder disabled, or nothing sent) — fall back
      // to the live model history so a fresh session still snapshots cleanly.
      return this.#requireSession().messages.map((message) => ({
        type: 'message' as const,
        ts: 0,
        message,
      }));
    }
  }

  // -- teardown -------------------------------------------------------------

  async close(): Promise<void> {
    this.#closing = true;
    // A run still going would keep using the session after it is torn down:
    // stop it (any prompt settles as a deny) and let it wind down first.
    if (this.#busy) {
      this.abort();
      await this.#runDone;
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = null;
    this.#listeners.clear();
    await this.#session?.close();
    await this.#metaWrite;
  }

  // -- event pipeline -------------------------------------------------------

  #bufferDelta(delta: Coalesced): void {
    const pending = this.#pending;
    if (pending && pending.type === delta.type && (pending.type !== 'tool_call_output' || pending.id === (delta as { id: string }).id)) {
      pending.text += delta.text;
    } else {
      // A switch (thinking → text, one tool's output → another's) flushes the previous run first.
      if (pending) this.#flushDeltas();
      this.#pending = { ...delta };
    }
    if (!this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#flushDeltas();
      }, COALESCE_MS);
    }
  }

  #flushDeltas(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    this.#push(
      pending.type === 'tool_call_output'
        ? { type: 'tool_call_output', id: pending.id, text: burstTail(pending.text) }
        : { type: pending.type, text: pending.text },
    );
  }

  /** Emit a non-delta wire event, flushing any coalesced deltas ahead of it. */
  #emit(event: WireEvent): void {
    this.#flushDeltas();
    this.#push(event);
  }

  #push(event: WireEvent): void {
    this.#lastActive = Date.now();
    const seq = ++this.#seq;
    const frame: ServerFrame = { t: 'evt', sessionId: this.id, seq, event };
    this.#ring.push({ seq, frame });
    if (this.#ring.length > RING_CAPACITY) this.#ring.shift();
    for (const listener of this.#listeners) listener(frame);
    if (SUMMARY_EVENTS.has(event.type)) this.#onSummaryChange?.();
  }
}

/** A burst of tool output cut to its last `OUTPUT_BURST_CHARS`, from a line start when one is near. */
function burstTail(text: string): string {
  if (text.length <= OUTPUT_BURST_CHARS) return text;
  let tail = text.slice(-OUTPUT_BURST_CHARS);
  const nl = tail.indexOf('\n');
  if (nl !== -1 && nl < 1_000) tail = tail.slice(nl + 1);
  return `…\n${tail}`;
}
