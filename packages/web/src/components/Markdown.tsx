import { Suspense, lazy, memo } from 'react';

import type { ImageInput } from '@harness-code/core';

import { cn } from '@/lib/utils';

const MarkdownBody = lazy(() =>
  import('@/components/MarkdownBody').then((m) => ({ default: m.MarkdownBody })),
);

/**
 * Markdown (GFM): the assistant's, and the user's (`breaks`). Loaded on demand
 * so `react-markdown` stays out of the main bundle.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  breaks = false,
  images,
  className,
}: {
  text: string;
  streaming?: boolean;
  breaks?: boolean;
  images?: readonly ImageInput[];
  className?: string;
}) {
  return (
    <Suspense
      fallback={
        <div className={cn('md whitespace-pre-wrap text-sm', className)}>{text}</div>
      }
    >
      <MarkdownBody text={text} streaming={streaming} breaks={breaks} {...(images ? { images } : {})} className={className} />
    </Suspense>
  );
});
