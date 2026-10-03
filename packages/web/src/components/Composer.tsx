import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { ArrowUp, ImagePlus, ListEnd, Square } from 'lucide-react';

import type { ImageInput } from '@harness-code/core';
import type { FileMatch } from '@harness-code/protocol';

import { FileMenu } from '@/components/FileMenu';
import { ImageThumbs } from '@/components/ImageThumbs';
import { SlashMenu } from '@/components/SlashMenu';
import { AttachmentChips } from '@/components/Transcript';
import { Button } from '@/components/ui/button';
import { MAX_IMAGES, readImage } from '@/lib/images';
import { insertMention, mentionAt, presentAttachments, removeMention } from '@/lib/mention';
import { filterCommands, slashQuery } from '@/lib/slash';
import type { SlashCommand } from '@/lib/slash';
import { platform } from '@/platform';

const draftKey = (id: string) => `hc.draft.${id}`;
const filesKey = (id: string) => `hc.draftFiles.${id}`;
/** Wait this long after a keystroke before asking for files. */
const SEARCH_DEBOUNCE_MS = 60;

/** Text handed back to the composer, with the files that were attached to it. */
export interface RestoredDraft {
  text: string;
  attachments: string[];
  images?: ImageInput[];
  /** Goes right before the draft (a command), not as a paragraph of its own. */
  inline?: boolean;
}

