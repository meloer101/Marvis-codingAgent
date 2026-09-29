/**
 * Headless agent run — the eval-suite counterpart to `hc agent`.
 *
 * `packages/cli/src/index.ts`'s `agent` action assembles a runnable `AgentLoop`
 * from a dozen core primitives, but that assembly is not exported and is welded
 * to the REPL, the MCP hub, the interactive prompter and SIGINT handling. This
 * is the ~one-screen distillation a benchmark run actually needs: a model
 * (replayed from a cassette, or live behind a recorder), the builtin tools, the
 * permission engine, optional compaction, and a telemetry trace to read the
 * numbers back off.
 *
 * Determinism note: the model is fingerprinted on the request, and the request
 * embeds the absolute workspace path (system prompt `environment` segment, and
 * any `grep` output that lands in history). We pin `platform` and hand the
 * replay/record provider a `redactPaths: [workDir]` so a cassette recorded under
 * one temp dir replays under another.
 */

import { execFileSync } from 'node:child_process';

import {
  AGENT_CONVENTIONS,
  AgentLoop,
  ProviderRegistry,
  RecordingProvider,
  ReplayProvider,
  SessionState,
  ToolRegistry,
  buildAgentSystemPrompt,
  builtinTools,
  createCompactor,
  createPermissionEngine,
  createPermissionHooks,
  createTaskTool,
  discoverAgents,
  mergeHooks,
  createVerifyBeforeStopHooks,
  nonInteractiveAskHandler,
  parseModelRef,
  resolveCapabilities,
  runSubagent,
  subagentToolSpecs,
  buildSubagentSystemPrompt,
  exitPlanModeTool,
  systemUpdateSegments,
  addUsage,
  summarizeTrace,
  readTrace,
  TraceRecorder,
  userText,
} from '@harness-code/core';
import type {
  AgentControl,
  AgentRunResult,
  Message,
  ModelCapabilities,
  PermissionMode,
  ReasoningEffort,
  SystemSegment,
  Provider,
  ResolvedModel,
  Settings,
  TraceEvent,
  TraceSummary,
} from '@harness-code/core';

export interface HarnessOptions {
  /** Realpath'd workspace the agent operates in (fixture already materialized). */
  workDir: string;
  prompt: string;
  /** `provider/model`. Capabilities (incl. pricing) are resolved from this even in replay. */
  modelRef: string;
  mode: PermissionMode;
  /** Directory the trace jsonl is written under (`<traceDir>/traces/<traceId>.jsonl`). */
  traceDir: string;
  traceId: string;

  /** Replay from this cassette, or — with `record` — record into it. */
  cassettePath: string;
  /** Live-record mode: hit the real endpoint behind a `RecordingProvider`. */
  record?: boolean;
  /** Hit the real endpoint directly, writing nothing (for one-off ablation measurements). */
  live?: boolean;
  /** Settings for the live provider (keys, base urls). Used when `record` or `live`. */
  settings?: Settings;

  // Ablation knobs -----------------------------------------------------------
  /** Off disables compaction entirely; a number forces the trigger ratio. */
  compaction?: boolean | number;
  /** Shrink the model's context window (to exercise compaction on small tasks). */
  contextWindow?: number;
  /** Per-request output cap (also the window reservation). */
  maxOutputTokens?: number;
  /** Offer the `task` tool (builtin sub-agents). */
  subagents?: boolean;
  /** Force prompt-encoded tool calling instead of native `tools`. */
  promptTools?: boolean;
  /**
   * Override how a mid-session prompt change is delivered, for the
   * `system-update` ablation: `rewrite` edits the head (and drops the cached
   * prefix), `in-history` appends the delta.
   */
  systemPromptUpdate?: 'rewrite' | 'in-history';
  /**
   * Send the model back once to check its work against the task before it
   * ends (`createVerifyBeforeStopHooks`). Off by default so the recorded
   * cassettes replay; the `verify-stop` ablation turns it on.
   */
  verifyBeforeStop?: boolean;

  /**
   * Which run of the task this is. Recording tags the cassette with it and
   * replay serves that run's trajectory, so `runs: 3` replays three recorded
   * trajectories instead of the first one three times.
   */
  runIndex?: number;

  maxTurns?: number;
  /** Reasoning effort; omitted = the model's declared default. */
  reasoningEffort?: ReasoningEffort;
  /**
   * A second user turn, sent after the first run ends. With `mode: 'plan'` this
   * is what makes a task plan-shaped: turn 1 plans and calls `exit_plan_mode`,
   * approval switches the mode, turn 2 implements — the only shape in which a
   * mid-session prompt change and a mode-stable tool list are observable.
   */
  followUp?: string;
  /** Mode an approved plan switches to. Default `acceptEdits`. */
  planApprovedMode?: PermissionMode;
  allow?: string[];
  deny?: string[];
}

