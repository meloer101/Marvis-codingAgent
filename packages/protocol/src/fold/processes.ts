/**
 * A session's background commands as their events tell it: each one's latest
 * state and the tail of what it printed. The snapshot's `processes` is where a
 * client starts; `process_*` events carry it on.
 */

import type { BackgroundProcessEvent } from '@harness-code/core';

import type { SessionProcess } from '../methods.js';

/** How much of what a background command printed a client keeps, and a snapshot carries. */
export const PROCESS_OUTPUT_CHARS = 64_000;

/** `text`'s last `max` characters, from a line start when one is near, marked as cut. */
export function outputTail(text: string, max = PROCESS_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  let tail = text.slice(-max);
  const nl = tail.indexOf('\n');
  if (nl !== -1 && nl < 1_000) tail = tail.slice(nl + 1);
  return `…\n${tail}`;
}

export function foldProcesses(list: readonly SessionProcess[], event: BackgroundProcessEvent): SessionProcess[] {
  switch (event.type) {
    case 'process_start':
      return [...list.filter((p) => p.id !== event.process.id), { ...event.process, output: '' }];
    case 'process_output':
      return list.map((p) => (p.id === event.id ? { ...p, output: outputTail(p.output + event.text) } : p));
    case 'process_end':
      return list.map((p) => (p.id === event.process.id ? { ...event.process, output: p.output } : p));
  }
}
