import { CornerDownRight, Image as ImageIcon, Pencil, X } from 'lucide-react';

import type { QueuedMessage } from '@harness-code/protocol';

/**
 * Messages sent while a run is going, docked above the composer until they go:
 * those for the agent to read at its next step first (steering), then those
 * waiting for the run to end, oldest first. Each can be taken back to edit or
 * dropped until then.
 */
export function QueuedMessages({
  queue,
  onEdit,
  onRemove,
}: {
  queue: readonly QueuedMessage[];
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const steering = queue.filter((q) => q.steer);
  const waiting = queue.filter((q) => !q.steer);
  if (queue.length === 0) return null;
  return (
    <section
      aria-label="Queued messages"
      className="flex animate-rise flex-col gap-1.5 rounded-lg border border-dashed bg-muted/30 px-2 py-1.5"
    >
      {steering.length > 0 && (
        <MessageGroup label="Next step · read before the agent goes on" messages={steering} onEdit={onEdit} onRemove={onRemove} />
      )}
      {waiting.length > 0 && (
        <MessageGroup label="Queued · sent when this turn ends" messages={waiting} onEdit={onEdit} onRemove={onRemove} />
      )}
    </section>
  );
}

function MessageGroup({
  label,
  messages,
  onEdit,
  onRemove,
}: {
  label: string;
  messages: readonly QueuedMessage[];
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="px-1 pb-0.5 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">{label}</p>
      <ul className="flex flex-col">
        {messages.map((q) => (
          <li key={q.id} className="group flex items-start gap-2 rounded-md px-1 py-1 text-[13px] transition-colors hover:bg-accent/60">
            <CornerDownRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span className="line-clamp-2 min-w-0 flex-1 break-words whitespace-pre-wrap">
              {q.images?.length ? (
                <span className="mr-1.5 inline-flex items-center gap-0.5 align-middle font-mono text-[10px] text-muted-foreground">
                  <ImageIcon className="size-3" />
                  {q.images.length}
                </span>
              ) : null}
              {q.text}
            </span>
            <span className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <button
                type="button"
                onClick={() => onEdit(q.id)}
                aria-label="Edit queued message"
                title="Edit — back to the composer"
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onRemove(q.id)}
                aria-label="Remove queued message"
                title="Remove"
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
