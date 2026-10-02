import { useEffect, useState } from 'react';

import { CopyButton } from '@/components/CopyButton';
import { highlight } from '@/lib/highlight';
import { cn } from '@/lib/utils';

/**
 * A fenced code block: plain while streaming (re-highlighting every frame is
 * wasted work and flickers), Shiki once settled. Shiki escapes the code, so
 * its HTML is safe to inject.
 */
export function CodeBlock({
  code,
  lang,
  streaming = false,
  className,
}: {
  code: string;
  lang?: string | undefined;
  streaming?: boolean;
  className?: string;
}) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (streaming) return;
    let cancelled = false;
    void highlight(code, lang).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang, streaming]);

  return (
    <div className={cn('group/code relative my-2 overflow-hidden rounded-md border bg-muted/40', className)}>
      {lang && (
        <div className="border-b px-3 py-1 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
          {lang}
        </div>
      )}
      <CopyButton
        text={code}
        label="Copy code"
        className="absolute top-1 right-1 opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100"
      />
      {html && !streaming ? (
        <div className="shiki-wrap overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
