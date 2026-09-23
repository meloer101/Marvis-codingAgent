/**
 * Tolerant matching for `edit` when `oldString` has no exact match.
 *
 * Weak models often copy a block with the wrong trailing whitespace, the wrong
 * indentation, or "smart" punctuation where the file has ASCII. Rather than fail
 * the edit and spend a turn on a re-read, retry line by line with progressively
 * looser comparisons — ported from codex's `apply-patch/src/seek_sequence.rs`:
 *
 *   1. ignore trailing whitespace (also absorbs CRLF vs LF)
 *   2. ignore leading and trailing whitespace
 *   3. additionally fold Unicode dashes, quotes and spaces to ASCII
 *
 * Each tier still demands a single match; the first tier with any match decides
 * (a unique match wins, several is reported as ambiguous). Matching is always on
 * whole lines, so the replaced span runs from the start of the first matched line
 * to the end of the last.
 */

export type MatchTier = 'trailing-whitespace' | 'surrounding-whitespace' | 'unicode';

export const TIER_LABEL: Record<MatchTier, string> = {
  'trailing-whitespace': 'ignoring trailing whitespace',
  'surrounding-whitespace': 'ignoring leading and trailing whitespace',
  unicode: 'ignoring whitespace and Unicode punctuation',
};

export type FuzzyMatch =
  | { kind: 'unique'; tier: MatchTier; start: number; end: number; crlf: boolean }
  | { kind: 'ambiguous'; tier: MatchTier; count: number }
  | { kind: 'none'; hint?: string };

const TIERS: ReadonlyArray<readonly [MatchTier, (line: string) => string]> = [
  ['trailing-whitespace', (l) => l.trimEnd()],
  ['surrounding-whitespace', (l) => l.trim()],
  ['unicode', (l) => normalizeUnicode(l).trim()],
];

/** Lines of `text` with the offset each starts at; a `\r` before `\n` stays on the line. */
function splitLines(text: string): { lines: string[]; starts: number[] } {
  const lines: string[] = [];
  const starts: number[] = [];
  let at = 0;
  for (;;) {
    const nl = text.indexOf('\n', at);
    starts.push(at);
    if (nl === -1) {
      lines.push(text.slice(at));
      break;
    }
    lines.push(text.slice(at, nl));
    at = nl + 1;
  }
  return { lines, starts };
}

export function findFuzzyMatch(text: string, oldString: string): FuzzyMatch {
  const file = splitLines(text);
  let needle = oldString.split('\n');
  // A trailing newline in oldString means "through the end of the last line".
  const throughNewline = needle.length > 1 && needle[needle.length - 1] === '';
  if (throughNewline) needle = needle.slice(0, -1);
  if (needle.every((l) => l.trim() === '')) return { kind: 'none' };

  for (const [tier, norm] of TIERS) {
    const want = needle.map(norm);
    const have = file.lines.map(norm);
    const hits: number[] = [];
    for (let i = 0; i + want.length <= have.length; i++) {
      let ok = true;
      for (let j = 0; j < want.length; j++) {
        if (have[i + j] !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) hits.push(i);
    }
    if (hits.length > 1) return { kind: 'ambiguous', tier, count: hits.length };
    if (hits.length === 1) {
      const first = hits[0]!;
      const last = first + want.length - 1;
      const lastLine = file.lines[last]!;
      const crlf = lastLine.endsWith('\r');
      let end = file.starts[last]! + lastLine.length - (crlf ? 1 : 0);
      if (throughNewline && last + 1 < file.lines.length) end = file.starts[last + 1]!;
      return { kind: 'unique', tier, start: file.starts[first]!, end, crlf };
    }
  }
  return { kind: 'none', hint: closestLineHint(file.lines, needle) };
}

/**
 * Point at where `oldString` diverges from the file: the first of its lines that
 * appears nowhere in the file (even loosely), next to the file line most like it.
 */
function closestLineHint(fileLines: string[], needle: string[]): string | undefined {
  const norm = (l: string) => normalizeUnicode(l).trim();
  const present = new Set(fileLines.map(norm));
  const missing = needle.find((l) => l.trim() !== '' && !present.has(norm(l)));
  if (missing === undefined) {
    return 'Every line of oldString exists in the file, but not as one contiguous block.';
  }
  let best = -1;
  let bestScore = 0;
  const target = norm(missing);
  for (let i = 0; i < fileLines.length; i++) {
    const score = similarity(target, norm(fileLines[i]!));
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best === -1 || bestScore < 0.5) return undefined;
  return (
    `Closest to your line ${JSON.stringify(clip(missing.trim()))} is line ${best + 1}: ` +
    JSON.stringify(clip(fileLines[best]!.trim()))
  );
}

function clip(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Dice coefficient over character bigrams: linear time, good enough to rank lines. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      grams.set(g, n - 1);
      shared++;
    }
  }
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/** Fold the typographic characters models tend to substitute to their ASCII forms. */
export function normalizeUnicode(s: string): string {
  return s
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[  -   　]/g, ' ');
}
