import { useEffect } from 'react';
import { X } from 'lucide-react';

import type { SlashCommand } from '@/lib/slash';

const SHORTCUTS: Array<[string, string]> = [
  ['Enter', 'Send message'],
  ['Shift+Enter', 'New paragraph, or list item (out of the list on an empty one)'],
  ['/', 'Commands (at the start) and blocks to insert'],
  ['@', 'Mention a file'],
  ['- / 1. / [] / > / ```', 'Start a list, to-do, quote or code block'],
  ['⌘B / ⌘I / ⌘E', 'Bold / italic / code'],
  ['Shift+Tab', 'Switch permission mode (in a nested list: outdent)'],
  ['⌘K / Ctrl+K', 'Command palette'],
  ['⇧⌘O / Ctrl+Shift+O', 'New session'],
  ['⇧-click / ⌘-click', 'Sidebar: select a run of sessions / one more'],
  ['⌫ (selection)', 'Delete the selected sessions'],
  ['⌥⌘B / Ctrl+Alt+B', 'Show or hide the changes panel'],
  ['Ctrl+`', 'Show or hide the terminal'],
  ['Ctrl+O', 'Show every tool call, or fold exploration again'],
  ['Esc', 'Stop the current run'],
  ['y / a / s / n', 'Permission prompt: allow once / always / auto mode / deny'],
  ['y / m / e', 'Plan prompt: approve / approve, then review edits / revise'],
  ['Esc (prompt)', 'Deny, or keep planning'],
  ['Esc / ⌘↵ (note)', 'Send the typed note with the deny or revision'],
];

/** `/help`: the commands and keys, as a dismissible panel. */
export function HelpDialog({ commands, onClose }: { commands: SlashCommand[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); // this Escape closes the panel; it must not also stop the run
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/25 p-6 backdrop-blur-[2px]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-lg border bg-popover p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Help"
      >
        <div className="mb-3 flex items-center">
          <h2 className="flex-1 text-sm font-semibold">Commands and shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 transition-colors hover:bg-accent"
          >
            <X className="size-4 text-muted-foreground" />
          </button>
        </div>

        <h3 className="mt-4 mb-1 text-[11px] font-medium tracking-[0.02em] text-faint">
          Commands
        </h3>
        <ul className="space-y-1 text-sm">
          {commands.map((c) => (
            <li key={`${c.source}:${c.name}`} className="flex gap-3">
              <span className="w-32 shrink-0 font-mono text-xs text-primary">/{c.name}</span>
              <span className="text-muted-foreground">{c.hint}</span>
            </li>
          ))}
        </ul>

        <h3 className="mt-4 mb-1 text-[11px] font-medium tracking-[0.02em] text-faint">
          Keyboard
        </h3>
        <ul className="space-y-1 text-sm">
          {SHORTCUTS.map(([keys, what]) => (
            <li key={keys} className="flex gap-3">
              <span className="w-32 shrink-0 font-mono text-xs">{keys}</span>
              <span className="text-muted-foreground">{what}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
