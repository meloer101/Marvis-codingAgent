import type { Settings } from '../config/settings.js';
import type { ProviderRegistry } from '../provider/router.js';

export type AutoModeAvailability =
  | { available: true; modelRef: string }
  | { available: false; reason: string };

/**
 * Auto mode is off if any layer set `permissions.disableAutoMode: "disable"`.
 * The classifier model is, in order: the user's explicit `autoMode.model`
 * (must resolve through the registry), the live session model
 * (`sessionModelRef`, accepted without a lookup), and only when there is no
 * session — e.g. `marvis auto-mode critique` — `settings.model`.
 *
 * `settings.model` must not win over the session model: it always carries the
 * built-in default and may come from a project file, so preferring it would
 * run the classifier on a model the user did not pick.
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
  if (sessionModelRef) {
    // Already-resolved session model — do not require it to live in the registry
    // (tests inject ScriptedProvider instances that are not registered).
    return { available: true, modelRef: sessionModelRef };
  }
  if (settings.model) {
    return resolveRef(settings.model, registry);
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
