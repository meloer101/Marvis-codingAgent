/** "just now" / "5m" / "3h" / "2d" / a date — sidebar timestamps. */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ms).toLocaleDateString();
}

/** Context-window fill level, same thresholds as the TUI's `MeterBar`. */
export function contextLevel(ratio: number): 'ok' | 'warn' | 'danger' {
  if (ratio >= 0.92) return 'danger';
  if (ratio >= 0.8) return 'warn';
  return 'ok';
}

/** A window size, rounded the way model pages quote them: `1M`, `256K`, `8K`. */
export function fmtWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/** `$0.30` per million tokens: two decimals, more for fractions of a cent. */
export function fmtRate(perMTok: number): string {
  return `$${perMTok < 0.1 ? +perMTok.toFixed(3) : perMTok.toFixed(2)}`;
}

/** A sum of money spent: `$0`, `$0.0042`, `$0.512`, `$12.40`, `$1,204.00` — more places the smaller it is. */
export function fmtCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A cost some calls had no price for: `≥$1.20`, or `—` when none had one. */
export function fmtPartialCost(usd: number, partial: boolean): string {
  if (!partial) return fmtCost(usd);
  return usd > 0 ? `≥${fmtCost(usd)}` : '—';
}

/** How long a tool ran: `340ms`, `2.4s`, `1m 05s`. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * A `bash` result split into what the command printed and how it ended — the
 * tool appends `[exit code N]` or `[command timed out after Nms]` for the
 * model, which the card shows in its header instead.
 */
export function bashOutcome(content: string): { output: string; exitCode?: number; timedOut?: boolean } {
  const m = /\n?\[(?:exit code (-?\d+)|command timed out after \d+ms)\]$/.exec(content);
  if (!m) return { output: content };
  const output = content.slice(0, m.index);
  return m[1] !== undefined ? { output, exitCode: Number(m[1]) } : { output, timedOut: true };
}
