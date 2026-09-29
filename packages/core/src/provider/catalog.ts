/**
 * The models a picker offers, and what each one is — without resolving a
 * provider or touching the network.
 *
 * There is no endpoint that lists "models this user can run": every provider
 * speaks Chat Completions but few agree on `/models`, and a model id there says
 * nothing about windows, effort or price. So the offer is assembled from what
 * the user configured plus a short built-in lineup, and each ref is described
 * from the capability table (`capabilities.ts`).
 */

import { effortOptions, resolveCapabilities } from './capabilities.js';
import type { Pricing } from './capabilities.js';
import { parseModelRef } from './router.js';
import type { ProviderRegistry, RouterSettings } from './router.js';
import type { ReasoningEffort } from './types.js';

/** The current lineup of the default provider, offered alongside whatever settings name. */
export const MODEL_CATALOG: readonly string[] = ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro'];

/** One model a picker can offer. */
export interface ModelDescription {
  /** `provider/model`. */
  ref: string;
  contextWindow: number;
  /** The span the model stays reliable over, when less than its window. */
  qualityContextWindow?: number;
  maxOutputTokens: number;
  /** Effort levels, Faster→Smarter; empty without reasoning. */
  effortLevels: ReasoningEffort[];
  /** Where a session on it starts; absent without reasoning. */
  defaultEffort?: ReasoningEffort;
  /** $/MTok, when known. */
  pricing?: Pricing;
  /** Why it can't be used as configured (typically a missing API key); absent when it can. */
  problem?: string;
}

/**
 * The refs to offer, in order and without repeats: the default model, the
 * ones `settings.models` lists, the small model, then the built-in lineup.
 */
export function offeredModels(opts: { defaultModel?: string; models?: readonly string[]; smallModel?: string }): string[] {
  const refs = [opts.defaultModel, ...(opts.models ?? []), opts.smallModel, ...MODEL_CATALOG];
  return [...new Set(refs.map((r) => r?.trim()).filter((r): r is string => !!r))];
}

/**
 * What `ref` is under `settings`, and whether `registry` could run it. No
 * network: resolving a provider only checks its configuration and key.
 */
export function describeModel(
  ref: string,
  settings: Pick<RouterSettings, 'defaultProvider' | 'capabilities'> & { reasoningEffort?: ReasoningEffort },
  registry: Pick<ProviderRegistry, 'resolve'>,
): ModelDescription {
  let parsed: { provider: string; model: string };
  try {
    parsed = parseModelRef(ref, settings.defaultProvider ?? 'openai');
  } catch (err) {
    return { ref, contextWindow: 0, maxOutputTokens: 0, effortLevels: [], problem: messageOf(err) };
  }
  const caps = resolveCapabilities(parsed.provider, parsed.model, settings.capabilities ?? {});
  const { levels, initial } = effortOptions(caps, settings.reasoningEffort);
  let problem: string | undefined;
  try {
    registry.resolve(ref);
  } catch (err) {
    problem = messageOf(err);
  }
  return {
    ref,
    contextWindow: caps.contextWindow,
    ...(caps.qualityContextWindow !== undefined && caps.qualityContextWindow < caps.contextWindow
      ? { qualityContextWindow: caps.qualityContextWindow }
      : {}),
    maxOutputTokens: caps.maxOutputTokens,
    effortLevels: [...levels],
    ...(initial ? { defaultEffort: initial } : {}),
    ...(caps.pricing ? { pricing: caps.pricing } : {}),
    ...(problem ? { problem } : {}),
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
