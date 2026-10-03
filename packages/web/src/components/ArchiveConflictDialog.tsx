import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';

/**
 * Archiving removes a session's worktree; when it has uncommitted changes the
 * server asks first (`conflict`), from wherever the archive was asked for —
 * the sidebar or the palette. Archiving anyway throws the changes away.
 */
export function ArchiveConflictDialog() {
  const sync = useSync();
  const conflict = useAppStore((s) => s.archiveConflict);
  const title = useAppStore((s) => s.sessions.find((r) => r.id === conflict?.id)?.title);
  const branch = useAppStore((s) => s.sessions.find((r) => r.id === conflict?.id)?.worktree?.branch);
  return (
    <Dialog open={conflict !== null} onOpenChange={(open) => !open && sync.dismissArchiveConflict()}>
      {conflict && (
        <DialogContent
          title="Archive and discard its changes?"
          description={`${conflict.reason.charAt(0).toUpperCase()}${conflict.reason.slice(1)}. What was committed stays on its branch${branch ? ` ${branch}` : ''}.`}
        >
          <div className="flex flex-col gap-4 px-5 pt-3 pb-5">
            {title && <p className="truncate rounded-md border bg-muted/40 px-3 py-2 text-sm">{title}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => sync.dismissArchiveConflict()}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  sync.dismissArchiveConflict();
                  void sync.updateSession(conflict.id, { archived: true, force: true });
                }}
              >
                Discard and archive
              </Button>
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
