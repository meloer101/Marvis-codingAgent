import { useMemo, useState } from 'react';
import { LoaderCircle, Search, Sparkle } from 'lucide-react';

import type { SkillInfo } from '@harness-code/protocol';

import { Dialog, DialogContent } from '@/components/ui/dialog';
import { routeToHash } from '@/lib/route';

/**
 * `/skills`: the session's installed skills. Picking one starts the message
 * with `/name`, for the task to be typed after it.
 */
export function SkillsDialog({
  skills,
  onPick,
  onClose,
}: {
  /** Undefined while loading. */
  skills: readonly SkillInfo[] | undefined;
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = skills ?? [];
    return q ? list.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) : list;
  }, [skills, filter]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Skills" description="Instruction sets the agent loads on demand. Pick one to start your message with it.">
        <div className="flex min-h-0 flex-col gap-2 px-5 pt-3 pb-5">
          {skills && skills.length > 6 && (
            <label className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-sm focus-within:border-primary/45 focus-within:ring-2 focus-within:ring-primary/20">
              <Search className="size-3.5 text-muted-foreground" />
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter skills"
                aria-label="Filter skills"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
              />
            </label>
          )}
          {skills === undefined ? (
            <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" /> Loading skills…
            </p>
          ) : shown.length === 0 ? (
            <p className="py-4 text-[13px] text-muted-foreground">
              {skills.length === 0 ? 'No skills yet.' : 'No skill matches.'}
            </p>
          ) : (
            <ul className="-mx-1 max-h-[50vh] overflow-y-auto">
              {shown.map((s) => (
                <li key={s.name}>
                  <button
                    type="button"
                    onClick={() => onPick(s.name)}
                    className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  >
                    <Sparkle className="mt-0.5 size-3.5 shrink-0 text-primary/70" />
                    <span className="flex min-w-0 flex-col">
                      <span className="font-mono text-[13px] text-primary">/{s.name}</span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">{s.description}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <a
            href={routeToHash({ kind: 'settings', section: 'skills' })}
            onClick={onClose}
            className="w-fit text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            Add or edit skills in Settings
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
