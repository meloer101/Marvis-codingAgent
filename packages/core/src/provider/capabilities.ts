/**
 * Per-model capability table.
 *
 * "OpenAI-compatible" is a spectrum, not a contract. Endpoints disagree about
 * parallel tool calls, whether `stream_options.include_usage` exists, whether
 * tool calling works at all, and how big the window really is. Rather than
 * discovering that at runtime inside the agent loop, we declare it here and let
 * every other layer branch on facts instead of vibes.
 */

import type { ReasoningEffort } from './types.js';

export type PromptCacheMode = 'none' | 'implicit' | 'explicit';

/**
 * Universal reasoning-effort ladder shown by default (Faster→Smarter). A model
 * declares `effortLevels` when its picker should differ (DeepSeek adds `ultra`),
 * and `effortMap` when what it actually takes differs from what the user picks.
 * `ultra` is not in the default: it means something only where a provider
 * publishes it, and most endpoints would reject it.
 */
export const DEFAULT_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** Every level in Faster→Smarter order — the ruler `mapEffort`'s nearest-level fold measures on. */
const EFFORT_LADDER: readonly ReasoningEffort[] = [...DEFAULT_REASONING_EFFORTS, 'ultra'];

/**
 * DeepSeek's published effort table (api-docs.deepseek.com, thinking mode): the
 * user picks and sees the left column, and the request carries the right one.
 * The endpoint takes the whole ladder as input and folds it onto its three
 * native levels itself; sending the folded value keeps what we ask for
 * explicit and independent of that server-side behaviour.
 */
const DEEPSEEK_EFFORT = {
  effortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  effortMap: {
    minimal: 'low',
    low: 'low',
    medium: 'high',
    high: 'high',
    xhigh: 'high',
    max: 'max',
    ultra: 'max',
  },
  defaultEffort: 'high',
} as const;

/** Rates in $/MTok. `offPeak` applies outside the provider's peak window. */
export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number;
  offPeak?: {
    inputPerMTok: number;
    outputPerMTok: number;
    cachedInputPerMTok?: number;
  };
}

/**
 * What to send for the effort the user picked. The model's `effortMap` decides
 * when it has an entry; otherwise a level outside `effortLevels` is folded onto
 * the nearest declared one on the ladder, ties going to the smarter level, and
 * a model that declares neither gets the level as is. `off` is not a level —
 * callers handle it before asking.
 */
export function mapEffort(
  effort: Exclude<ReasoningEffort, 'off'>,
  caps: Pick<ModelCapabilities, 'effortLevels' | 'effortMap'>,
): ReasoningEffort {
  const mapped = caps.effortMap?.[effort];
  if (mapped) return mapped;
  const levels = caps.effortLevels;
  if (!levels || levels.length === 0 || levels.includes(effort)) return effort;
  const rank = (e: ReasoningEffort) => EFFORT_LADDER.indexOf(e);
  const want = rank(effort);
  let best = levels[0]!;
  for (const level of levels) {
    const d = Math.abs(rank(level) - want);
    const bestD = Math.abs(rank(best) - want);
    if (d < bestD || (d === bestD && rank(level) > rank(best))) best = level;
  }
  return best;
}

/** What a model offers for reasoning effort, and where a session on it starts. */
export interface EffortOptions {
  /** The picker's levels, Faster→Smarter; empty when the model has no reasoning channel. */
  levels: readonly ReasoningEffort[];
  /**
   * Where a session starts: `preferred` (a `--effort` flag, settings), else the
   * model's `defaultEffort`, else `high`. Undefined without reasoning.
   */
  initial: ReasoningEffort | undefined;
}

/** Effort levels and starting level for a model — the one rule sessions, the TUI and the web share. */
export function effortOptions(
  caps: Pick<ModelCapabilities, 'reasoning' | 'effortLevels' | 'defaultEffort'>,
  preferred?: ReasoningEffort,
): EffortOptions {
  if (!caps.reasoning) return { levels: [], initial: undefined };
  return {
    levels: caps.effortLevels ?? DEFAULT_REASONING_EFFORTS,
    initial: preferred ?? caps.defaultEffort ?? 'high',
  };
}

