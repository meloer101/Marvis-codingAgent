import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ExternalLink, LoaderCircle } from 'lucide-react';

import type { GitFile, GitStatus } from '@harness-code/protocol';

import { Button } from '@/components/ui/button';
import type { Checkout } from '@/lib/checkout';
import { pathsOf } from '@/lib/gitFiles';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';
import { platform } from '@/platform';

type Note = { tone: 'ok' | 'error'; text: string; url?: string };

/**
 * Commit, push and pull request, under the changes list. A commit takes what
 * is staged — or, when nothing is, the files the list shows. Push publishes a
 * branch that has no upstream yet. What each did, or why it couldn't, shows
 * in a line beneath.
 */
export function CommitBox({
  checkout,
  status,
  files,
}: {
  checkout: Checkout;
  status: Extract<GitStatus, { repo: true }>;
  files: readonly GitFile[];
}) {
  const sync = useSync();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'commit' | 'push' | 'pr' | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [lastSummary, setLastSummary] = useState<string | null>(null);
  const [pr, setPr] = useState<{ title: string; body: string; draft: boolean } | null>(null);

  const staged = status.files.filter((f) => f.staged !== undefined).length;
  const toCommit = staged > 0 ? staged : files.length;
  const canCommit = busy === null && message.trim() !== '' && toCommit > 0;
  const published = status.upstream !== undefined;
  const canPush = busy === null && status.branch !== null && (!published || status.ahead > 0);

  const act = async (what: 'commit' | 'push' | 'pr', fn: () => Promise<Note>): Promise<void> => {
    setBusy(what);
    setNote(null);
    try {
      setNote(await fn());
    } catch (err) {
      setNote({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const commit = (): void => {
    if (!canCommit) return;
    void act('commit', async () => {
      const done = await sync.gitCommit(checkout, message, staged > 0 ? undefined : files.flatMap(pathsOf));
      setMessage('');
      setLastSummary(done.summary);
      return { tone: 'ok', text: `Committed ${done.sha} · ${done.summary}` };
    });
  };
  const push = (): void => {
    if (!canPush) return;
    void act('push', async () => {
      await sync.gitPush(checkout);
      return { tone: 'ok', text: published ? `Pushed ${status.branch}` : `Published ${status.branch}` };
    });
  };
  const openPr = (): void => {
    if (!pr || pr.title.trim() === '') return;
    void act('pr', async () => {
      const { url } = await sync.gitCreatePr(checkout, {
        title: pr.title.trim(),
        ...(pr.body.trim() ? { body: pr.body } : {}),
        ...(pr.draft ? { draft: true } : {}),
      });
      setPr(null);
      return { tone: 'ok', text: 'Pull request opened', ...(url ? { url } : {}) };
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    }
  };

  return (
    <div className="flex shrink-0 flex-col gap-2 p-3">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        placeholder="Commit message"
        aria-label="Commit message"
        className="field-sizing-content max-h-40 min-h-16 w-full resize-none rounded-md bg-background px-2.5 py-2 text-[13px] outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/30"
      />
      <div className="flex items-center gap-1.5">
        <Button size="sm" onClick={commit} disabled={!canCommit}>
          {busy === 'commit' && <LoaderCircle className="animate-spin" />}
          {staged > 0 ? `Commit ${staged} staged` : `Commit ${toCommit} ${toCommit === 1 ? 'file' : 'files'}`}
          <kbd className="font-mono text-[11px] font-normal text-faint">⌘↵</kbd>
        </Button>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          onClick={push}
          disabled={!canPush}
          title={status.branch === null ? 'Check out a branch to push' : published ? `Push to ${status.upstream}` : 'Publish the branch'}
        >
          {busy === 'push' && <LoaderCircle className="animate-spin" />}
          {published ? 'Push' : 'Publish'}
          {published && status.ahead > 0 && (
            <span className="font-mono text-[11px] font-normal text-faint tabular-nums">↑{status.ahead}</span>
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPr(pr ? null : { title: lastSummary ?? '', body: '', draft: false })}
          disabled={busy !== null || !published}
          aria-expanded={pr !== null}
          title={published ? 'Open a pull request with the GitHub CLI' : 'Publish the branch first'}
        >
          Pull request
        </Button>
      </div>
      {pr && (
        <div className="flex flex-col gap-1.5 rounded-md bg-background p-2">
          <input
            autoFocus
            value={pr.title}
            onChange={(e) => setPr({ ...pr, title: e.target.value })}
            placeholder="Title"
            aria-label="Pull request title"
            className="rounded-md bg-subtle px-2 py-1 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          <textarea
            value={pr.body}
            onChange={(e) => setPr({ ...pr, body: e.target.value })}
            rows={3}
            placeholder="Description (optional)"
            aria-label="Pull request description"
            className="resize-none rounded-md bg-subtle px-2 py-1 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" className="accent-ink" checked={pr.draft} onChange={(e) => setPr({ ...pr, draft: e.target.checked })} />
              Draft
            </label>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => setPr(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={openPr} disabled={busy !== null || pr.title.trim() === ''}>
              {busy === 'pr' && <LoaderCircle className="animate-spin" />}
              Create
            </Button>
          </div>
        </div>
      )}
      {note && (
        <p
          role={note.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'max-h-28 overflow-y-auto text-xs break-words whitespace-pre-wrap',
            note.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {note.text}
          {note.url && (
            <button
              type="button"
              onClick={() => platform.openExternal(note.url!)}
              className="ml-1.5 inline-flex items-center gap-1 text-primary hover:underline"
            >
              {note.url.replace(/^https?:\/\//, '')}
              <ExternalLink className="size-3" />
            </button>
          )}
        </p>
      )}
    </div>
  );
}
