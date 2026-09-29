import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { ArrowUp, Square } from 'lucide-react';

import { SlashMenu } from '@/components/SlashMenu';
import { Button } from '@/components/ui/button';
import { filterCommands, slashQuery } from '@/lib/slash';
import type { SlashCommand } from '@/lib/slash';
import { platform } from '@/platform';

const draftKey = (id: string) => `hc.draft.${id}`;

/**
 * Enter sends, Shift+Enter is a newline, and Enter while an IME is composing
 * (Chinese/Japanese input) only confirms the candidate. Typing `/` at the
 * start opens the command menu (↑/↓ to move, Enter or Tab to complete), and
 * Shift+Tab switches the permission mode. While a run is going the send
 * button becomes Stop; the draft survives reloads per session. The footer
 * holds what the next message runs under (`controls`) and, before the send
 * button, `trailing` (the context meter).
 */
export function Composer({
  sessionId,
  running,
  disabled,
  commands,
  onSend,
  onAbort,
  onCommandMenu,
  onCycleMode,
  inputRef,
  controls,
  trailing,
}: {
  sessionId: string;
  running: boolean;
  disabled: boolean;
  commands: SlashCommand[];
  onSend: (text: string) => Promise<boolean>;
  onAbort: () => void;
  /** Called when the `/` menu opens — the session's MCP prompt commands can load then. */
  onCommandMenu?: () => void;
  /** Shift+Tab: move to the next permission mode. */
  onCycleMode?: () => void;
  /** Lets the session view put focus back here (after a prompt is answered). */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  controls?: ReactNode;
  trailing?: ReactNode;
}) {
  const [text, setText] = useState(() => platform.storage.get(draftKey(sessionId)) ?? '');
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;

  const query = slashQuery(text);
  const matches = useMemo(
    () => (query === null ? [] : filterCommands(commands, query)),
    [commands, query],
  );
  const menuOpen = !dismissed && matches.length > 0;

  // Mounted with `key={sessionId}`, so switching sessions remounts with that
  // session's draft instead of saving this one's text under the new id. A
  // prompt that mounted alongside (a session opened mid-ask) keeps the focus.
  useEffect(() => {
    if (!document.activeElement?.closest('[data-pending-dock]')) ref.current?.focus();
  }, []);

  useEffect(() => {
    if (text) platform.storage.set(draftKey(sessionId), text);
    else platform.storage.remove(draftKey(sessionId));
  }, [sessionId, text]);

  // Grow with content up to a cap.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => setActive(0), [query]);

  const typingCommand = query !== null;
  // Once per opening of the menu, not on every keystroke inside it.
  useEffect(() => {
    if (typingCommand) onCommandMenu?.();
  }, [typingCommand]);

  const canSend = !running && !disabled && text.trim() !== '';

  const submit = async (): Promise<void> => {
    if (!canSend) return;
    const value = text;
    setText('');
    if (!(await onSend(value))) setText(value);
  };

  const complete = (command: SlashCommand): void => {
    setText(`/${command.name} `);
    setDismissed(false);
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
        e.preventDefault();
        const picked = matches[active];
        if (picked) complete(picked);
        return;
      }
      if (e.key === 'Escape') {
        // Don't let Escape reach the window handler and abort the run.
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
        return;
      }
    }
    if (e.key === 'Tab' && e.shiftKey && onCycleMode) {
      e.preventDefault();
      onCycleMode();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void submit();
  };

  return (
    <div className="relative">
      {menuOpen && <SlashMenu commands={matches} active={active} onPick={complete} />}
      <div className="flex flex-col rounded-xl border bg-card shadow-sm transition-shadow focus-within:border-primary/45 focus-within:shadow-md focus-within:ring-2 focus-within:ring-primary/25">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDismissed(false);
          }}
          onKeyDown={onKeyDown}
          placeholder={running ? 'Running… you can type the next message' : 'Message hc — Enter to send, / for commands'}
          className="max-h-60 min-h-11 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground"
          disabled={disabled}
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <div className="flex min-w-0 flex-1 items-center gap-0.5">{controls}</div>
          {trailing}
          {running ? (
            <Button size="icon-sm" variant="secondary" className="rounded-lg" onClick={onAbort} aria-label="Stop" title="Stop (Esc)">
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button size="icon-sm" className="rounded-lg" onClick={() => void submit()} disabled={!canSend} aria-label="Send" title="Send">
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
