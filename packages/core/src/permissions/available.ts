import type { Settings } from '../config/settings.js';
import type { ProviderRegistry } from '../provider/router.js';

export type AutoModeAvailability =
  | { available: true; modelRef: string }
  | { available: false; reason: string };

/**
 * Auto mode is off if any layer set `permissions.disableAutoMode: "disable"`,
 * or if the classifier model (`autoMode.model`, else the session model) cannot
 * be resolved through the registry.
 */
export function isAutoModeAvailable(
  settings: Settings,
  registry: ProviderRegistry,
): AutoModeAvailability {
  if (settings.permissions?.disableAutoMode === 'disable') {
    return { available: false, reason: 'disableAutoMode is set to "disable"' };
  }
  const ref = settings.autoMode?.model ?? settings.model;
  if (!ref) {
    return { available: false, reason: 'no classifier model configured' };
  }
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
