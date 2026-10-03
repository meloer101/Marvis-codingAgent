import { useCallback, useMemo, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { LoaderCircle, MessageSquareText, Pencil, X } from 'lucide-react';

import { DiffView } from '@/components/DiffView';
import { Button } from '@/components/ui/button';
import type { DiffLine, LineDiff } from '@/lib/diff';
import { langForPath } from '@/lib/highlight';
import { addComment, clearReview, removeComment, reviewMessage, updateComment, useReview } from '@/lib/review';
import type { ReviewComment } from '@/lib/review';
import { useSync } from '@/lib/syncContext';

/*
 * Review comments on the Changes panel's diffs: a line's number opens one,
 * the comments sit under their lines, and a bar sends them all to the
 * session's agent as one message (lib/review.ts).
 */

/** Where a comment on `line` lives: an added or unchanged line by its number now, a removed one by its old number. */
function anchor(line: DiffLine): { side: 'old' | 'new'; line: number } | null {
  if (line.kind === 'hunk') return null;
  return line.kind === 'del' ? { side: 'old', line: line.oldNo ?? 0 } : { side: 'new', line: line.newNo ?? 0 };
}

export function ReviewableDiff({
  sessionId,
  path,
  diff,
  hunkActions,
}: {
  sessionId: string;
  path: string;
  diff: LineDiff;
  hunkActions?: ((hunk: number) => ReactNode) | undefined;
}) {
  const all = useReview(sessionId);
  const comments = useMemo(() => all.filter((c) => c.path === path), [all, path]);
  const [drafting, setDrafting] = useState<{ side: 'old' | 'new'; line: number; excerpt: string } | null>(null);
  const onLineClick = useCallback((l: DiffLine) => {
    const at = anchor(l);
    if (at) setDrafting({ ...at, excerpt: l.text });
  }, []);
  const renderAfter = (l: DiffLine) => {
    const at = anchor(l);
    if (!at) return null;
    const here = comments.filter((c) => c.side === at.side && c.line === at.line);
    const draftingHere = drafting?.side === at.side && drafting.line === at.line;
    if (here.length === 0 && !draftingHere) return null;
    return (
      <div className="flex flex-col gap-1.5 font-sans">
        {here.map((c) => (
          <CommentCard key={c.id} sessionId={sessionId} comment={c} />
        ))}
        {draftingHere && drafting && (
          <CommentEditor
            onSave={(body) => {
              addComment(sessionId, { path, ...drafting, body });
              setDrafting(null);
            }}
            onCancel={() => setDrafting(null)}
          />
        )}
      </div>
    );
  };
  return (
    <DiffView
      diff={diff}
      lang={langForPath(path) ?? undefined}
      className="max-h-none bg-subtle"
      onLineClick={onLineClick}
      renderAfter={renderAfter}
      hunkActions={hunkActions}
    />
  );
}

function CommentCard({ sessionId, comment }: { sessionId: string; comment: ReviewComment }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <CommentEditor
        initial={comment.body}
        onSave={(body) => {
          updateComment(sessionId, comment.id, body);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <div className="group/comment flex items-start gap-2 rounded-md bg-muted px-2.5 py-1.5 font-sans text-xs">
      <MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-primary" />
      <p className="min-w-0 flex-1 whitespace-pre-wrap">{comment.body}</p>
      <span className="flex shrink-0 opacity-60 transition-opacity group-hover/comment:opacity-100">
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="Edit comment"
          className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <Pencil className="size-3" />
        </button>
        <button
          type="button"
          onClick={() => removeComment(sessionId, comment.id)}
          aria-label="Delete comment"
          className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </span>
    </div>
  );
}

function CommentEditor({ initial = '', onSave, onCancel }: { initial?: string; onSave: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState(initial);
  const save = (): void => {
    if (body.trim() !== '') onSave(body.trim());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault(); // closes the editor; must not also stop a run
      e.stopPropagation();
      onCancel();
    }
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-muted p-1.5 font-sans">
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        placeholder="Comment for the agent — ⌘↵ to save"
        aria-label="Review comment"
        className="field-sizing-content max-h-40 min-h-10 resize-none rounded-md bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      />
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={body.trim() === ''}>
          {initial ? 'Save' : 'Comment'}
        </Button>
      </div>
    </div>
  );
}

/** The session's pending review comments, sent to its agent as one message. */
export function ReviewBar({ sessionId }: { sessionId: string }) {
  const sync = useSync();
  const comments = useReview(sessionId);
  const [sending, setSending] = useState(false);
  if (comments.length === 0) return null;
  const send = async (): Promise<void> => {
    setSending(true);
    try {
      if (await sync.send(sessionId, reviewMessage(comments))) clearReview(sessionId);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="mx-3 mt-2 flex shrink-0 items-center gap-2 rounded-lg bg-background px-3 py-2 text-xs">
      <MessageSquareText className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 truncate">
        {comments.length} review {comments.length === 1 ? 'comment' : 'comments'}
      </span>
      <span className="flex-1" />
      <Button size="sm" variant="ghost" onClick={() => clearReview(sessionId)} disabled={sending}>
        Discard
      </Button>
      <Button size="sm" onClick={() => void send()} disabled={sending}>
        {sending && <LoaderCircle className="animate-spin" />}
        Send to agent
      </Button>
    </div>
  );
}
