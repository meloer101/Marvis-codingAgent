import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import type { PermissionMode } from '@harness-code/core';

import { Composer } from '@/components/Composer';
import { ModelLabel, ModePicker } from '@/components/SessionHeader';
import { UserMessage } from '@/components/Transcript';
import { routeToHash } from '@/lib/route';
import { allCommands } from '@/lib/slash';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';

const BUILTIN_COMMANDS = allCommands([]);

/**
 * A session that doesn't exist yet: the home screen. Nothing is created until
 * the first message is sent (`session.start`), so opening "New session" and
 * walking away leaves nothing behind. While the session starts (MCP servers
 * connecting can take a moment) the message already shows, then the view
 * becomes the session's own.
 */
export function DraftView() {
  const sync = useSync();
  const info = useAppStore((s) => s.info);
  const connected = useAppStore((s) => s.status === 'open');
  const [mode, setMode] = useState<PermissionMode | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const chosenMode = mode ?? info?.defaultMode ?? 'ask';

  const send = async (text: string): Promise<boolean> => {
    const command = /^\/(\S+)\s*$/.exec(text.trim())?.[1];
    if (command === 'help') {
      sync.setHelpOpen(true);
      return true;
    }
    if (command === 'clear') return true; // already a clean slate
    setStarting(text);
    const id = await sync.startSession(text, { mode: chosenMode });
    if (!id) {
      setStarting(null);
      return false;
    }
    // Replace, so Back doesn't land on a draft that has become this session.
    window.history.replaceState(null, '', routeToHash({ kind: 'session', id }));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return true;
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4 text-sm">
        {info?.defaultModel && <ModelLabel modelRef={info.defaultModel} />}
        <ModePicker mode={chosenMode} onChange={setMode} />
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-muted-foreground">new session</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {starting === null ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="font-serif text-[34px] font-semibold tracking-[-0.02em]">
              hc<span className="text-brass">·</span>web
            </span>
            <p className="max-w-60 font-serif text-[15px] leading-relaxed text-muted-foreground italic">
              A coding agent, bound for the browser. What are we working on?
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
            <UserMessage text={starting} />
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin text-primary" />
              <span className="font-serif italic">Starting the session…</span>
            </div>
          </div>
        )}
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 pt-2 pb-5">
        <Composer
          key="draft"
          sessionId="new"
          running={false}
          disabled={!connected || starting !== null}
          commands={BUILTIN_COMMANDS}
          onSend={send}
          onAbort={() => {}}
        />
      </div>
    </div>
  );
}
