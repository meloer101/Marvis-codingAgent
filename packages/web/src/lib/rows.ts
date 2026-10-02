/**
 * How transcript entries become rows. The notices a session emits as it
 * starts — skills and agents found, project memory, MCP servers, permission
 * mode, the session line — are diagnostics, not conversation: consecutive
 * ones collapse into one "session details" row. Consecutive assistant steps
 * make one turn row, the in-flight step included, so a run of exploration
 * calls can fold into one line even when it spans several model calls.
 */

import type { Notice } from '@harness-code/core';
import type { Entry, LiveSnapshot, ToolItem } from '@harness-code/protocol';

const STARTUP_KINDS: ReadonlySet<Notice['kind']> = new Set([
  'session-start',
  'project-memory',
  'skills-discovered',
  'agents-discovered',
  'mcp-status',
  'permission-mode',
  'sandbox-warn',
]);

/**
 * State changes the header already shows (the mode and effort pickers) — no
 * transcript row, as in the TUI — and a sub-agent's progress lines, which the
 * `task` card shows as its calls.
 */
const HIDDEN_KINDS: ReadonlySet<Notice['kind']> = new Set(['mode-changed', 'effort-changed', 'subagent']);

/** One model call's output: a committed assistant entry, or the one streaming now. */
export interface Step {
  id: number;
  thinking: string;
  text: string;
  tools: ToolItem[];
  streaming?: boolean;
}

export type Row =
  | { kind: 'entry'; key: string; entry: Entry }
  | { kind: 'details'; key: string; notices: Notice[] }
  | { kind: 'turn'; key: string; steps: Step[] };

export function transcriptRows(entries: readonly Entry[]): Row[] {
  const rows: Row[] = [];
  for (const entry of entries) {
    if (entry.kind === 'notice' && HIDDEN_KINDS.has(entry.notice.kind)) continue;
    const last = rows.at(-1);
    if (entry.kind === 'notice' && STARTUP_KINDS.has(entry.notice.kind)) {
      if (last?.kind === 'details') last.notices.push(entry.notice);
      else rows.push({ kind: 'details', key: `details-${entry.id}`, notices: [entry.notice] });
      continue;
    }
    if (entry.kind === 'assistant') {
      if (last?.kind === 'turn') last.steps.push(entry);
      else rows.push({ kind: 'turn', key: `turn-${entry.id}`, steps: [entry] });
      continue;
    }
    rows.push({ kind: 'entry', key: String(entry.id), entry });
  }
  return rows;
}

/**
 * The rows with the streaming step added to the turn it continues (or a new
 * one). Only the last row is replaced, so the others keep their identity.
 * `nextId` is the id the step will have once committed, which keeps its keys
 * stable across the commit.
 */
export function withLive(rows: readonly Row[], live: LiveSnapshot, nextId: number): readonly Row[] {
  if (live.thinking === '' && live.text === '' && live.tools.length === 0) return rows;
  const step: Step = { id: nextId, ...live, streaming: true };
  const last = rows.at(-1);
  if (last?.kind === 'turn') return [...rows.slice(0, -1), { ...last, steps: [...last.steps, step] }];
  return [...rows, { kind: 'turn', key: `turn-${nextId}`, steps: [step] }];
}

/** Read-only lookups that fold into one "explored" line (the TUI's Ctrl+O shows them all). */
const EXPLORE_TOOLS: ReadonlySet<string> = new Set(['read', 'grep', 'glob', 'webfetch', 'list_skills']);

export function isExploreTool(tool: ToolItem): boolean {
  return EXPLORE_TOOLS.has(tool.name);
}

export type Part =
  | { kind: 'thinking'; key: string; text: string; active: boolean }
  | { kind: 'text'; key: string; text: string; streaming: boolean }
  | { kind: 'tool'; key: string; tool: ToolItem }
  /** Two or more exploration calls in a row, with the thinking between them. */
  | { kind: 'explore'; key: string; parts: Array<Extract<Part, { kind: 'thinking' | 'tool' }>> };

/**
 * A turn's steps as the parts it shows, in order. Unless `verbose`, each run
 * of two or more exploration calls — uninterrupted by text or another tool —
 * becomes one `explore` part; thinking between them goes inside, thinking
 * before the first or after the last stays outside, with the text it leads to.
 */
export function turnParts(steps: readonly Step[], verbose: boolean): Part[] {
  const flat: Part[] = [];
  for (const s of steps) {
    const streaming = s.streaming === true;
    if (s.thinking) {
      flat.push({
        kind: 'thinking',
        key: `${s.id}:thinking`,
        text: s.thinking,
        active: streaming && s.text === '' && s.tools.length === 0,
      });
    }
    if (s.text) flat.push({ kind: 'text', key: `${s.id}:text`, text: s.text, streaming: streaming && s.tools.length === 0 });
    for (const tool of s.tools) flat.push({ kind: 'tool', key: tool.id, tool });
  }
  if (verbose) return flat;

  const out: Part[] = [];
  let i = 0;
  while (i < flat.length) {
    const part = flat[i]!;
    if (part.kind !== 'tool' || !isExploreTool(part.tool)) {
      out.push(part);
      i++;
      continue;
    }
    // From this exploration call, take thinking and exploration calls; end
    // the group at the last call, so trailing thinking stays outside.
    let end = i;
    let calls = 0;
    for (let j = i; j < flat.length; j++) {
      const p = flat[j]!;
      if (p.kind === 'tool' && isExploreTool(p.tool)) {
        end = j;
        calls++;
      } else if (p.kind !== 'thinking') break;
    }
    if (calls < 2) {
      out.push(part);
      i++;
      continue;
    }
    const parts = flat.slice(i, end + 1) as Array<Extract<Part, { kind: 'thinking' | 'tool' }>>;
    out.push({ kind: 'explore', key: `explore:${part.key}`, parts });
    i = end + 1;
  }
  return out;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * "Read 3 files, searched for 2 patterns" — in the order the kinds first
 * appear. A grep and a glob are both a search for a pattern.
 */
export function exploreSummary(tools: readonly ToolItem[]): string {
  const files = new Set<string>();
  const counts = new Map<string, number>();
  for (const t of tools) {
    if (t.name === 'read') {
      const path = (t.input as { path?: unknown } | null)?.path;
      files.add(typeof path === 'string' ? path : t.id);
    }
    const kind = t.name === 'glob' ? 'grep' : t.name;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const phrases: string[] = [];
  for (const [kind, n] of counts) {
    if (kind === 'read') phrases.push(`read ${plural(files.size, 'file', 'files')}`);
    else if (kind === 'grep') phrases.push(`searched for ${plural(n, 'pattern', 'patterns')}`);
    else if (kind === 'webfetch') phrases.push(`fetched ${plural(n, 'page', 'pages')}`);
    else if (kind === 'list_skills') phrases.push('listed skills');
    else phrases.push(`${kind} ×${n}`);
  }
  const text = phrases.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "skills: 2 discovered (project 0, …)" → "skills 2", for the collapsed line. */
export function briefNotice(notice: Notice): string | null {
  if (notice.kind === 'session-start' || notice.kind === 'permission-mode') return null; // the header shows these
  const head = notice.text.split(/[(,—·]/)[0] ?? '';
  return head.replace(':', '').replace(/\s+(discovered|available|servers?|found)\b/g, '').replace(/\s+/g, ' ').trim() || null;
}
