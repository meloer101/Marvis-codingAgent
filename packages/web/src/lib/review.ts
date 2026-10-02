import { useSyncExternalStore } from 'react';

import { platform } from '@/platform';

/**
 * Review comments a session's user leaves on lines of the project's diff, to
 * send to its agent as one message. Kept per session across reloads, like a
 * composer draft.
 */
export interface ReviewComment {
  id: string;
  path: string;
  /** `new`: a line as it is now (added or unchanged); `old`: a removed one. */
  side: 'old' | 'new';
  line: number;
  /** The line's text, quoted in the message. */
  excerpt: string;
  body: string;
}

const key = (sessionId: string): string => `hc.review.${sessionId}`;
const EMPTY: readonly ReviewComment[] = [];
const cache = new Map<string, readonly ReviewComment[]>();
const listeners = new Set<() => void>();

function read(sessionId: string): readonly ReviewComment[] {
  let comments = cache.get(sessionId);
  if (!comments) {
    try {
      const parsed = JSON.parse(platform.storage.get(key(sessionId)) ?? '[]') as unknown;
      comments = Array.isArray(parsed) ? (parsed as ReviewComment[]) : EMPTY;
    } catch {
      comments = EMPTY;
    }
    cache.set(sessionId, comments);
  }
  return comments;
}

function write(sessionId: string, comments: readonly ReviewComment[]): void {
  cache.set(sessionId, comments);
  if (comments.length === 0) platform.storage.remove(key(sessionId));
  else platform.storage.set(key(sessionId), JSON.stringify(comments));
  listeners.forEach((l) => l());
}

export function addComment(sessionId: string, comment: Omit<ReviewComment, 'id'>): void {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  write(sessionId, [...read(sessionId), { ...comment, id }]);
}

export function updateComment(sessionId: string, id: string, body: string): void {
  write(sessionId, read(sessionId).map((c) => (c.id === id ? { ...c, body } : c)));
}

export function removeComment(sessionId: string, id: string): void {
  write(sessionId, read(sessionId).filter((c) => c.id !== id));
}

export function clearReview(sessionId: string): void {
  write(sessionId, EMPTY);
}

export function useReview(sessionId: string): readonly ReviewComment[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => read(sessionId),
  );
}

/**
 * The comments as one message to the agent, file by file and line by line,
 * each with the line it is about quoted.
 */
export function reviewMessage(comments: readonly ReviewComment[]): string {
  const sorted = [...comments].sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1),
  );
  const parts = sorted.map((c) => {
    const where = c.side === 'old' ? `removed line ${c.line}` : `line ${c.line}`;
    const quote = c.excerpt.trim() === '' ? '> (blank line)' : `> ${c.excerpt}`;
    return `\`${c.path}\` ${where}:\n${quote}\n${c.body.trim()}`;
  });
  const n = comments.length;
  return `Review comments on the current changes (${n} ${n === 1 ? 'comment' : 'comments'}) — please address ${n === 1 ? 'it' : 'each'}:\n\n${parts.join('\n\n')}`;
}
