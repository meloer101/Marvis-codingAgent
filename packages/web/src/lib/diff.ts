import { diffLines, diffWordsWithSpace } from 'diff';

import type { Token } from './highlight';

export interface DiffLine {
  /** `hunk`: the `@@ -a,b +c,d @@` line that starts a hunk of a patch (`text` is the header). */
  kind: 'add' | 'del' | 'ctx' | 'hunk';
  text: string;
  /** 1-based line numbers in the file before / after, when known. */
  oldNo?: number;
  newNo?: number;
  /**
   * `[start, end)` character ranges that changed, on a removed line paired
   * with the added line that replaced it (and the other way round).
   */
  changes?: Array<[number, number]>;
}

export interface LineDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
}

function splitLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Terminate the last line, so `"a"` → `"a\nb"` diffs as one added line, not a changed one. */
const withEol = (s: string): string => (s === '' || s.endsWith('\n') ? s : `${s}\n`);

/**
 * Line diff of an `edit` call's `oldString` → `newString`. With `startLine`
 * (where the replacement starts in the file — the same before and after) the
 * lines get the file's line numbers.
 */
export function editDiff(oldString: string, newString: string, startLine?: number): LineDiff {
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let oldNo = startLine ?? 0;
  let newNo = startLine ?? 0;
  for (const part of diffLines(withEol(oldString), withEol(newString))) {
    const kind = part.added ? 'add' : part.removed ? 'del' : 'ctx';
    for (const text of splitLines(part.value)) {
      const line: DiffLine = { kind, text };
      if (startLine !== undefined) {
        if (kind !== 'add') line.oldNo = oldNo++;
        if (kind !== 'del') line.newNo = newNo++;
      }
      lines.push(line);
      if (kind === 'add') added++;
      else if (kind === 'del') removed++;
    }
  }
  markWordChanges(lines);
  return { lines, added, removed };
}

/** A `write` call's content as an all-added diff (the prior content isn't in the call); it is the whole file. */
export function writeDiff(content: string): LineDiff {
  const lines = splitLines(content).map((text, i) => ({ kind: 'add' as const, text, newNo: i + 1 }));
  return { lines, added: lines.length, removed: 0 };
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * A one-file unified diff (`git diff` output) as lines with both sides'
 * numbers, one `hunk` line opening each hunk. File headers are dropped.
 */
export function parsePatch(patch: string): LineDiff {
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of splitLines(patch)) {
    const m = HUNK.exec(raw);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      inHunk = true;
      lines.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (!inHunk) continue; // diff --git, index, ---/+++ and mode lines
    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === '+') {
      lines.push({ kind: 'add', text, newNo: newNo++ });
      added++;
    } else if (sign === '-') {
      lines.push({ kind: 'del', text, oldNo: oldNo++ });
      removed++;
    } else if (sign === ' ' || raw === '') {
      lines.push({ kind: 'ctx', text, oldNo: oldNo++, newNo: newNo++ });
    }
    // "\ No newline at end of file" and anything else: not a line of the file.
  }
  markWordChanges(lines);
  return { lines, added, removed };
}

/**
 * A one-file patch's hunks as text, each from its `@@` line — in the order
 * `parsePatch` numbers its `hunk` lines — for `git.applyHunk`.
 */
export function patchHunks(patch: string): string[] {
  const hunks: string[] = [];
  for (const line of splitLines(patch)) {
    if (HUNK.test(line)) hunks.push(`${line}\n`);
    else if (hunks.length > 0) hunks[hunks.length - 1] += `${line}\n`;
  }
  return hunks;
}

/** A file's text as unchanged lines numbered from 1, for viewing it with the diff view. */
export function fileLines(content: string): LineDiff {
  const lines = splitLines(content).map((text, i) => ({ kind: 'ctx' as const, text, newNo: i + 1 }));
  return { lines, added: 0, removed: 0 };
}