function loadFiles(sessionId: string): string[] {
  try {
    const raw = platform.storage.get(filesKey(sessionId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Enter sends, Shift+Enter is a newline, and Enter while an IME is composing
 * (Chinese/Japanese input) only confirms the candidate. Typing `/` at the
 * start opens the command menu, and `@` at the start of a word the file menu
 * (↑/↓ to move, Enter or Tab to pick — Enter on a command typed out in full
 * sends it); a picked file is attached while its
 * `@path` stays in the text. Shift+Tab switches the permission mode. While a
 * run is going Stop joins the send button, Enter sends for the agent to read
 * at its next step (`steer`), and ⌥Enter — or the Queue button — waits for the
 * run to end instead; the draft (and its attachments) survives reloads per
 * session. Images are pasted, dropped on it or picked with the image button,
 * shown as thumbnails until sent; they don't survive a reload. The footer holds what the next message runs under (`controls`)
 * and, before the send button, `trailing` (the context meter).
 */
export function Composer({
  sessionId,
  running,
  disabled,
  commands,
  onSend,
  onAbort,
  onCommandMenu,
  onSearchFiles,
  onCycleMode,
  inputRef,
  controls,
  trailing,
  restored,
  onRestored,
  autoFocus = true,
  imagesProblem,
}: {
  sessionId: string;
  running: boolean;
  disabled: boolean;
  commands: SlashCommand[];
  /**
   * `steer`: sent while a run is going, for the agent to read at its next step
   * rather than after the run. `images`: what was pasted, dropped or picked.
   */
  onSend: (text: string, attachments: string[], opts: { steer: boolean; images: ImageInput[] }) => Promise<boolean>;
  onAbort: () => void;
  /** Called when the `/` menu opens — the session's MCP prompt commands can load then. */
  onCommandMenu?: () => void;
  /** Files matching an `@` query; without it, `@` is just text. */
  onSearchFiles?: (query: string) => Promise<FileMatch[]>;
  /** Shift+Tab: move to the next permission mode. */
  onCycleMode?: () => void;
  /** Lets the session view put focus back here (after a prompt is answered). */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  controls?: ReactNode;
  trailing?: ReactNode;
  /** Handed back to edit (queued messages a Stop returned): put in front of the draft, then `onRestored`. */
  restored?: RestoredDraft;
  onRestored?: () => void;
  /** Take the focus when mounted (not in the pane of a split that hasn't got it). */
  autoFocus?: boolean;
  /** Why images can't go with the message (the model can't see them); absent when they can. */
  imagesProblem?: string | undefined;
}) {
  const [text, setText] = useState(() => platform.storage.get(draftKey(sessionId)) ?? '');
  const [attached, setAttached] = useState<string[]>(() => loadFiles(sessionId));
  const [images, setImages] = useState<ImageInput[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(() => text.length);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [files, setFiles] = useState<FileMatch[]>([]);
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;
  /** Where to put the caret after the text changes under it (a picked file). */
  const pendingCaret = useRef<number | null>(null);

  const query = slashQuery(text);
  const commandMatches = useMemo(
    () => (query === null ? [] : filterCommands(commands, query)),
    [commands, query],
  );
  const mention = onSearchFiles ? mentionAt(text, caret) : null;
  const mentionQuery = mention?.query ?? null;
  const commandMenuOpen = !dismissed && commandMatches.length > 0;
  const fileMenuOpen = !dismissed && !commandMenuOpen && mention !== null && files.length > 0;
  const menuLength = commandMenuOpen ? commandMatches.length : fileMenuOpen ? files.length : 0;
  const attachments = useMemo(() => presentAttachments(text, attached), [text, attached]);

  // Mounted with `key={sessionId}`, so switching sessions remounts with that
  // session's draft instead of saving this one's text under the new id. A
  // prompt that mounted alongside (a session opened mid-ask) keeps the focus.
  useEffect(() => {
    if (autoFocus && !document.activeElement?.closest('[data-pending-dock]')) ref.current?.focus();
  }, []);

  useEffect(() => {
    if (text) platform.storage.set(draftKey(sessionId), text);
    else platform.storage.remove(draftKey(sessionId));
  }, [sessionId, text]);

  useEffect(() => {
    if (attachments.length > 0) platform.storage.set(filesKey(sessionId), JSON.stringify(attachments));
    else platform.storage.remove(filesKey(sessionId));
  }, [sessionId, attachments]);

  // Grow with content up to a cap; put the caret where a pick left it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text]);

  useEffect(() => setActive(0), [query, mentionQuery]);

  // Ask for files as the `@` query changes; an answer to an older query is dropped.
  useEffect(() => {
    if (mentionQuery === null || !onSearchFiles) {
      setFiles([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void onSearchFiles(mentionQuery).then((found) => {
        if (current) setFiles(found);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [mentionQuery]);

  useEffect(() => {
    if (restored === undefined) return;
    const joined = (draft: string): string =>
      restored.inline ? `${restored.text}${draft}` : draft.trim() ? `${restored.text}\n\n${draft}` : restored.text;
    setText(joined);
    pendingCaret.current = restored.text.length;
    setAttached((files) => [...new Set([...restored.attachments, ...files])]);
    if (restored.images?.length) setImages((held) => [...restored.images!, ...held].slice(0, MAX_IMAGES));
    onRestored?.();
    ref.current?.focus();
  }, [restored]);

  const typingCommand = query !== null;
  // Once per opening of the menu, not on every keystroke inside it.
  useEffect(() => {
    if (typingCommand) onCommandMenu?.();
  }, [typingCommand]);

  // An image the model can't see blocks sending until it is removed or the model changes.
  const blockedByImages = images.length > 0 && imagesProblem !== undefined;
  const canSend = !disabled && (text.trim() !== '' || images.length > 0) && !blockedByImages;

  useEffect(() => {
    if (!imageError) return;
    const t = setTimeout(() => setImageError(null), 5000);
    return () => clearTimeout(t);
  }, [imageError]);

  /** Read image files into the draft — those that fit, up to `MAX_IMAGES`. */
  const addImages = async (files: readonly File[]): Promise<void> => {
    const wanted = files.filter((f) => f.type.startsWith('image/'));
    if (wanted.length === 0) return;
    if (imagesProblem) {
      setImageError(imagesProblem);
      return;
    }
    const read: ImageInput[] = [];
    for (const file of wanted) {
      try {
        read.push(await readImage(file));
      } catch (err) {
        setImageError(err instanceof Error ? err.message : String(err));
      }
    }
    setImages((held) => {
      const next = [...held, ...read];
      if (next.length > MAX_IMAGES) setImageError(`At most ${MAX_IMAGES} images in a message.`);
      return next.slice(0, MAX_IMAGES);
    });
    ref.current?.focus();
  };

  /** Send what is typed: while a run is going, to steer it unless `queue`d for after. */
  const submit = async (opts: { queue?: boolean } = {}): Promise<void> => {
    if (!canSend) return;
    const value = text;
    const files = attachments;
    const pictures = images;
    setText('');
    setAttached([]);
    setImages([]);
    if (!(await onSend(value, files, { steer: running && !opts.queue, images: pictures }))) {
      setText(value);
      setAttached(files);
      setImages(pictures);
    }
  };

  const complete = (command: SlashCommand): void => {
    setText(`/${command.name} `);
    setDismissed(false);
    ref.current?.focus();
  };

  const pickFile = (path: string): void => {
    if (!mention) return;
    const next = insertMention(text, mention, path);
    pendingCaret.current = next.caret;
    setText(next.text);
    setCaret(next.caret);
    setAttached((files) => (files.includes(path) ? files : [...files, path]));
    setFiles([]);
    ref.current?.focus();
  };

  const detach = (path: string): void => {
    const next = removeMention(text, path);
    setText(next);
    setCaret(Math.min(caret, next.length));
    setAttached((files) => files.filter((f) => f !== path));
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuLength > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : menuLength - 1)) % menuLength);
        return;
      }
      if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
        e.preventDefault();
        if (commandMenuOpen) {
          const picked = commandMatches[active];
          // Enter on a command typed out in full runs it; Tab only completes.
          if (picked && e.key === 'Enter' && picked.name === query) void submit();
          else if (picked) complete(picked);
        } else {
          const picked = files[active];
          if (picked) pickFile(picked.path);
        }
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
    void submit({ queue: e.altKey });
  };

  const followCaret = (el: HTMLTextAreaElement): void => setCaret(el.selectionStart);

  return (
    <div className="relative">
      {commandMenuOpen && <SlashMenu commands={commandMatches} active={active} onPick={complete} />}
      {fileMenuOpen && <FileMenu files={files} active={active} onPick={pickFile} />}
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDrop={(e) => {
          const files = [...e.dataTransfer.files];
          if (files.length === 0) return;
          e.preventDefault();
          void addImages(files);
        }}
        className="flex flex-col rounded-lg border border-border-strong bg-background transition-colors focus-within:border-faint"
      >
        {(attachments.length > 0 || images.length > 0) && (
          <div className="flex flex-col gap-2 px-3 pt-2.5">
            {images.length > 0 && <ImageThumbs images={images} onRemove={(i) => setImages(images.filter((_, j) => j !== i))} />}
            {attachments.length > 0 && <AttachmentChips paths={attachments} onRemove={detach} />}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            followCaret(e.target);
            setDismissed(false);
          }}
          onSelect={(e) => followCaret(e.currentTarget)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
            if (files.length === 0) return;
            // A picture copied with its caption pastes both: the text still lands.
            if (!e.clipboardData.getData('text/plain')) e.preventDefault();
            void addImages(files);
          }}
          placeholder={
            running
              ? 'Running… Enter: read at its next step · ⌥Enter: after this turn'
              : `Ask hc to do something — / for commands${onSearchFiles ? ', @ for files' : ''}`
          }
          className="max-h-60 min-h-11 w-full resize-none bg-transparent px-3 pt-[11px] pb-3 text-sm leading-[1.57] outline-none placeholder:text-faint"
          disabled={disabled}
        />
        {(imageError || blockedByImages) && (
          <p role="alert" className="px-3 pb-1 text-xs text-warning">
            {imageError ?? imagesProblem}
          </p>
        )}
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <div className="flex min-w-0 items-center gap-0.5">{controls}</div>
          <button
            type="button"
            onClick={() => picker.current?.click()}
            disabled={disabled || imagesProblem !== undefined}
            aria-label="Add images"
            title={imagesProblem ?? 'Add images — or paste or drop them here'}
            className="flex h-[26px] shrink-0 items-center justify-center rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ImagePlus className="size-[13px]" />
          </button>
          <div className="flex-1" />
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              void addImages([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          {trailing}
          {running && (
            <Button size="icon-sm" variant="secondary" onClick={onAbort} aria-label="Stop" title="Stop (Esc)">
              <Square className="size-3 fill-current" />
            </Button>
          )}
          {running ? (
            canSend && (
              <>
                <Button
                  size="icon-sm"
                  variant="secondary"
                  onClick={() => void submit({ queue: true })}
                  aria-label="Queue"
                  title="Queue — sent when this turn ends (⌥Enter)"
                >
                  <ListEnd />
                </Button>
                <Button
                  size="icon-sm"
                  onClick={() => void submit()}
                  aria-label="Send now"
                  title="Send now — read at the agent's next step (Enter)"
                >
                  <ArrowUp />
                </Button>
              </>
            )
          ) : (
            <Button
              size="icon-sm"
              className="disabled:opacity-35"
              onClick={() => void submit()}
              disabled={!canSend}
              aria-label="Send"
              title="Send"
            >
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