export interface ModelCapabilities {
  /** Endpoint implements OpenAI `tools` / `tool_calls`. When false we fall back
   *  to prompt-encoded tool calling (see `prompt-tools.ts`). */
  nativeTools: boolean;
  /** More than one tool call may come back in a single assistant turn. */
  parallelToolCalls: boolean;
  streaming: boolean;
  /** Endpoint honours `stream_options: { include_usage: true }`. */
  streamUsage: boolean;
  jsonMode: boolean;
  promptCache: PromptCacheMode;
  /** Model emits a separate reasoning channel we should surface as `thinking`. */
  reasoning: boolean;
  /**
   * Reasoning-effort levels the user can pick for this model, in Faster→Smarter
   * order (drives the TUI picker). Only meaningful when `reasoning` is true;
   * falls back to `DEFAULT_REASONING_EFFORTS`. A picked level outside this list
   * (a `--effort` flag, settings.json) is folded onto the nearest one.
   */
  effortLevels?: readonly ReasoningEffort[];
  /**
   * What is actually sent as `reasoning_effort` for a picked level, when it
   * differs — DeepSeek shows the whole ladder but only has low/high/max. A level
   * with no entry falls through to `effortLevels`' nearest-level fold.
   */
  effortMap?: Partial<Record<Exclude<ReasoningEffort, 'off'>, ReasoningEffort>>;
  /** Default reasoning effort when none is configured. */
  defaultEffort?: ReasoningEffort;
  /**
   * Endpoint takes `thinking: { type: "enabled" | "disabled" }` — how DeepSeek
   * turns reasoning off, as opposed to an effort level.
   */
  thinkingParam?: boolean;
  /**
   * Whether past assistant turns carry their reasoning back on the wire.
   * `text` replays it as `reasoning_content`; `none` drops it, which is what
   * every other OpenAI-compatible endpoint expects.
   *
   * DeepSeek is documented as *requiring* the replay once a request has
   * `tools`, but probing it (2026-09-19) found omission accepted as well. We
   * replay anyway: it is what DeepSeek's own harness does, and it keeps the
   * turn's prefix byte-identical to the one already in the prompt cache.
   */
  reasoningReplay?: 'none' | 'text';
  /**
   * How a mid-session system-prompt change is delivered.
   *
   * `rewrite` (default) edits the system message at the head of the request —
   * correct everywhere, but it changes the first token of the prompt and so
   * throws away the whole cached prefix. `in-history` keeps the head exactly as
   * first sent and appends the new text as a second `system` message late in
   * the conversation, which endpoints that read the *last* system message
   * honour while the prefix stays cached. Verified for DeepSeek Chat
   * Completions by `scripts/deepseek-probe.mjs` probe 3.
   */
  systemPromptUpdate?: 'rewrite' | 'in-history';
  contextWindow: number;
  /**
   * How much of `contextWindow` the model is actually good over, when that is
   * less than the window it accepts. DeepSeek V4 retrieves reliably to ~256K
   * (MRCR 8-needle ≥0.82) and degrades toward 1M (0.59), so warn/compact/stop
   * ratios are computed against this rather than the hard limit; the hard limit
   * still governs overflow. Settings can override it with `contextBudgetTokens`.
   */
  qualityContextWindow?: number;
  maxOutputTokens: number;
  /** Endpoint rejects `temperature` (some reasoning models do). */
  fixedTemperature?: boolean;
  /** Model takes images in user messages (OpenAI `image_url` content parts). */
  vision?: boolean;
  /**
   * What the images in one request may come to, in base64 characters, when the
   * endpoint caps a request's size: the history re-sends every image, so past
   * this the oldest are left out (a note in their place).
   */
  maxRequestImageBytes?: number;
  /** Use `developer` instead of `system` for the system message. */
  developerRole?: boolean;
  /**
   * Endpoint accepts OpenAI `tool_choice: { type: "allowed_tools", … }` so a
   * skill can constrain decoding without mutating the `tools` array (and
   * punching the prompt cache). Default off — most OpenAI-compat gateways
   * 400 on an unknown `tool_choice` shape.
   */
  allowedToolsChoice?: boolean;
  /**
   * Recover tool calls the model wrote into the text channel: DSML markup the
   * endpoint failed to parse, or a trailing `toolname{json}` (see
   * `dsml-salvage.ts`). On for DeepSeek models behind any provider.
   */
  textToolCallSalvage?: boolean;
  pricing?: Pricing;
}

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  nativeTools: true,
  parallelToolCalls: true,
  streaming: true,
  streamUsage: true,
  jsonMode: false,
  promptCache: 'none',
  reasoning: false,
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
};

interface CapabilityRule {
  /** Provider id, or `*` for any. */
  provider: string;
  /** Matched against the bare model id, case-insensitively. */
  match: RegExp;
  caps: Partial<ModelCapabilities>;
}

/**
 * Ordered most-specific-first; the first match per provider wins, then the
 * provider default, then `DEFAULT_CAPABILITIES`.
 */
