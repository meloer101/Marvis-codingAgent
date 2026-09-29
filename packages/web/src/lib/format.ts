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
