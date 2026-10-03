/**
 * Persisted transcript → display entries. Shared (Ink/React-free) so the TUI
 * and the web frontend rebuild a session's history identically — the same
 * reason `foldReducer`/`EventBuffer` live here. The web frontend uses it to
 * hydrate a snapshot; the TUI uses it when `/resume` swaps to another session.
 */

import { attachedFilePath } from '@harness-code/core/browser';
import type { Notice, ToolDisplay, TranscriptItem } from '@harness-code/core';

import type { Entry, ToolItem } from './reducer.js';

/**
 * Rebuild display entries from the persisted transcript: one `assistant` entry
 * per assistant message, tool results (which ride in the next `user` message)
 * attached back onto their tool cards — with what they carried for display,
 * how long they ran and a `task`'s sub-agent calls — files attached to a user
 * message as its `attachments`, compactions as a divider notice.
 */
export function entriesFromTranscript(items: TranscriptItem[]): Entry[] {
  const entries: Entry[] = [];
  const tools = new Map<string, ToolItem>();
  // Recorded as a call ends, ahead of the message carrying its result.
  const displays = new Map<string, ToolDisplay>();

  for (const item of items) {
    if (item.type === 'tool_display') {
      const tool = tools.get(item.toolUseId);
      if (item.display) {
        if (tool?.result) tool.result.display = item.display;
        else displays.set(item.toolUseId, item.display);
      }
      if (tool && item.durationMs !== undefined) tool.durationMs = item.durationMs;
      if (tool && item.subagent?.length) {
        tool.children = item.subagent.map((c) => ({
          id: c.id,
          name: c.name,
          input: c.input,
          running: false,
          ...(c.result ? { result: c.result } : {}),
          ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}),
        }));
      }
      continue;
    }
    if (item.type === 'compaction') {
      const notice: Notice = {
        kind: 'compaction',
        level: 'info',
        text: `Context compacted (${item.tokensBefore.toLocaleString()} → ${item.tokensAfter.toLocaleString()} tokens)`,
      };
      entries.push({ kind: 'notice', id: entries.length, notice });
      continue;
    }
    const { message } = item;
    if (message.role === 'assistant') {
      let thinking = '';
      let text = '';
      const entryTools: ToolItem[] = [];
      for (const block of message.content) {
        if (block.type === 'thinking') thinking += block.text;
        else if (block.type === 'text') text += block.text;
        else if (block.type === 'tool_use') {
          const tool: ToolItem = { id: block.id, name: block.name, input: block.input, running: false };
          entryTools.push(tool);
          tools.set(block.id, tool);
        }
      }
      if (thinking || text || entryTools.length) {
        entries.push({ kind: 'assistant', id: entries.length, thinking, text, tools: entryTools });
      }
      continue;
    }
    let userText = '';
    const attachments: string[] = [];
    for (const block of message.content) {
      if (block.type === 'text') {
        const attached = attachedFilePath(block.text);
        if (attached !== null) attachments.push(attached);
        else userText += block.text;
      } else if (block.type === 'tool_result') {
        const tool = tools.get(block.toolUseId);
        const display = displays.get(block.toolUseId);
        if (tool) {
          tool.result = {
            content: block.content,
            ...(block.isError ? { isError: true } : {}),
            ...(display ? { display } : {}),
          };
        }
      }
    }
    if (userText || attachments.length > 0) {
      entries.push({ kind: 'user', id: entries.length, text: userText, ...(attachments.length > 0 ? { attachments } : {}) });
    }
  }
  return entries;
}
