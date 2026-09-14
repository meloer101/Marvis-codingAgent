import type { Settings } from '../config/settings.js';
import type { ProviderRegistry } from '../provider/router.js';

export type AutoModeAvailability =
  | { available: true; modelRef: string }
  | { available: false; reason: string };

/**
 * Auto mode is off if any layer set `permissions.disableAutoMode: "disable"`,
 * or if an explicit classifier model (`autoMode.model`, else `settings.model`)
 * cannot be resolved through the registry. When neither is set, `sessionModelRef`
 * (the live session model) is accepted without a registry lookup.
 */
export function isAutoModeAvailable(
  settings: Settings,
  registry: ProviderRegistry,
  sessionModelRef?: string,
): AutoModeAvailability {
  if (settings.permissions?.disableAutoMode === 'disable') {
    return { available: false, reason: 'disableAutoMode is set to "disable"' };
  }
  const explicit = settings.autoMode?.model;
  if (explicit) {
    return resolveRef(explicit, registry);
  }
  if (settings.model) {
    return resolveRef(settings.model, registry);
  }
  if (sessionModelRef) {
    // Already-resolved session model — do not require it to live in the registry
    // (tests inject ScriptedProvider instances that are not registered).
    return { available: true, modelRef: sessionModelRef };
  }
  return { available: false, reason: 'no classifier model configured' };
}

function resolveRef(ref: string, registry: ProviderRegistry): AutoModeAvailability {
  try {
    registry.resolve(ref);
    return { available: true, modelRef: ref };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      reason: `classifier model "${ref}" could not be resolved: ${msg}`,
    };
  }
}