const RULES: CapabilityRule[] = [
  // --- DeepSeek -----------------------------------------------------------
  // `deepseek-chat`/`deepseek-reasoner` were retired 2026-07-24; the V4 line is
  // `deepseek-flash` (V4.1-Flash, 2026-09-10) and `deepseek-v4-pro`, with
  // `deepseek-v4-flash` routed to V4.1-Flash as a transitional alias. Thinking
  // is an effort level on the same model id rather than a separate model, so
  // every rule here sets `reasoning: true`. The user picks from the whole
  // ladder and `DEEPSEEK_EFFORT` says which of the three native levels
  // (low/high/max) each one is sent as. Context (1M) and output
  // (384K) are DeepSeek's published V4 figures. Prices are the published
  // peak-hour rates with `offPeak` (Mon–Fri outside 01:00–04:00 and 06:00–10:00
  // UTC) — note the cache-hit rate is ~1/50 of the miss rate, which is why
  // anything that breaks the prefix cache is worth avoiding.
  {
    provider: 'deepseek',
    match: /^deepseek-(v4-)?flash/i,
    caps: {
      reasoning: true,
      ...DEEPSEEK_EFFORT,
      thinkingParam: true,
      reasoningReplay: 'text',
      systemPromptUpdate: 'in-history',
      contextWindow: 1_000_000,
      qualityContextWindow: 256_000,
      maxOutputTokens: 384_000,
      promptCache: 'implicit',
      jsonMode: true,
      // V4.1-Flash reads images natively (user messages only); Pro does not.
      // A request is 48 MiB at most: images get 40 of it, the rest is text.
      vision: true,
      maxRequestImageBytes: 40 * 1024 * 1024,
      pricing: {
        inputPerMTok: 0.3,
        outputPerMTok: 1.2,
        cachedInputPerMTok: 0.006,
        offPeak: { inputPerMTok: 0.15, outputPerMTok: 0.6, cachedInputPerMTok: 0.003 },
      },
    },
  },
  {
    provider: 'deepseek',
    match: /^deepseek-v4-pro/i,
    caps: {
      reasoning: true,
      ...DEEPSEEK_EFFORT,
      thinkingParam: true,
      reasoningReplay: 'text',
      systemPromptUpdate: 'in-history',
      contextWindow: 1_000_000,
      qualityContextWindow: 256_000,
      maxOutputTokens: 384_000,
      promptCache: 'implicit',
      pricing: {
        inputPerMTok: 1.32,
        outputPerMTok: 3.96,
        cachedInputPerMTok: 0.044,
        offPeak: { inputPerMTok: 0.66, outputPerMTok: 1.98, cachedInputPerMTok: 0.022 },
      },
    },
  },

  // --- Moonshot / Kimi ----------------------------------------------------
  {
    provider: 'moonshot',
    match: /^kimi-k2/i,
    caps: {
      contextWindow: 256_000,
      maxOutputTokens: 16_384,
      promptCache: 'implicit',
      pricing: { inputPerMTok: 0.6, outputPerMTok: 2.5, cachedInputPerMTok: 0.15 },
    },
  },
  {
    provider: 'moonshot',
    match: /^moonshot-v1-128k/i,
    caps: { contextWindow: 128_000, maxOutputTokens: 8_192 },
  },

  // --- OpenAI -------------------------------------------------------------
  {
    provider: 'openai',
    match: /^(o[1-9]|gpt-5)/i,
    caps: {
      reasoning: true,
      vision: true,
      fixedTemperature: true,
      developerRole: true,
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      promptCache: 'implicit',
      jsonMode: true,
    },
  },
  {
    provider: 'openai',
    match: /^gpt-4o/i,
    caps: {
      vision: true,
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      promptCache: 'implicit',
      jsonMode: true,
      pricing: { inputPerMTok: 2.5, outputPerMTok: 10, cachedInputPerMTok: 1.25 },
    },
  },

  // --- Qwen via DashScope compatible mode ---------------------------------
  {
    provider: 'dashscope',
    match: /^qwen3-coder/i,
    caps: { contextWindow: 262_144, maxOutputTokens: 65_536, promptCache: 'implicit' },
  },
  {
    provider: 'dashscope',
    match: /^qwen/i,
    caps: { contextWindow: 131_072, maxOutputTokens: 8_192 },
  },

  // --- Zhipu --------------------------------------------------------------
  {
    provider: 'zhipu',
    match: /^glm-4/i,
    caps: { contextWindow: 128_000, maxOutputTokens: 16_384 },
  },

  // --- Local runtimes -----------------------------------------------------
  {
    provider: 'ollama',
    match: /qwen|llama|mistral|devstral|codestral|granite|gemma/i,
    caps: {
      // Ollama's OpenAI shim supports tools, but small models are unreliable at
      // them and it does not report usage on streamed responses.
      streamUsage: false,
      parallelToolCalls: false,
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    },
  },
  {
    provider: 'ollama',
    match: /.*/,
    caps: {
      streamUsage: false,
      parallelToolCalls: false,
      contextWindow: 8_192,
      maxOutputTokens: 2_048,
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    },
  },
  {
    provider: 'vllm',
    match: /.*/,
    caps: { streamUsage: false, contextWindow: 32_768, maxOutputTokens: 4_096 },
  },
  {
    provider: 'llamacpp',
    match: /.*/,
    caps: {
      nativeTools: false,
      streamUsage: false,
      parallelToolCalls: false,
      contextWindow: 8_192,
      maxOutputTokens: 2_048,
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    },
  },

  // --- Aggregators --------------------------------------------------------
  {
    provider: 'openrouter',
    match: /^anthropic\//i,
    caps: { contextWindow: 200_000, maxOutputTokens: 32_000, promptCache: 'explicit', vision: true },
  },
  { provider: 'openrouter', match: /.*/, caps: { contextWindow: 128_000 } },
];

