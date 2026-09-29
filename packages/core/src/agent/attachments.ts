/**
 * Files the user attached to a message (`@path` in the web composer). Each is
 * read with the `read` tool and rides in front of the message's text as a
 * block of its own, so the model sees the file as it would a `read` result —
 * line numbers included — and a transcript can tell attachments from what the
 * user typed.
 *
 * Browser-safe (no `node:*`): the display side (`@harness-code/protocol`'s
 * transcript fold) parses what the session side writes.
 */

import type { ContentBlock } from '../provider/types.js';

const BLOCK = /^<attached_file path="([^"]*)">\n[\s\S]*\n<\/attached_file>$/;

/** The text block an attached file travels in. */
export function attachedFileBlock(path: string, content: string): string {
  return `<attached_file path="${escapeAttr(path)}">\n${content}\n</attached_file>`;
}

/** The path of an attached-file block, or null for any other text. */
export function attachedFilePath(text: string): string | null {
  const m = BLOCK.exec(text);
  return m ? unescapeAttr(m[1]!) : null;
}

/**
 * What the user typed in a message: its text without the attached files'
 * bodies (the typed text still names them, `@path`). For whatever outlives
 * the turn — a title, the goal and messages a compaction keeps — where a copy
 * of the file would only be stale.
 */
export function typedText(blocks: readonly ContentBlock[]): string {
  let text = '';
  for (const block of blocks) {
    if (block.type === 'text' && attachedFilePath(block.text) === null) text += block.text;
  }
  return text;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
