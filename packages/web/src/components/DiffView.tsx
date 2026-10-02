import { memo, useEffect, useMemo, useState } from 'react';

import { diffSides, lineSegments, lineTokens } from '@/lib/diff';
import type { DiffLine, LineDiff } from '@/lib/diff';
import { highlightTokens } from '@/lib/highlight';
import type { Token } from '@/lib/highlight';
import { cn } from '@/lib/utils';

/** Lines shown before "Show all" — a 2,000-line `write` renders in full only when asked. */
const FIRST_LINES = 400;
/** Past this much text, highlighting costs more than it's worth: plain lines. */
const MAX_HIGHLIGHT_CHARS = 200_000;

/**
 * Syntax colours for both sides of a diff, once loaded (plain until then, and
 * for languages without a grammar).
 */
function useDiffTokens(diff: LineDiff, lang: string | undefined): Array<Token[] | undefined> | null {
  const [tokens, setTokens] = useState<Array<Token[] | undefined> | null>(null);
  useEffect(() => {
    setTokens(null);
    if (!lang) return;
    const { before, after } = diffSides(diff);
    if (before.length + after.length > MAX_HIGHLIGHT_CHARS) return;
    let cancelled = false;
    const hasBefore = diff.lines.some((l) => l.kind === 'del');
    void Promise.all([hasBefore ? highlightTokens(before, lang) : null, highlightTokens(after, lang)]).then(([b, a]) => {
      if (!cancelled && (a || b)) setTokens(lineTokens(diff, b, a));
    });
    return () => {
      cancelled = true;
    };
  }, [diff, lang]);
  return tokens;
}

/**
 * A unified diff: file line numbers when known, syntax colours for `lang`, and
 * the words that changed within a replaced line marked a shade deeper.
 */
export function DiffView({ diff, lang, className }: { diff: LineDiff; lang?: string | undefined; className?: string }) {
  const [all, setAll] = useState(false);
  const tokens = useDiffTokens(diff, lang);
  const shown = all ? diff.lines : diff.lines.slice(0, FIRST_LINES);
  const hidden = diff.lines.length - shown.length;
  // A number column per side that has numbers: a new file has only the "after" one.
  const cols = useMemo(
    () => ({ old: diff.lines.some((l) => l.oldNo !== undefined), new: diff.lines.some((l) => l.newNo !== undefined) }),
    [diff],
  );
  return (
    <div className={cn('max-h-96 overflow-auto font-mono text-[11px] leading-relaxed', className)}>
      <table className="w-full border-collapse">
        <tbody>
          {shown.map((line, i) => (
            <Row key={i} line={line} oldCol={cols.old} newCol={cols.new} tokens={tokens?.[i]} />
          ))}
        </tbody>
      </table>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="w-full px-3 py-1.5 text-left text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          Show all {diff.lines.length.toLocaleString()} lines ({hidden.toLocaleString()} more)
        </button>
      )}
    </div>
  );
}

const Row = memo(function Row({
  line,
  oldCol,
  newCol,
  tokens,
}: {
  line: DiffLine;
  oldCol: boolean;
  newCol: boolean;
  tokens: Token[] | undefined;
}) {
  const segments = useMemo(() => lineSegments(line.text, tokens, line.changes), [line, tokens]);
  return (
    <tr className={cn(line.kind === 'add' && 'bg-success/10', line.kind === 'del' && 'bg-destructive/10')}>
      {oldCol && <LineNo n={line.oldNo} />}
      {newCol && <LineNo n={line.newNo} />}
      <td
        className={cn(
          'w-5 px-1 text-center align-top select-none',
          line.kind === 'add' ? 'text-success' : line.kind === 'del' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
      </td>
      <td className="shiki-wrap pr-3 whitespace-pre-wrap break-all">
        {segments.length === 0 || line.text === ''
          ? ' '
          : segments.map((s, i) =>
              s.style || s.changed ? (
                <span
                  key={i}
                  style={s.style}
                  className={cn(
                    s.changed && (line.kind === 'add' ? 'bg-success/25' : 'bg-destructive/25'),
                  )}
                >
                  {s.text}
                </span>
              ) : (
                s.text
              ),
            )}
      </td>
    </tr>
  );
});

function LineNo({ n }: { n: number | undefined }) {
  return <td className="w-px px-1.5 text-right align-top text-muted-foreground/70 tabular-nums select-none">{n}</td>;
}

export function DiffStat({ diff }: { diff: LineDiff }) {
  return (
    <span className="shrink-0 font-mono text-[11px]">
      {diff.added > 0 && <span className="text-success">+{diff.added}</span>}
      {diff.added > 0 && diff.removed > 0 && ' '}
      {diff.removed > 0 && <span className="text-destructive">−{diff.removed}</span>}
    </span>
  );
}
