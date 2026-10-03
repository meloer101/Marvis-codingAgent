import { useMemo, type CSSProperties } from 'react';

import { useStickToBottom } from '@/hooks/useStickToBottom';
import { hasAnsi, parseAnsi } from '@/lib/ansi';
import type { AnsiStyle } from '@/lib/ansi';
import { cn } from '@/lib/utils';

const color = (c: number | string): string => (typeof c === 'number' ? `var(--ansi-${c % 8})` : c);

function css(style: AnsiStyle): CSSProperties | undefined {
  if (Object.keys(style).length === 0) return undefined;
  return {
    ...(style.fg !== undefined ? { color: color(style.fg) } : {}),
    ...(style.bg !== undefined ? { background: `color-mix(in oklch, ${color(style.bg)} 22%, transparent)` } : {}),
    ...(style.bold ? { fontWeight: 600 } : {}),
    ...(style.dim ? { opacity: 0.65 } : {}),
    ...(style.italic ? { fontStyle: 'italic' } : {}),
    ...(style.underline ? { textDecoration: 'underline' } : {}),
  };
}

/**
 * A command's output, terminal colours kept. A finished one reads from the
 * top; a `live` one follows the tail as it grows, unless the reader scrolls up.
 */
export function TerminalOutput({ text, error = false, live = false }: { text: string; error?: boolean; live?: boolean }) {
  if (live) return <LiveOutput text={text} />;
  return (
    <div className="max-h-80 overflow-auto">
      <Text text={text} error={error} />
    </div>
  );
}

function LiveOutput({ text }: { text: string }) {
  const { ref, onScroll } = useStickToBottom<HTMLDivElement>(text.length);
  return (
    <div ref={ref} onScroll={onScroll} className="max-h-60 overflow-auto">
      <Text text={text} />
    </div>
  );
}

/** Output in the card's type, colours kept, unscrolled: the caller decides how it scrolls. */
export function TerminalText({ text, error = false }: { text: string; error?: boolean }) {
  return <Text text={text} error={error} />;
}

function Text({ text, error = false }: { text: string; error?: boolean }) {
  const spans = useMemo(() => (hasAnsi(text) ? parseAnsi(text) : null), [text]);
  return (
    <pre
      className={cn(
        'px-3 pt-2 pb-2.5 font-mono text-xs leading-[1.55] whitespace-pre-wrap text-muted-foreground',
        error && 'text-destructive',
      )}
    >
      {spans
        ? spans.map((s, i) =>
            Object.keys(s.style).length === 0 ? (
              s.text
            ) : (
              <span key={i} style={css(s.style)}>
                {s.text}
              </span>
            ),
          )
        : text}
    </pre>
  );
}
