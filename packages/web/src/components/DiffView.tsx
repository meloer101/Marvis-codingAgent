import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

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
 * the words that changed within a replaced line marked a shade deeper. Also a
 * plain file (all unchanged lines, no sign column); `focusLine` (a new-side
 * number) is scrolled to and marked. With `onLineClick`, a line's number is a
 * button (to comment on it), `renderAfter` puts content under a line, and
 * `hunkActions` at the end of each hunk's header (by the hunk's index).
 */
export function DiffView({
  diff,
  lang,
  className,
  focusLine,
  onLineClick,
  renderAfter,
  hunkActions,
}: {
  diff: LineDiff;
  lang?: string | undefined;
  className?: string;
  focusLine?: number | undefined;
  onLineClick?: ((line: DiffLine) => void) | undefined;
  renderAfter?: ((line: DiffLine) => ReactNode) | undefined;
  hunkActions?: ((hunk: number) => ReactNode) | undefined;
}) {
  const [all, setAll] = useState(() => focusLine !== undefined && focusLine > FIRST_LINES);
  const tokens = useDiffTokens(diff, lang);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusLine === undefined) return;
    if (focusLine > FIRST_LINES) setAll(true);
    ref.current?.querySelector(`[data-line="${focusLine}"]`)?.scrollIntoView?.({ block: 'center' });
  }, [focusLine, diff]);
  const shown = all ? diff.lines : diff.lines.slice(0, FIRST_LINES);
  let hunk = -1;
  const hidden = diff.lines.length - shown.length;
  // A number column per side that has numbers: a new file has only the "after" one.
  const cols = useMemo(
    () => ({
      old: diff.lines.some((l) => l.oldNo !== undefined),
      new: diff.lines.some((l) => l.newNo !== undefined),
      sign: diff.lines.some((l) => l.kind === 'add' || l.kind === 'del'),
    }),
    [diff],
  );
  return (
    <div ref={ref} className={cn('max-h-96 overflow-auto font-mono text-[11px] leading-relaxed', className)}>
      <table className="w-full border-collapse">
        <tbody>
          {shown.map((line, i) => {
            const after = renderAfter?.(line);
            if (line.kind === 'hunk') hunk++;
            const actions = line.kind === 'hunk' ? hunkActions?.(hunk) : undefined;
            return (
              <Fragment key={i}>
                <Row
                  line={line}
                  oldCol={cols.old}
                  newCol={cols.new}
                  signCol={cols.sign}
                  focused={focusLine !== undefined && line.newNo === focusLine}
                  tokens={tokens?.[i]}
                  onNumberClick={onLineClick}
                  actions={actions}
                />
                {after && (
                  <tr>
                    <td colSpan={(cols.old ? 1 : 0) + (cols.new ? 1 : 0) + (cols.sign ? 2 : 1)} className="px-2 py-1.5">
                      {after}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
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
  signCol,
  focused,
  tokens,
  onNumberClick,
  actions,
}: {
  line: DiffLine;
  oldCol: boolean;
  newCol: boolean;
  signCol: boolean;
  focused: boolean;
  tokens: Token[] | undefined;
  onNumberClick?: ((line: DiffLine) => void) | undefined;
  /** At the end of a hunk's header. */
  actions?: ReactNode;
}) {
  const segments = useMemo(() => lineSegments(line.text, tokens, line.changes), [line, tokens]);
  if (line.kind === 'hunk') {
    return (
      <tr className="group/hunk bg-primary/5 text-muted-foreground">
        <td colSpan={(oldCol ? 1 : 0) + (newCol ? 1 : 0) + (signCol ? 2 : 1)} className="px-2 py-0.5 select-none">
          {actions ? (
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 whitespace-pre-wrap">{line.text}</span>
              <span className="flex shrink-0 items-center gap-0.5 font-sans">{actions}</span>
            </div>
          ) : (
            <span className="whitespace-pre-wrap">{line.text}</span>
          )}
        </td>
      </tr>
    );
  }
  return (
    <tr
      data-line={line.newNo}
      className={cn(
        line.kind === 'add' && 'bg-success/10',
        line.kind === 'del' && 'bg-destructive/10',
        focused && 'bg-primary/10',
      )}
    >
      {oldCol && <LineNo n={line.oldNo} {...(onNumberClick ? { onClick: () => onNumberClick(line) } : {})} />}
      {newCol && <LineNo n={line.newNo} {...(onNumberClick ? { onClick: () => onNumberClick(line) } : {})} />}
      {signCol && (
        <td
          className={cn(
            'w-5 px-1 text-center align-top select-none',
            line.kind === 'add' ? 'text-success' : line.kind === 'del' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
        </td>
      )}
      <td className={cn('shiki-wrap pr-3 whitespace-pre-wrap break-all', !signCol && 'pl-2')}>
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

function LineNo({ n, onClick }: { n: number | undefined; onClick?: () => void }) {
  return (
    <td className="w-px px-1.5 text-right align-top text-muted-foreground/70 tabular-nums select-none">
      {onClick && n !== undefined ? (
        <button
          type="button"
          onClick={onClick}
          aria-label={`Comment on line ${n}`}
          title="Comment on this line"
          className="w-full rounded-sm text-right tabular-nums transition-colors hover:bg-primary/15 hover:text-primary"
        >
          {n}
        </button>
      ) : (
        n
      )}
    </td>
  );
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
