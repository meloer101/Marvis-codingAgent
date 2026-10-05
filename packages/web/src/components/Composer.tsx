import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor, JSONContent } from '@tiptap/react';
import { Fragment, Slice } from '@tiptap/pm/model';
import { ArrowUp, FileText, ListEnd, LoaderCircle, Paperclip, Square, X } from 'lucide-react';

import type { ImageInput } from '@harness-code/core';
import type { FileMatch, UploadedFile } from '@harness-code/protocol';

import { FormatBar } from '@/components/editor/FormatBar';
import { composerExtensions } from '@/components/editor/extensions';
import { FileMenu } from '@/components/FileMenu';
import { SlashMenu } from '@/components/SlashMenu';
import type { SlashItem } from '@/components/SlashMenu';
import { Button } from '@/components/ui/button';
import { MENTION_NODE, imageNode, isEmptyDoc, plainTextDoc, restoreDoc, toMessage, withoutImages } from '@/lib/composerDoc';
import { filterBlocks, triggerAt } from '@/lib/composerMenu';
import type { BlockId } from '@/lib/composerMenu';
import { MAX_IMAGES, isImageFile, readBase64, readImage } from '@/lib/images';
import { filterCommands } from '@/lib/slash';
import type { SlashCommand } from '@/lib/slash';
import { platform } from '@/platform';

const draftKey = (id: string) => `hc.draft.${id}`;
/** Where drafts from before the editor kept their `@` files. */
const legacyFilesKey = (id: string) => `hc.draftFiles.${id}`;
/** Wait this long after a keystroke before asking for files. */
const SEARCH_DEBOUNCE_MS = 60;
/** What the server takes in one message (`session.send {attachments}`). */
const MAX_ATTACHMENTS = 20;
/** What one upload may weigh (`files.upload`). */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Text handed back to the composer, with the files that were attached to it. */
export interface RestoredDraft {
  text: string;
  attachments: string[];
  images?: ImageInput[];
  /** Goes right before the draft (a command), not as a paragraph of its own. */
  inline?: boolean;
}

/** What the session view holds to put the focus back here. */
export interface ComposerHandle {
  focus: () => void;
}

/** A file being uploaded (no `path` yet) or uploaded, to go with the message. */
interface Upload {
  id: string;
  name: string;
  size: number;
  path?: string;
}

interface StoredDraft {
  v: 2;
  doc: JSONContent;
  uploads: { path: string; name: string; size: number }[];
}

