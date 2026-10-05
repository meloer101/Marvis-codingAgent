/**
 * What the composer's `/` and `@` menus offer, and when they open. `/` opens
 * one menu: commands (only when the `/` starts an otherwise empty message —
 * a command is the whole message, as in Claude Code) and, below them, blocks
 * to insert, as in Notion. `@` at the start of a word opens the file menu.
 */

import type { EditorState } from '@tiptap/pm/state';

export type BlockId =
  | 'text'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'numbered'
  | 'todo'
  | 'quote'
  | 'code'
  | 'divider'
  | 'image';

export interface BlockDef {
  id: BlockId;
  label: string;
  /** Typed after `/` to find it, besides the label's words. */
  keywords: readonly string[];
  /** Its Markdown shortcut, shown beside it. */
  shortcut?: string;
}

export const BLOCKS: readonly BlockDef[] = [
  { id: 'text', label: 'Text', keywords: ['paragraph', 'plain'] },
  { id: 'h1', label: 'Heading 1', keywords: ['h1', 'title'], shortcut: '#' },
  { id: 'h2', label: 'Heading 2', keywords: ['h2', 'subtitle'], shortcut: '##' },
  { id: 'h3', label: 'Heading 3', keywords: ['h3'], shortcut: '###' },
  { id: 'bullet', label: 'Bulleted list', keywords: ['ul', 'unordered', 'list'], shortcut: '-' },
  { id: 'numbered', label: 'Numbered list', keywords: ['ol', 'ordered', 'list'], shortcut: '1.' },
  { id: 'todo', label: 'To-do list', keywords: ['task', 'checkbox', 'check', 'list'], shortcut: '[]' },
  { id: 'quote', label: 'Quote', keywords: ['blockquote'], shortcut: '>' },
  { id: 'code', label: 'Code block', keywords: ['pre', 'snippet', 'fence'], shortcut: '```' },
  { id: 'divider', label: 'Divider', keywords: ['hr', 'rule', 'line', 'separator'], shortcut: '---' },
  { id: 'image', label: 'Image', keywords: ['picture', 'photo', 'screenshot', 'img'] },
];

/** Blocks whose label words or keywords start with `query`, label matches first. */
export function filterBlocks(query: string): BlockDef[] {
  const q = query.toLowerCase();
  if (q === '') return [...BLOCKS];
  const byLabel: BlockDef[] = [];
  const byKeyword: BlockDef[] = [];
  for (const b of BLOCKS) {
    const label = b.label.toLowerCase();
    if (label.startsWith(q) || label.split(/[\s-]+/).some((w) => w.startsWith(q))) byLabel.push(b);
    else if (b.keywords.some((k) => k.startsWith(q))) byKeyword.push(b);
  }
  return [...byLabel, ...byKeyword];
}

export interface Trigger {
  kind: '/' | '@';
  query: string;
  /** The `/` or `@` and the query after it: what a pick replaces. */
  from: number;
  to: number;
  /** `/` only: the whole message is this `/query`, so commands are on offer too. */
  commands: boolean;
}

/**
 * The `/word` or `@word` the caret is at the end of, if any — typed at the
 * start of a line or after a space, nothing selected, not in code.
 */
export function triggerAt(state: EditorState): Trigger | null {
  const { selection, doc } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const parent = $from.parent;
  if (!parent.isTextblock || parent.type.spec.code) return null;
  // Leaf nodes (a mention) read as one character that ends a word.
  const before = parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const m = /(?:^|\s)([/@])([^\s/@￼]*)$/.exec(before);
  if (!m) return null;
  const kind = m[1] as '/' | '@';
  const query = m[2] ?? '';
  const from = $from.pos - query.length - 1;
  const commands =
    kind === '/' &&
    doc.childCount === 1 &&
    parent.type.name === 'paragraph' &&
    $from.depth === 1 &&
    from === 1 &&
    parent.textContent === `/${query}`;
  return { kind, query, from, to: $from.pos, commands };
}
