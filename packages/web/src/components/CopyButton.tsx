import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

import { cn } from '@/lib/utils';

/** Copies `text`, showing a check for a moment. Styling (and when it shows) is the caller's. */
export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}
      aria-label={label}
      title={copied ? 'Copied' : label}
      className={cn(
        'rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        className,
      )}
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </button>
  );
}