/** A stored draft: this editor's, or text and files from before it (to parse once the editor is up). */
function loadDraft(sessionId: string): StoredDraft | { legacy: string; files: string[] } | null {
  const raw = platform.storage.get(draftKey(sessionId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    if (parsed && parsed.v === 2 && parsed.doc) return { v: 2, doc: parsed.doc, uploads: parsed.uploads ?? [] };
  } catch {
    // Plain text: a draft from the textarea.
  }
  let files: string[] = [];
  try {
    const old = JSON.parse(platform.storage.get(legacyFilesKey(sessionId)) ?? '[]') as unknown;
    if (Array.isArray(old)) files = old.filter((p): p is string => typeof p === 'string');
  } catch {
    files = [];
  }
  return { legacy: raw, files };
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

/** The item the caret is in, when its list sits inside another list's item (Shift+Tab takes it out a level). */
function nestedItemType(editor: Editor): string | null {
  const { $from } = editor.state.selection;
  let lists = 0;
  let item: string | null = null;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (LIST_TYPES.has(name)) lists++;
    if (!item && (name === 'listItem' || name === 'taskItem')) item = name;
  }
  return lists >= 2 ? item : null;
}

/**
 * The message editor: Markdown as you write it — `- `, `1. `, `[] `, `> `,
 * ``` ``` ```, `#` turn into lists, quotes, code and headings as you type, a
 * selection gets a format bar, and `/` (at a line's start or after a space)
 * offers blocks to insert; at the start of an empty message it offers the
 * commands first. `@` at the start of a word opens the file menu (↑/↓ to move,
 * Enter or Tab to pick; Enter on a command typed out in full sends it): a
 * picked file is attached while its mention stays in the text.
 *
 * Enter sends and Shift+Enter is what Enter is in a document (a new line, list
 * item or paragraph; on an empty item, out of the list); Enter while an IME is
 * composing only confirms the candidate. Shift+Tab switches the permission
 * mode (or, in a nested list, takes the item out a level). While a run is
 * going Stop joins the send button, Enter sends for the agent to read at its
 * next step (`steer`), and ⌥Enter — or the Queue button — waits for the run to
 * end instead. Images are pasted, dropped or picked into the text, where they
 * sit; other files are uploaded and go with the message as chips. The draft
 * (and its files) survives reloads per session; its images don't. The footer
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
  onSearchFiles,
  onUpload,
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
   * rather than after the run. `images`: those in the text, in order (the text
   * says where each sits, `[Image #N]`).
   */
  onSend: (text: string, attachments: string[], opts: { steer: boolean; images: ImageInput[] }) => Promise<boolean>;
  onAbort: () => void;
  /** Called when the `/` menu opens with commands — the session's MCP prompt commands can load then. */
  onCommandMenu?: () => void;
  /** Files matching an `@` query; without it, `@` is just text. */
  onSearchFiles?: (query: string) => Promise<FileMatch[]>;
  /** Save a file (base64) for the message to attach; throws to say why not. Without it, only images go in. */
  onUpload?: (name: string, data: string) => Promise<UploadedFile>;
  /** Shift+Tab: move to the next permission mode. */
  onCycleMode?: () => void;
  /** Lets the session view put focus back here (after a prompt is answered). */
  inputRef?: RefObject<ComposerHandle | null>;
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
  const [draft] = useState(() => loadDraft(sessionId));
  const [uploads, setUploads] = useState<Upload[]>(() =>
    draft && 'v' in draft ? draft.uploads.map((u) => ({ id: u.path, ...u })) : [],
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [files, setFiles] = useState<FileMatch[]>([]);
  const container = useRef<HTMLDivElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const imagePicker = useRef<HTMLInputElement>(null);
  const placeholder = running
    ? 'Running… Enter: read at its next step · ⌥Enter: after this turn'
    : `Ask Marvis to do something — / for commands and blocks${onSearchFiles ? ', @ for files' : ''}`;
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;
  /** The latest key handler: the editor is made once, the handler each render. */
  const onKeyRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
  /** The latest file handler, for paste and drop. */
  const addFilesRef = useRef<(files: File[], at?: number) => void>(() => {});

  const editor = useEditor(
    {
      extensions: composerExtensions(() => placeholderRef.current),
      // A draft from before the editor was the textarea's plain text, with its `@` files.
      content: draft === null ? '' : 'v' in draft ? draft.doc : restoreDoc(plainTextDoc(draft.legacy), [], draft.files),
      editable: !disabled,
      immediatelyRender: true,
      shouldRerenderOnTransaction: true,
      editorProps: {
        attributes: {
          class: 'md composer-doc',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Message',
        },
        handleKeyDown: (_view, event) => onKeyRef.current(event),
        handlePaste: (_view, event) => {
          const pasted = [...(event.clipboardData?.files ?? [])];
          if (pasted.length === 0) return false;
          addFilesRef.current(pasted);
          // A picture copied with its caption pastes both: the text still lands.
          return !event.clipboardData?.getData('text/plain');
        },
        handleDrop: (view, event, _slice, moved) => {
          const dropped = [...(event.dataTransfer?.files ?? [])];
          if (moved || dropped.length === 0) return false;
          addFilesRef.current(dropped, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
          return true;
        },
        // Pasted text stays as it was: its lines kept (not merged into one
        // paragraph, not each spaced as one), nothing read as Markdown.
        clipboardTextParser: (text, $context, _plain, view) => {
          const { schema } = view.state;
          const normalized = text.replace(/\r\n?/g, '\n');
          if ($context.parent.type.spec.code) return new Slice(Fragment.from(schema.text(normalized)), 0, 0);
          const paragraphs = normalized.split(/\n{2,}/).map((chunk) =>
            schema.nodes.paragraph!.create(
              null,
              chunk.split('\n').flatMap((line, i) => [
                ...(i > 0 ? [schema.nodes.hardBreak!.create()] : []),
                ...(line ? [schema.text(line)] : []),
              ]),
            ),
          );
          return new Slice(Fragment.from(paragraphs), 1, 1);
        },
      },
    },
    [],
  );

  // The state's doc is a new object only when the document changed.
  const pmDoc = editor.state.doc;
  const doc = useMemo(() => editor.getJSON(), [pmDoc]);
  const message = useMemo(() => toMessage(doc), [doc]);
  const trigger = editor.isEditable ? triggerAt(editor.state) : null;
  const slashItems: SlashItem[] =
    trigger?.kind === '/' && !dismissed
      ? [
          ...(trigger.commands ? filterCommands(commands, trigger.query).map((command) => ({ kind: 'command' as const, command })) : []),
          ...filterBlocks(trigger.query).map((block) => ({ kind: 'block' as const, block })),
        ]
      : [];
  const mentionQuery = trigger?.kind === '@' && onSearchFiles ? trigger.query : null;
  const slashOpen = slashItems.length > 0;
  const fileMenuOpen = !dismissed && mentionQuery !== null && files.length > 0;
  const menuLength = slashOpen ? slashItems.length : fileMenuOpen ? files.length : 0;
  const imageCount = message.images.length;
  const uploading = uploads.some((u) => u.path === undefined);
  const uploaded = uploads.flatMap((u) => (u.path ? [u.path] : []));

  // Mounted with `key={sessionId}`, so switching sessions remounts with that
  // session's draft instead of saving this one's under the new id. A prompt
  // that mounted alongside (a session opened mid-ask) keeps the focus.
  useEffect(() => {
    if (autoFocus && !document.activeElement?.closest('[data-pending-dock]')) editor.commands.focus('end');
  }, []);

  useEffect(() => {
    if (!inputRef) return;
    inputRef.current = { focus: () => editor.commands.focus() };
    return () => {
      inputRef.current = null;
    };
  }, [editor]);

  useEffect(() => {
    editor.setEditable(!disabled, false);
  }, [disabled]);

  // The draft now lives in one key (written below); the old files key goes.
  useEffect(() => {
    if (draft && 'legacy' in draft) platform.storage.remove(legacyFilesKey(sessionId));
  }, []);

  // The placeholder is drawn from the state: a no-op transaction redraws it.
  useEffect(() => {
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr);
  }, [placeholder]);

  // The draft, without its images (no image bytes in storage), and its uploads.
  useEffect(() => {
    const kept = uploads.flatMap((u) => (u.path ? [{ path: u.path, name: u.name, size: u.size }] : []));
    const text = withoutImages(doc);
    if (isEmptyDoc(text) && kept.length === 0) platform.storage.remove(draftKey(sessionId));
    else platform.storage.set(draftKey(sessionId), JSON.stringify({ v: 2, doc: text, uploads: kept } satisfies StoredDraft));
  }, [sessionId, doc, uploads]);

  useEffect(() => setActive(0), [trigger?.kind, trigger?.query]);
  // A new `/` or `@` opens its menu again.
  useEffect(() => setDismissed(false), [trigger?.from, trigger?.kind]);

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
    const restoredUploads = restored.attachments.filter((p) => !restored.text.includes(`@${p}`));
    if (restored.inline) {
      // A command goes right before the draft's first line.
      const text = { type: 'text', text: restored.text };
      const first = editor.state.doc.firstChild;
      if (first?.type.name === 'paragraph') editor.chain().insertContentAt(1, text).focus(1 + restored.text.length).run();
      else editor.chain().insertContentAt(0, { type: 'paragraph', content: [text] }).focus(1 + restored.text.length).run();
    } else {
      const back = restoreDoc(editor.markdown!.parse(restored.text), restored.images ?? [], restored.attachments);
      const kept = isEmptyDoc(editor.getJSON()) ? [] : (editor.getJSON().content ?? []);
      editor.commands.setContent({ type: 'doc', content: [...(back.content ?? []), ...kept] }, { emitUpdate: true });
      // The caret at the end of what came back.
      let end = 0;
      for (let i = 0; i < (back.content?.length ?? 0); i++) end += editor.state.doc.child(i).nodeSize;
      editor.commands.focus(Math.max(1, end - 1));
    }
    if (restoredUploads.length > 0) {
      setUploads((held) => [
        ...restoredUploads
          .filter((p) => !held.some((u) => u.path === p))
          .map((p) => ({ id: p, path: p, name: p.split(/[\\/]/).pop() ?? p, size: 0 })),
        ...held,
      ]);
    }
    onRestored?.();
  }, [restored]);

  const typingCommand = trigger?.kind === '/' && trigger.commands;
  // Once per opening of the menu, not on every keystroke inside it.
  useEffect(() => {
    if (typingCommand) onCommandMenu?.();
  }, [typingCommand]);

  // An image the model can't see blocks sending until it is removed or the model changes.
  const blockedByImages = imageCount > 0 && imagesProblem !== undefined;
  const canSend =
    !disabled && (message.text !== '' || imageCount > 0 || uploaded.length > 0) && !uploading && !blockedByImages;

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  /** Save a file for the message; its chip shows while it goes up. */
  const upload = async (file: File): Promise<void> => {
    if (!onUpload) {
      setNotice(`${file.name}: only images can go with a message here.`);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setNotice(`${file.name} is ${sizeLabel(file.size)}; ${MAX_UPLOAD_BYTES / 1024 / 1024} MB at most.`);
      return;
    }
    const id = crypto.randomUUID();
    setUploads((held) => [...held, { id, name: file.name, size: file.size }]);
    try {
      const saved = await onUpload(file.name, await readBase64(file));
      setUploads((held) => held.map((u) => (u.id === id ? { ...u, path: saved.path, name: saved.name, size: saved.size } : u)));
    } catch (err) {
      setUploads((held) => held.filter((u) => u.id !== id));
      setNotice(`Couldn't attach ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Images into the text (at `at`, else the caret); other files uploaded. */
  const addFiles = async (added: readonly File[], at?: number): Promise<void> => {
    const pictures = added.filter(isImageFile);
    const others = added.filter((f) => !isImageFile(f));
    if (message.mentions.length + uploads.length + others.length > MAX_ATTACHMENTS) {
      setNotice(`At most ${MAX_ATTACHMENTS} files in a message.`);
      return;
    }
    for (const f of others) void upload(f);
    if (pictures.length === 0) return;
    if (imagesProblem) {
      setNotice(imagesProblem);
      return;
    }
    const read: ImageInput[] = [];
    for (const file of pictures) {
      try {
        read.push(await readImage(file));
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      }
    }
    const room = MAX_IMAGES - toMessage(editor.getJSON()).images.length;
    if (read.length > room) setNotice(`At most ${MAX_IMAGES} images in a message.`);
    const nodes = read.slice(0, Math.max(0, room)).map(imageNode);
    if (nodes.length === 0) return;
    const chain = editor.chain().focus();
    (at !== undefined ? chain.insertContentAt(at, nodes) : chain.insertContent(nodes)).run();
  };
  addFilesRef.current = (added, at) => void addFiles(added, at);

  /** Send what is written: while a run is going, to steer it unless `queue`d for after. */
  const submit = async (opts: { queue?: boolean } = {}): Promise<void> => {
    if (!canSend) return;
    const kept = editor.getJSON();
    const keptUploads = uploads;
    const out = toMessage(kept);
    editor.commands.clearContent(true);
    setUploads([]);
    if (!(await onSend(out.text, [...out.mentions, ...uploaded], { steer: running && !opts.queue, images: out.images }))) {
      editor.commands.setContent(kept, { emitUpdate: true });
      setUploads(keptUploads);
    }
  };

  const runBlock = (id: BlockId, range: { from: number; to: number }): void => {
    const chain = editor.chain().focus().deleteRange(range);
    switch (id) {
      case 'text':
        chain.setParagraph().run();
        return;
      case 'h1':
      case 'h2':
      case 'h3':
        chain.setHeading({ level: Number(id[1]) as 1 | 2 | 3 }).run();
        return;
      case 'bullet':
        chain.toggleBulletList().run();
        return;
      case 'numbered':
        chain.toggleOrderedList().run();
        return;
      case 'todo':
        chain.toggleTaskList().run();
        return;
      case 'quote':
        chain.toggleBlockquote().run();
        return;
      case 'code':
        chain.setCodeBlock().run();
        return;
      case 'divider':
        chain.setHorizontalRule().run();
        return;
      case 'image':
        chain.run();
        if (imagesProblem) setNotice(imagesProblem);
        else imagePicker.current?.click();
        return;
    }
  };

  const pickSlash = (item: SlashItem): void => {
    if (!trigger) return;
    if (item.kind === 'command') {
      editor
        .chain()
        .setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `/${item.command.name} ` }] }] })
        .focus('end')
        .run();
    } else {
      runBlock(item.block.id, trigger);
    }
  };

  const pickFile = (path: string): void => {
    if (!trigger || trigger.kind !== '@') return;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: trigger.from, to: trigger.to }, [
        { type: MENTION_NODE, attrs: { path } },
        { type: 'text', text: ' ' },
      ])
      .run();
    setFiles([]);
  };

  onKeyRef.current = (event: KeyboardEvent): boolean => {
    const composing = event.isComposing || event.keyCode === 229;
    if (menuLength > 0 && !composing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        setActive((i) => (i + (event.key === 'ArrowDown' ? 1 : menuLength - 1)) % menuLength);
        return true;
      }
      if ((event.key === 'Tab' && !event.shiftKey) || (event.key === 'Enter' && !event.shiftKey)) {
        if (slashOpen) {
          const picked = slashItems[active];
          // Enter on a command typed out in full runs it; Tab only completes.
          if (picked?.kind === 'command' && event.key === 'Enter' && picked.command.name === trigger?.query) void submit();
          else if (picked) pickSlash(picked);
        } else {
          const picked = files[active];
          if (picked) pickFile(picked.path);
        }
        return true;
      }
      if (event.key === 'Escape') {
        // Don't let Escape reach the window handler and abort the run.
        event.stopPropagation();
        setDismissed(true);
        return true;
      }
    }
    if (event.key === 'Tab' && event.shiftKey && !composing) {
      const item = nestedItemType(editor);
      if (item) return editor.commands.liftListItem(item);
      if (!onCycleMode) return false;
      onCycleMode();
      return true;
    }
    if (event.key !== 'Enter' || composing) return false;
    if (event.shiftKey) {
      // What Enter does in a document: a new line in code, a new item (or out
      // of the list from an empty one), a new paragraph.
      editor.commands.first(({ commands: c }) => [
        () => c.newlineInCode(),
        () => c.splitListItem('taskItem'),
        () => c.splitListItem('listItem'),
        () => c.createParagraphNear(),
        () => c.liftEmptyBlock(),
        () => c.splitBlock(),
      ]);
      return true;
    }
    void submit({ queue: event.altKey });
    return true;
  };

  const removeUpload = (id: string): void => {
    setUploads((held) => held.filter((u) => u.id !== id));
    editor.commands.focus();
  };

  return (
    <div ref={container} className="relative">
      {slashOpen && <SlashMenu items={slashItems} active={active} onPick={pickSlash} />}
      {fileMenuOpen && <FileMenu files={files} active={active} onPick={pickFile} />}
      <FormatBar editor={editor} container={container} />
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDrop={(e) => {
          // The editor takes what lands on the text; this is the rest of the box.
          if (e.defaultPrevented) return;
          const dropped = [...e.dataTransfer.files];
          if (dropped.length === 0) return;
          e.preventDefault();
          void addFiles(dropped);
        }}
        className="flex flex-col rounded-lg border border-border-strong bg-background transition-colors focus-within:border-faint"
      >
        {uploads.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 px-3 pt-2.5" aria-label="Attached files">
            {uploads.map((u) => (
              <li
                key={u.id}
                title={u.path ?? u.name}
                className="flex max-w-72 items-center gap-1 rounded-md bg-muted py-0.5 pr-1 pl-1.5 text-[11px] text-muted-foreground"
              >
                {u.path ? (
                  <FileText className="size-3 shrink-0" />
                ) : (
                  <LoaderCircle className="size-3 shrink-0 animate-spin" aria-label="Uploading" />
                )}
                <span className="truncate font-mono">{u.name}</span>
                {u.size > 0 && <span className="shrink-0 text-faint">{sizeLabel(u.size)}</span>}
                <button
                  type="button"
                  onClick={() => removeUpload(u.id)}
                  aria-label={`Detach ${u.name}`}
                  className="rounded p-0.5 transition-colors hover:bg-background hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <EditorContent editor={editor} className="max-h-[45vh] min-h-11 overflow-y-auto" />
        {(notice || blockedByImages) && (
          <p role="alert" className="px-3 pb-1 text-xs text-warning">
            {notice ?? imagesProblem}
          </p>
        )}
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <div className="flex min-w-0 items-center gap-0.5">{controls}</div>
          <button
            type="button"
            onClick={() => (onUpload ? filePicker : imagePicker).current?.click()}
            disabled={disabled || (!onUpload && imagesProblem !== undefined)}
            aria-label="Attach files"
            title={onUpload ? 'Attach files or images — or paste or drop them here' : (imagesProblem ?? 'Add images — or paste or drop them here')}
            className="flex h-[26px] shrink-0 items-center justify-center rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Paperclip className="size-[13px]" />
          </button>
          <div className="flex-1" />
          <input
            ref={filePicker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <input
            ref={imagePicker}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])]);
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
              title={uploading ? 'Waiting for the files to upload' : 'Send'}
            >
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
