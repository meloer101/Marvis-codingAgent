import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';

/** A native select drawn as a grey chip with a chevron — a filter or a scope, on white. */
export function SelectChip({
  label,
  value,
  onChange,
  children,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('relative flex shrink-0 items-center', className)}>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-[27px] max-w-48 cursor-pointer appearance-none truncate rounded-md bg-muted pr-7 pl-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 size-3 text-muted-foreground" />
    </span>
  );
}
