import { useEffect, useRef } from 'react';
import { FileText } from 'lucide-react';

import type { FileMatch } from '@harness-code/protocol';
import { cn } from '@/lib/utils';

/** The `@` completion list, anchored above the composer: file name first, its folder after. */
export function FileMenu({
  files,
  active,
  onPick,
}: {
  files: readonly FileMatch[];
  active: number;
  onPick: (path: string) => void;
}) {
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    // Guarded: jsdom (and old WebViews) have no scrollIntoView.
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  if (files.length === 0) return null;

  return (
    <ul
      role="listbox"
      aria-label="Files"
      className="absolute bottom-full left-0 z-10 mb-2 max-h-64 w-full overflow-y-auto rounded-lg border bg-popover p-1 shadow-xl"
    >
      {files.map((f, i) => {
        const slash = f.path.lastIndexOf('/');
        const name = f.path.slice(slash + 1);
        const dir = slash === -1 ? '' : f.path.slice(0, slash);
        return (
          <li
            key={f.path}
            role="option"
            aria-selected={i === active}
            ref={i === active ? activeRef : null}
            // Keep focus in the textarea: mousedown would blur it first.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(f.path);
            }}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
              i === active && 'bg-accent text-accent-foreground',
            )}
          >
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 font-mono text-[13px]">{name}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" dir="rtl">
              {dir && <bdi>{dir}</bdi>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
