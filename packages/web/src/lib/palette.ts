/**
 * The command palette's list: what can be done from anywhere (⌘K) — actions
 * on the session on screen, jumping to another session, starting one in a
 * project, app settings — and how a query narrows it.
 */

import type { LucideIcon } from 'lucide-react';

export type PaletteGroup = 'New' | 'This session' | 'Sessions' | 'App';

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  /** Shown at the right: a shortcut, a project, a time. */
  hint?: string;
  /** More words it answers to. */
  keywords?: string;
  icon?: LucideIcon;
  run: () => void;
  /** ⌥Enter: the other way to run it (a session opened beside the one on screen). */
  altRun?: () => void;
}

/** Sessions listed before a query narrows them. */
const SESSIONS_WITHOUT_QUERY = 6;

/**
 * How well `text` answers `query` (higher is better), or null: every word of
 * the query must be in it — as a substring, or failing that as a subsequence.
 */
export function paletteScore(text: string, query: string): number | null {
  const t = text.toLowerCase();
  let score = 0;
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const at = t.indexOf(word);
    if (at !== -1) {
      score += 10 + (at === 0 || /[\s/:·._-]/.test(t[at - 1]!) ? 5 : 0);
      continue;
    }
    let from = 0;
    for (const ch of word) {
      const found = t.indexOf(ch, from);
      if (found === -1) return null;
      from = found + 1;
    }
    score += 2;
  }
  return score - t.length * 0.01;
}

/**
 * Without a query: the groups in order, with only the most recent sessions.
 * With one: every match, best first (ties keep the group order).
 */
export function filterPalette(items: readonly PaletteItem[], query: string): PaletteItem[] {
  if (query.trim() === '') {
    let sessions = 0;
    return items.filter((item) => item.group !== 'Sessions' || sessions++ < SESSIONS_WITHOUT_QUERY);
  }
  return items
    .map((item, index) => ({ item, index, score: paletteScore(`${item.label} ${item.keywords ?? ''}`, query) }))
    .filter((x): x is { item: PaletteItem; index: number; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.item);
}