/** Provider-level defaults applied when no rule matches. */
const PROVIDER_DEFAULTS: Record<string, Partial<ModelCapabilities>> = {
  // Every current DeepSeek model is a V4-series reasoning model on the same
  // 1M/384K envelope, so an unrecognized id should not fall back to the
  // 128K/8K/no-reasoning default and silently lose thinking.
  deepseek: {
    promptCache: 'implicit',
    reasoning: true,
    ...DEEPSEEK_EFFORT,
    thinkingParam: true,
    reasoningReplay: 'text',
    systemPromptUpdate: 'in-history',
    contextWindow: 1_000_000,
    qualityContextWindow: 256_000,
    maxOutputTokens: 384_000,
  },
  moonshot: { promptCache: 'implicit' },
  openai: { promptCache: 'implicit', jsonMode: true, allowedToolsChoice: true },
  ollama: { streamUsage: false, parallelToolCalls: false },
  vllm: { streamUsage: false },
  llamacpp: { nativeTools: false, streamUsage: false },
};

/**
 * Defaults by model family, whichever provider serves it — DeepSeek's text-channel
 * tool-call failure follows the model to OpenRouter or a self-hosted vLLM.
 * Applied after the provider defaults and before the matching rule.
 */
const FAMILY_DEFAULTS: ReadonlyArray<{ match: RegExp; caps: Partial<ModelCapabilities> }> = [
  { match: /deepseek/i, caps: { textToolCallSalvage: true } },
  // Vision-language variants say so in their names (qwen-vl, glm-4v, llava, pixtral…).
  { match: /(^|[-_/.])(vl|vision)([-_.:]|$)|llava|pixtral|glm-4v/i, caps: { vision: true } },
];

/** User overrides, keyed as `provider/model`, `provider/*`, or `*`. */
export type CapabilityOverrides = Record<string, Partial<ModelCapabilities>>;

export function resolveCapabilities(
  provider: string,
  model: string,
  overrides: CapabilityOverrides = {},
): ModelCapabilities {
  const rule = RULES.find((r) => r.provider === provider && r.match.test(model));
  const merged: ModelCapabilities = {
    ...DEFAULT_CAPABILITIES,
    ...(PROVIDER_DEFAULTS[provider] ?? {}),
    ...Object.assign({}, ...FAMILY_DEFAULTS.filter((f) => f.match.test(model)).map((f) => f.caps)),
    ...(rule?.caps ?? {}),
    ...(overrides['*'] ?? {}),
    ...(overrides[`${provider}/*`] ?? {}),
    ...(overrides[`${provider}/${model}`] ?? {}),
  };
  return merged;
}

/**
 * DeepSeek's peak window: Monday–Friday 01:00–04:00 and 06:00–10:00 UTC
 * (09:00–12:00 / 14:00–18:00 Beijing). Everything else bills at `offPeak`,
 * roughly half. Weekend hours are off-peak throughout.
 */
function isPeakHour(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function estimateCostUSD(
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
  pricing: Pricing | undefined,
  at: Date = new Date(),
): number | undefined {
  if (!pricing) return undefined;
  const rates = pricing.offPeak && !isPeakHour(at) ? pricing.offPeak : pricing;
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cachedRate = rates.cachedInputPerMTok ?? rates.inputPerMTok;
  return (
    (fresh * rates.inputPerMTok +
      usage.cachedInputTokens * cachedRate +
      usage.outputTokens * rates.outputPerMTok) /
    1_000_000
  );
}
