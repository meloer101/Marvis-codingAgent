export const CONSECUTIVE_DENY_LIMIT = 3;
export const CUMULATIVE_DENY_LIMIT = 20;

export interface AutoModeDenial {
  id: string;
  toolName: string;
  input: unknown;
  label?: string;
  reason: string;
  at: number;
}

/**
 * Per-session auto-mode counters. Shared with sub-agents. Counter updates
 * must go through `serialize` because the loop classifies calls in parallel.
 */
export class AutoModeState {
  paused = false;
  consecutiveDenials = 0;
  cumulativeDenials = 0;
  readonly recentDenials: AutoModeDenial[] = [];
  #tail: Promise<unknown> = Promise.resolve();
  #retryKeys = new Set<string>();

  async serialize<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.#tail.then(fn, fn);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  recordAllow(): void {
    this.consecutiveDenials = 0;
  }

  /**
   * Record a counted denial. Returns `'pause'` when a threshold trips.
   * Consecutive count always clears on pause; cumulative count clears only
   * when the cumulative threshold is what tripped.
   */
  recordDenial(denial: AutoModeDenial): 'ok' | 'pause' {
    this.consecutiveDenials += 1;
    this.cumulativeDenials += 1;
    this.recentDenials.unshift(denial);
    if (this.recentDenials.length > 50) this.recentDenials.pop();

    const consecutiveHit = this.consecutiveDenials >= CONSECUTIVE_DENY_LIMIT;
    const cumulativeHit = this.cumulativeDenials >= CUMULATIVE_DENY_LIMIT;
    if (!consecutiveHit && !cumulativeHit) return 'ok';

    this.paused = true;
    this.consecutiveDenials = 0;
    if (cumulativeHit) this.cumulativeDenials = 0;
    return 'pause';
  }

  /** Human approved a call after a pause — auto resumes. */
  resumeFromApproval(): void {
    this.paused = false;
    this.consecutiveDenials = 0;
  }

  markRetry(id: string): AutoModeDenial | undefined {
    const d = this.recentDenials.find((x) => x.id === id);
    if (!d) return undefined;
    this.#retryKeys.add(retryKey(d.toolName, d.input));
    return d;
  }

  consumeRetry(toolName: string, input: unknown): boolean {
    const k = retryKey(toolName, input);
    if (!this.#retryKeys.has(k)) return false;
    this.#retryKeys.delete(k);
    return true;
  }
}

function retryKey(toolName: string, input: unknown): string {
  try {
    return `${toolName}:${JSON.stringify(input)}`;
  } catch {
    return `${toolName}:?`;
  }
}