export interface HarnessRun {
  result: AgentRunResult;
  trace: TraceSummary;
  /** This run's events only — a trace id reused across passes appends to one file. */
  events: TraceEvent[];
}

const DEFAULT_MAX_TURNS = 30;

/**
 * Normalization applied to a request before it is fingerprinted for the
 * cassette, on top of the workspace-path redaction.
 *
 * Anything a tool leaks into history that differs run to run has to be
 * flattened here, or the request never matches its recording. So far: the
 * `duration_ms` timings in `node --test` output, the timestamped filename
 * `exit_plan_mode` reports after writing a plan, and the mtimes in a directory
 * listing — `ls -l` on a fixture copied minutes ago prints a different time
 * every run.
 */
export function evalKeyScrub(s: string): string {
  return (
    s
      .replace(/duration_ms['":\s]*[\d.]+/g, 'duration_ms 0')
      .replace(/\.agent\/plans\/[^\s"'`]+\.md/g, '.agent/plans/PLAN.md')
      // `ls -l` dates: "Sep 19 06:52" / "Sep  9 2025".
      .replace(/\b[A-Z][a-z]{2}\s{1,2}\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})\b/g, 'Jan  1 00:00')
      // ISO timestamps from `date`, log lines, and similar.
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '1970-01-01T00:00:00Z')
  );
}

/**
 * A replayed run must cost the same at 10am as at midnight, or the baseline's
 * ±15% cost gate fires on the clock rather than on a change. Off-peak rates are
 * therefore dropped for replay, pricing every cassette at the peak (higher)
 * figure; live and recording runs keep the real, time-dependent rates.
 */
function pinnedPricing(
  caps: ModelCapabilities,
  hitsTheEndpoint: boolean,
): Pick<ModelCapabilities, 'pricing'> | Record<string, never> {
  if (hitsTheEndpoint || !caps.pricing?.offPeak) return {};
  const { offPeak: _dropped, ...peak } = caps.pricing;
  return { pricing: peak };
}

export async function runAgentTask(opts: HarnessOptions): Promise<HarnessRun> {
  const { provider: providerId, model } = parseModelRef(opts.modelRef);
  const resolvedCaps = resolveCapabilities(providerId, model, {});
  const capabilities: ModelCapabilities = {
    ...resolvedCaps,
    ...(opts.promptTools ? { nativeTools: false } : {}),
    ...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
    ...(opts.systemPromptUpdate ? { systemPromptUpdate: opts.systemPromptUpdate } : {}),
    ...pinnedPricing(resolvedCaps, Boolean(opts.record || opts.live)),
  };

  let provider: Provider;
  if (opts.record || opts.live) {
    const live = new ProviderRegistry({ settings: opts.settings ?? {} }).resolve(opts.modelRef);
    provider = opts.live
      ? live.provider
      : new RecordingProvider(live.provider, opts.cassettePath, {
          redactPaths: [opts.workDir],
          keyScrub: evalKeyScrub,
          ...(opts.runIndex !== undefined ? { run: opts.runIndex } : {}),
        });
  } else {
    provider = await ReplayProvider.load(opts.cassettePath, {
      redactPaths: [opts.workDir],
      keyScrub: evalKeyScrub,
      ...(opts.runIndex !== undefined ? { run: opts.runIndex } : {}),
    });
  }

  const resolved: ResolvedModel = {
    provider,
    providerId,
    model,
    ref: opts.modelRef,
    capabilities,
  };

  const engine = createPermissionEngine({
    workspaceRoot: opts.workDir,
    mode: opts.mode,
    allow: opts.allow ?? [],
    ask: [],
    deny: opts.deny ?? [],
    // A default `hc` session has auto mode available, and therefore lets
    // read-only shell through in plan mode. Leaving this off measured a
    // configuration nobody runs: the agent burned turns rediscovering that
    // `ls` was refused. Non-read-only bash still ends in a deny here, since
    // no classifier is attached to the eval harness.
    useAutoModeDuringPlan: true,
  });

  const compactionOff = opts.compaction === false;
  const compactHook = compactionOff
    ? undefined
    : {
        onCompact: createCompactor({
          provider: resolved.provider,
          model: resolved.model,
          conventions: AGENT_CONVENTIONS,
        }),
      };
  const hooks = mergeHooks(
    createPermissionHooks(engine, nonInteractiveAskHandler),
    compactHook,
    opts.verifyBeforeStop ? createVerifyBeforeStopHooks() : undefined,
  );

  // `exit_plan_mode` is registered for a plan-shaped task and stays registered
  // after approval — the session behaves the same way, because a tool list that
  // changes with the mode invalidates the cached prefix.
  const planShaped = opts.mode === 'plan' || opts.followUp !== undefined;
  const tools = [...builtinTools(), ...(planShaped ? [exitPlanModeTool] : [])];
  if (opts.subagents) {
    const { agents } = await discoverAgents(opts.workDir);
    if (agents.length > 0) {
      tools.push(
        createTaskTool({
          agents,
          async run(def, subPrompt, runCtx) {
            return runSubagent({
              model: resolved,
              tools: subagentToolSpecs(builtinTools(), def),
              system: buildSubagentSystemPrompt({ cwd: opts.workDir, role: def.body }),
              hooks: mergeHooks(
                createPermissionHooks(
                  createPermissionEngine({
                    workspaceRoot: opts.workDir,
                    mode: engine.getMode(),
                    allow: opts.allow ?? [],
                    ask: [],
                    deny: opts.deny ?? [],
                    useAutoModeDuringPlan: true,
                  }),
                  nonInteractiveAskHandler,
                ),
                compactHook,
              ),
              cwd: opts.workDir,
              prompt: subPrompt,
              ...(def.effort && capabilities.reasoning ? { reasoningEffort: def.effort } : {}),
              ...(runCtx.signal ? { signal: runCtx.signal } : {}),
            });
          },
        }),
      );
    }
  }

  const trace = new TraceRecorder(opts.traceDir, opts.traceId);
  const startedAt = Date.now();
  await trace.append({
    type: 'run_start',
    ts: startedAt,
    sessionId: opts.traceId,
    model: opts.modelRef,
    cwd: opts.workDir,
    mode: opts.mode,
  });

  const session = new SessionState();
  const registry = new ToolRegistry(tools);
  // Approval is scripted: a plan-shaped eval measures what the agent does with
  // the mode change, not whether a human says yes.
  const control: AgentControl = {
    get mode(): PermissionMode {
      return engine.getMode();
    },
    exitPlanMode(mode?: PermissionMode): PermissionMode {
      const next = mode ?? opts.planApprovedMode ?? 'acceptEdits';
      engine.setMode(next);
      return next;
    },
    async confirm(): Promise<{ approved: boolean }> {
      control.exitPlanMode();
      return { approved: true };
    },
  };

  const systemFor = (mode: PermissionMode) =>
    buildAgentSystemPrompt({ cwd: opts.workDir, mode, platform: 'linux' });
  const head = systemFor(opts.mode);

  const runTurn = async (
    messages: Message[],
    system: SystemSegment[],
    systemUpdate: SystemSegment[] | undefined,
  ): Promise<AgentRunResult> =>
    new AgentLoop({
      model: resolved,
      tools: registry,
      cwd: opts.workDir,
      system,
      ...(systemUpdate ? { systemUpdate } : {}),
      session,
      hooks,
      trace,
      ...(planShaped ? { control } : {}),
      maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
      // Effort as the task declares it, else the model's own default — so the
      // baseline reflects a configuration someone actually runs.
      ...(capabilities.reasoning
        ? {
            reasoningEffort:
              opts.reasoningEffort ?? capabilities.defaultEffort ?? ('high' as const),
          }
        : {}),
      ...(typeof opts.compaction === 'number' ? { contextCompactRatio: opts.compaction } : {}),
      ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    }).run(messages);

  let result = await runTurn([userText(opts.prompt)], head, undefined);

  if (opts.followUp !== undefined) {
    // The mode may have changed mid-run (an approved plan). The session does
    // exactly this between user turns: recompute the prompt, then either
    // rewrite the head or send the delta, per the model's capability.
    const current = systemFor(engine.getMode());
    const update =
      capabilities.systemPromptUpdate === 'in-history'
        ? systemUpdateSegments(head, current)
        : undefined;
    const keepHead = capabilities.systemPromptUpdate === 'in-history';
    const second = await runTurn(
      [...result.messages, userText(opts.followUp)],
      keepHead ? head : current,
      update,
    );
    result = {
      messages: second.messages,
      usage: addUsage(result.usage, second.usage),
      stopReason: second.stopReason,
      turns: result.turns + second.turns,
    };
  }

  await trace.append({
    type: 'run_end',
    ts: Date.now(),
    stopReason: result.stopReason,
    turns: result.turns,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cachedInputTokens: result.usage.cachedInputTokens,
    ...(result.usage.costUSD !== undefined ? { costUSD: result.usage.costUSD } : {}),
    wallMs: Date.now() - startedAt,
  });

  const all = await readTrace(opts.traceDir, opts.traceId);
  const lastStart = all.map((e) => e.type).lastIndexOf('run_start');
  const events = lastStart > 0 ? all.slice(lastStart) : all;
  return { result, trace: summarizeTrace(opts.traceId, events), events };
}

/**
 * Run a task's `assert.mjs` in the (post-run) workspace. Exit 0 = pass. Any
 * non-zero exit or a spawn failure = fail, with stdout+stderr captured.
 */
export function runAssertion(assertPath: string, workDir: string): { passed: boolean; output: string } {
  try {
    const output = execFileSync('node', [assertPath], {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { passed: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      passed: false,
      output: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim(),
    };
  }
}

