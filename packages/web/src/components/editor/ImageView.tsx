import { useState } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import type { ReactNodeViewProps } from '@tiptap/react';
import { X } from 'lucide-react';

import { Dialog, DialogContent } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * An image in the composer, where it sits in the message: small enough to
 * keep writing around, whole in a dialog on a click, × to take it out.
 */
export function ImageView({ node, selected, deleteNode, editor, decorations }: ReactNodeViewProps) {
  const [open, setOpen] = useState(false);
  const number = decorations.map((d) => (d.spec as { imageNumber?: number }).imageNumber).find((n) => n !== undefined);
  const label = number ? `Image #${number}` : 'Image';
  const src = `data:${node.attrs.mediaType as string};base64,${node.attrs.data as string}`;
  return (
    <NodeViewWrapper className="composer-image my-1.5" data-drag-handle="">
      <span className="group/image relative inline-block">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Open ${label}`}
          className={cn(
            'block overflow-hidden rounded-md border bg-subtle transition-shadow',
            selected && 'ring-2 ring-ring/50',
          )}
        >
          <img src={src} alt="" draggable={false} className="block max-h-40 max-w-[min(100%,20rem)] object-contain" />
        </button>
        {/* What the message calls it: write "Image #2" to point at it. */}
        <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-background/85 px-1 font-mono text-[10px] leading-4 text-muted-foreground">
          {label}
        </span>
        {editor.isEditable && (
          <button
            type="button"
            onClick={() => deleteNode()}
            aria-label="Remove image"
            className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover/image:opacity-100 hover:text-foreground focus-visible:opacity-100"
          >
            <X className="size-2.5" />
          </button>
        )}
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <DialogContent title={label} className="max-w-[min(90vw,64rem)]">
            <div className="flex min-h-0 justify-center overflow-auto px-5 pt-3 pb-5">
              <img src={src} alt="" className="max-h-[70vh] max-w-full rounded-md border object-contain" />
            </div>
          </DialogContent>
        )}
      </Dialog>
    </NodeViewWrapper>
  );
}
