/**
 * How transcript entries become rows. The notices a session emits as it
 * starts — skills and agents found, project memory, MCP servers, permission
 * mode, the session line — are diagnostics, not conversation: consecutive
 * ones collapse into one "session details" row.
 */

import type { Notice } from '@harness-code/core';
import type { Entry } from '@harness-code/protocol';

const STARTUP_KINDS: ReadonlySet<Notice['kind']> = new Set([
  'session-start',
  'project-memory',
  'skills-discovered',
  'agents-discovered',
  'mcp-status',
  'permission-mode',
  'sandbox-warn',
]);

export type Row =
  | { kind: 'entry'; key: string; entry: Entry }
  | { kind: 'details'; key: string; notices: Notice[] };

export function transcriptRows(entries: readonly Entry[]): Row[] {
  const rows: Row[] = [];
  for (const entry of entries) {
    if (entry.kind === 'notice' && STARTUP_KINDS.has(entry.notice.kind)) {
      const last = rows.at(-1);
      if (last?.kind === 'details') last.notices.push(entry.notice);
      else rows.push({ kind: 'details', key: `details-${entry.id}`, notices: [entry.notice] });
      continue;
    }
    rows.push({ kind: 'entry', key: String(entry.id), entry });
  }
  return rows;
}

/** "skills: 2 discovered (project 0, …)" → "skills 2", for the collapsed line. */
export function briefNotice(notice: Notice): string | null {
  if (notice.kind === 'session-start' || notice.kind === 'permission-mode') return null; // the header shows these
  const head = notice.text.split(/[(,—·]/)[0] ?? '';
  return head.replace(':', '').replace(/\s+(discovered|available|servers?|found)\b/g, '').replace(/\s+/g, ' ').trim() || null;
}
