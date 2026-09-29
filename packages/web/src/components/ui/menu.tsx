import { Fragment } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ContextMenu as ContextMenuPrimitive, DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

/** One entry of a menu: the same list drives a ⋯ dropdown and a right-click menu. */
export interface MenuAction {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  /** Draw a separator above this entry. */
  separated?: boolean;
}

const contentClass =
  'z-50 min-w-44 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95';
const itemClass =
  'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none select-none data-[highlighted]:bg-accent [&_svg]:size-3.5 [&_svg]:shrink-0';
const separatorClass = 'my-1 h-px bg-border';

function itemTone(action: MenuAction): string {
  return action.destructive
    ? 'text-destructive [&_svg]:text-destructive'
    : '[&_svg]:text-muted-foreground';
}

/** A ⋯ button (or any `trigger`) opening `actions`. */
export function DropdownActions({ actions, trigger, label }: { actions: MenuAction[]; trigger: ReactElement; label: string }) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild aria-label={label}>
        {trigger}
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content align="end" sideOffset={4} className={contentClass}>
          {actions.map((a) => (
            <Fragment key={a.label}>
              {a.separated && <DropdownMenuPrimitive.Separator className={separatorClass} />}
              <DropdownMenuPrimitive.Item className={cn(itemClass, itemTone(a))} onSelect={a.onSelect}>
                {a.icon}
                {a.label}
              </DropdownMenuPrimitive.Item>
            </Fragment>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

/** Right-clicking `children` opens `actions`. */
export function ContextActions({ actions, children }: { actions: MenuAction[]; children: ReactElement }) {
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content className={contentClass}>
          {actions.map((a) => (
            <Fragment key={a.label}>
              {a.separated && <ContextMenuPrimitive.Separator className={separatorClass} />}
              <ContextMenuPrimitive.Item className={cn(itemClass, itemTone(a))} onSelect={a.onSelect}>
                {a.icon}
                {a.label}
              </ContextMenuPrimitive.Item>
            </Fragment>
          ))}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
