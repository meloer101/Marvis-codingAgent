import { Fragment, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import {
  CodeXml,
  ListTodo,
  Heading1,
  Heading2,
  Heading3,
  Image,
  List,
  ListOrdered,
  Minus,
  Quote,
  Type,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { BlockDef, BlockId } from '@/lib/composerMenu';
import type { SlashCommand } from '@/lib/slash';
import { cn } from '@/lib/utils';

const SOURCE_LABEL: Record<SlashCommand['source'], string> = {
  client: 'app',
  server: 'session',
  mcp: 'mcp',
  skill: 'skill',
};

const BLOCK_ICON: Record<BlockId, LucideIcon> = {
  text: Type,
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  bullet: List,
  numbered: ListOrdered,
  todo: ListTodo,
  quote: Quote,
  code: CodeXml,
  divider: Minus,
  image: Image,
};

export type SlashItem = { kind: 'command'; command: SlashCommand } | { kind: 'block'; block: BlockDef };

/**
 * The `/` menu, anchored above the composer: commands (when the `/` starts the
 * message), then blocks to insert. `active` indexes the two as one list.
 */
export function SlashMenu({
  items,
  active,
  onPick,
}: {
  items: readonly SlashItem[];
  active: number;
  onPick: (item: SlashItem) => void;
}) {
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    // Guarded: jsdom (and old WebViews) have no scrollIntoView.
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  if (items.length === 0) return null;
  const firstBlock = items.findIndex((i) => i.kind === 'block');
  const hasCommands = firstBlock !== 0;

  const row = (item: SlashItem, i: number, body: ReactNode) => (
    <li
      key={item.kind === 'command' ? `${item.command.source}:${item.command.name}` : `block:${item.block.id}`}
      ref={i === active ? activeRef : null}
      role="option"
      aria-selected={i === active}
      // Keep focus in the editor: mousedown would blur it first.
      onMouseDown={(e) => {
        e.preventDefault();
        onPick(item);
      }}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
        i === active && 'bg-accent text-accent-foreground',
      )}
    >
      {body}
    </li>
  );

  return (
    <ul
      role="listbox"
      aria-label="Commands and blocks"
      className="absolute bottom-full left-0 z-10 mb-2 max-h-72 w-full overflow-y-auto rounded-lg border bg-popover p-1 shadow-xl"
    >
      {items.map((item, i) => {
        const heading =
          i === 0 && hasCommands ? 'Commands' : i === firstBlock && hasCommands ? 'Insert' : null;
        const body =
          item.kind === 'command' ? (
            <>
              <span className="font-mono text-[13px] text-primary">/{item.command.name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.command.hint}</span>
              <span className="shrink-0 rounded bg-muted px-1 text-[11px] font-medium tracking-[0.02em] text-faint">
                {SOURCE_LABEL[item.command.source]}
              </span>
            </>
          ) : (
            <BlockRow block={item.block} />
          );
        return heading ? (
          <Fragment key={`h:${heading}`}>
            <li
              role="presentation"
              className={cn('px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-faint', i > 0 && 'mt-1 border-t pt-2')}
            >
              {heading}
            </li>
            {row(item, i, body)}
          </Fragment>
        ) : (
          row(item, i, body)
        );
      })}
    </ul>
  );
}

function BlockRow({ block }: { block: BlockDef }) {
  const Icon = BLOCK_ICON[block.id];
  return (
    <>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{block.label}</span>
      {block.shortcut && <span className="shrink-0 font-mono text-[11px] text-faint">{block.shortcut}</span>}
    </>
  );
}
