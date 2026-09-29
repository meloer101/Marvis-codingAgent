/**
 * `@` file mentions in the composer. Typing `@` at the start of a word opens
 * a file menu; picking a file writes `@path` into the text and attaches the
 * file, which is read into the message when it is sent. A file stays attached
 * while its `@path` is still in the text.
 */

export interface Mention {
  /** Index of the `@`. */
  start: number;
  /** What follows it, up to the caret. */
  query: string;
}

/** The `@word` the caret is at the end of, if any: `@` at the start of a word, no whitespace after it. */
export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  const query = m[2] ?? '';
  return { start: caret - query.length - 1, query };
}

/** Replace the mention with `@path ` and say where the caret goes. */
export function insertMention(text: string, mention: Mention, path: string): { text: string; caret: number } {
  const end = mention.start + 1 + mention.query.length;
  const rest = text.slice(end);
  const token = `@${path}`;
  const glue = rest.startsWith(' ') || rest.startsWith('\n') ? '' : ' ';
  return { text: `${text.slice(0, mention.start)}${token}${glue}${rest}`, caret: mention.start + token.length + 1 };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The attached files whose `@path` is still in the text. */
export function presentAttachments(text: string, attached: readonly string[]): string[] {
  return attached.filter((path) => new RegExp(`(^|\\s)@${escapeRe(path)}(?=\\s|$)`).test(text));
}

/** The text without `@path` and the space after it (its chip was removed). */
export function removeMention(text: string, path: string): string {
  return text.replace(new RegExp(`(^|\\s)@${escapeRe(path)}(?: |(?=\\s|$))`, 'g'), '$1');
}