/** Lines longer than this are left whole — a minified line isn't worth word-diffing. */
const MAX_WORD_DIFF_CHARS = 500;
/**
 * Below this share of the shorter line left unchanged, a pair is a rewrite:
 * marking words would just be noise. (The shorter line, so text appended to a
 * line still counts as a change to it.)
 */
const MIN_SHARED = 0.5;

/**
 * Pair each run of removed lines with the run of added lines right after it,
 * line by line, and mark the words that differ within each pair.
 */
function markWordChanges(lines: DiffLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== 'del') {
      i++;
      continue;
    }
    const delStart = i;
    while (i < lines.length && lines[i]!.kind === 'del') i++;
    const addStart = i;
    while (i < lines.length && lines[i]!.kind === 'add') i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k++) wordChanges(lines[delStart + k]!, lines[addStart + k]!);
  }
}

function wordChanges(del: DiffLine, add: DiffLine): void {
  if (del.text.length > MAX_WORD_DIFF_CHARS || add.text.length > MAX_WORD_DIFF_CHARS) return;
  const removed: Array<[number, number]> = [];
  const added: Array<[number, number]> = [];
  let o = 0;
  let n = 0;
  let shared = 0;
  for (const part of diffWordsWithSpace(del.text, add.text)) {
    const len = part.value.length;
    if (part.removed) {
      removed.push([o, o + len]);
      o += len;
    } else if (part.added) {
      added.push([n, n + len]);
      n += len;
    } else {
      shared += len;
      o += len;
      n += len;
    }
  }
  if (shared / Math.max(Math.min(del.text.length, add.text.length), 1) < MIN_SHARED) return;
  if (removed.length > 0) del.changes = removed;
  if (added.length > 0) add.changes = added;
}

/** The text before and after, as the diff's lines spell it — what gets highlighted. */
export function diffSides(diff: LineDiff): { before: string; after: string } {
  const side = (skip: DiffLine['kind']): string =>
    diff.lines
      .filter((l) => l.kind !== skip && l.kind !== 'hunk')
      .map((l) => l.text)
      .join('\n');
  return { before: side('add'), after: side('del') };
}

/**
 * Each line's tokens, taken from the highlighted sides: removed lines from
 * `before`, added and unchanged ones from `after`. A line its tokens don't
 * spell exactly gets none, and shows plain.
 */
export function lineTokens(
  diff: LineDiff,
  before: Token[][] | null,
  after: Token[][] | null,
): Array<Token[] | undefined> {
  let o = 0;
  let n = 0;
  return diff.lines.map((line) => {
    if (line.kind === 'hunk') return undefined;
    const tokens = line.kind === 'del' ? before?.[o] : after?.[n];
    if (line.kind !== 'add') o++;
    if (line.kind !== 'del') n++;
    return tokens && tokens.map((t) => t.content).join('') === line.text ? tokens : undefined;
  });
}

export interface Segment {
  text: string;
  style?: Record<string, string>;
  changed?: boolean;
}

/** A line as runs of text, cut wherever a token or a changed range starts or ends. */
export function lineSegments(text: string, tokens?: Token[], changes?: Array<[number, number]>): Segment[] {
  const base: Token[] = tokens ?? [{ content: text }];
  if (!changes?.length) return base.map((t) => (t.style ? { text: t.content, style: t.style } : { text: t.content }));
  const out: Segment[] = [];
  let pos = 0;
  let c = 0;
  for (const tok of base) {
    const end = tok.content.length;
    let start = 0;
    while (start < end) {
      while (c < changes.length && changes[c]![1] <= pos + start) c++;
      const range = changes[c];
      const inside = range !== undefined && range[0] <= pos + start;
      const cut = inside ? Math.min(end, range[1] - pos) : range ? Math.min(end, range[0] - pos) : end;
      out.push({
        text: tok.content.slice(start, cut),
        ...(tok.style ? { style: tok.style } : {}),
        ...(inside ? { changed: true } : {}),
      });
      start = cut;
    }
    pos += end;
  }
  return out;
}
