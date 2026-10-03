import { useState } from 'react';
import { X } from 'lucide-react';

import type { ImageInput } from '@harness-code/core';

import { Dialog, DialogContent } from '@/components/ui/dialog';
import { imageSrc } from '@/lib/images';

/**
 * Images in a message — in the composer (each with ×) or in the transcript —
 * as small thumbnails; one opens whole in a dialog.
 */
export function ImageThumbs({ images, onRemove }: { images: readonly ImageInput[]; onRemove?: (index: number) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const shown = open !== null ? images[open] : undefined;
  return (
    <>
      <ul className="flex flex-wrap gap-1.5" aria-label="Images">
        {images.map((img, i) => (
          <li key={i} className="group/thumb relative">
            <button
              type="button"
              onClick={() => setOpen(i)}
              aria-label={`Image ${i + 1}`}
              className="block size-14 overflow-hidden rounded-md bg-subtle transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
            >
              <img src={imageSrc(img)} alt="" className="size-full object-cover" />
            </button>
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(i)}
                aria-label={`Remove image ${i + 1}`}
                className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm transition-colors hover:text-foreground"
              >
                <X className="size-2.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <Dialog open={shown !== undefined} onOpenChange={(o) => !o && setOpen(null)}>
        {shown && (
          <DialogContent title={`Image ${open! + 1} of ${images.length}`} className="max-w-[min(90vw,64rem)]">
            <div className="flex min-h-0 justify-center overflow-auto px-5 pt-3 pb-5">
              <img src={imageSrc(shown)} alt="" className="max-h-[70vh] max-w-full rounded-md border object-contain" />
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
