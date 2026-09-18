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
 * declares `effortLevels` when its endpoint accepts only part of the ladder —
 * DeepSeek does *not* fold unknown values server-side, it rejects them
 * (api-docs.deepseek.com/guides/thinking_mode), so a requested level is mapped
 * onto the declared ones here instead (`mapEffort`).
 */
export const DEFAULT_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

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
 * Maps a requested effort onto the levels a model actually accepts: nearest
 * position on `DEFAULT_REASONING_EFFORTS`, ties going to the smarter level
 * (so DeepSeek's low/high/max gets minimal→low, medium→high, xhigh→max).
 * `off` is not a level — callers handle it before asking.
 */
export function mapEffort(
  effort: Exclude<ReasoningEffort, 'off'>,
  levels: readonly ReasoningEffort[] | undefined,
): ReasoningEffort {
  if (!levels || levels.length === 0 || levels.includes(effort)) return effort;
  const rank = (e: ReasoningEffort) => DEFAULT_REASONING_EFFORTS.indexOf(e);
  const want = rank(effort);
  let best = levels[0]!;
  for (const level of levels) {
    const d = Math.abs(rank(level) - want);
    const bestD = Math.abs(rank(best) - want);
    if (d < bestD || (d === bestD && rank(level) > rank(best))) best = level;
  }
  return best;
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
   * Reasoning-effort levels this model actually accepts, in Faster→Smarter order
   * (drives the TUI picker and the value sent as `reasoning_effort`). Only
   * meaningful when `reasoning` is true; falls back to `DEFAULT_REASONING_EFFORTS`.
   */
  effortLevels?: readonly ReasoningEffort[];
  /** Default reasoning effort when none is configured. */
  defaultEffort?: ReasoningEffort;
  /**
   * Endpoint takes `thinking: { type: "enabled" | "disabled" }` — how DeepSeek
   * turns reasoning off, as opposed to an effort level.
   */
  thinkingParam?: boolean;
  /**
   * Whether past assistant turns must carry their reasoning back on the wire.
   * `text` replays it as `reasoning_content` (DeepSeek V4 400s without it once
   * the request has `tools`); `none` drops it, which is what every other
   * OpenAI-compatible endpoint expects.
   */
  reasoningReplay?: 'none' | 'text';
  contextWindow: number;
  maxOutputTokens: number;
  /** Endpoint rejects `temperature` (some reasoning models do). */
  fixedTemperature?: boolean;
  /** Use `developer` instead of `system` for the system message. */
  developerRole?: boolean;
  /**
   * Endpoint accepts OpenAI `tool_choice: { type: "allowed_tools", … }` so a
   * skill can constrain decoding without mutating the `tools` array (and
   * punching the prompt cache). Default off — most OpenAI-compat gateways
   * 400 on an unknown `tool_choice` shape.
   */
  allowedToolsChoice?: boolean;
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
  // every rule here sets `reasoning: true`. The endpoint takes only low/high/max
  // and rejects the rest of the ladder, so `effortLevels` is declared and
  // `mapEffort` folds the others onto it client-side. Context (1M) and output
  // (384K) are DeepSeek's published V4 figures. Prices are the published
  // peak-hour rates with `offPeak` (Mon–Fri outside 01:00–04:00 and 06:00–10:00
  // UTC) — note the cache-hit rate is ~1/50 of the miss rate, which is why
  // anything that breaks the prefix cache is worth avoiding.
  {
    provider: 'deepseek',
    match: /^deepseek-(v4-)?flash/i,
    caps: {
      reasoning: true,
      effortLevels: ['low', 'high', 'max'],
      defaultEffort: 'high',
      thinkingParam: true,
      reasoningReplay: 'text',
      contextWindow: 1_000_000,
      maxOutputTokens: 384_000,
      promptCache: 'implicit',
      jsonMode: true,
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
      effortLevels: ['low', 'high', 'max'],
      defaultEffort: 'high',
      thinkingParam: true,
      reasoningReplay: 'text',
      contextWindow: 1_000_000,
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
    caps: { contextWindow: 200_000, maxOutputTokens: 32_000, promptCache: 'explicit' },
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
    effortLevels: ['low', 'high', 'max'],
    defaultEffort: 'high',
    thinkingParam: true,
    reasoningReplay: 'text',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
  },
  moonshot: { promptCache: 'implicit' },
  openai: { promptCache: 'implicit', jsonMode: true, allowedToolsChoice: true },
  ollama: { streamUsage: false, parallelToolCalls: false },
  vllm: { streamUsage: false },
  llamacpp: { nativeTools: false, streamUsage: false },
};

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
