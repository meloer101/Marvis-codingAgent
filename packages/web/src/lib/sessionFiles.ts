/**
 * The files a session changed through its own tools — every `write` and
 * `edit` it (or a sub-agent of its) made — as workspace-relative paths, for
 * the Changes panel's "this session" filter. What a `bash` command changed
 * can't be told apart, so it isn't counted.
 */

import type { Entry, LiveSnapshot, ToolItem } from '@harness-code/protocol';

const WRITERS: ReadonlySet<string> = new Set(['write', 'edit']);

/** `path` relative to `root`, `/`-separated, without a leading `./`. */
export function workspaceRelative(path: string, root: string): string {
  let p = path.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/$/, '');
  if (p.startsWith(`${r}/`)) p = p.slice(r.length + 1);
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

export function sessionFiles(entries: readonly Entry[], live: LiveSnapshot, root: string): Set<string> {
  const files = new Set<string>();
  const visit = (tools: readonly ToolItem[]): void => {
    for (const t of tools) {
      if (WRITERS.has(t.name) && !t.result?.isError) {
        const path = (t.input as { path?: unknown } | null)?.path;
        if (typeof path === 'string' && path !== '') files.add(workspaceRelative(path, root));
      }
      if (t.children) visit(t.children);
    }
  };
  for (const e of entries) if (e.kind === 'assistant') visit(e.tools);
  visit(live.tools);
  return files;
}
