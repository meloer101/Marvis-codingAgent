import { useEditorState } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import type { RefObject } from 'react';
import { Bold, Code, Italic, List, ListOrdered, ListTodo, Quote, SquareCode, Strikethrough } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

interface Tool {
  label: string;
  keys?: string;
  icon: LucideIcon;
  active: (e: Editor) => boolean;
  run: (e: Editor) => void;
}

const MARKS: Tool[] = [
  { label: 'Bold', keys: '⌘B', icon: Bold, active: (e) => e.isActive('bold'), run: (e) => e.chain().focus().toggleBold().run() },
  { label: 'Italic', keys: '⌘I', icon: Italic, active: (e) => e.isActive('italic'), run: (e) => e.chain().focus().toggleItalic().run() },
  {
    label: 'Strikethrough',
    keys: '⌘⇧S',
    icon: Strikethrough,
    active: (e) => e.isActive('strike'),
    run: (e) => e.chain().focus().toggleStrike().run(),
  },
  { label: 'Code', keys: '⌘E', icon: Code, active: (e) => e.isActive('code'), run: (e) => e.chain().focus().toggleCode().run() },
];

const BLOCKS: Tool[] = [
  {
    label: 'Bulleted list',
    icon: List,
    active: (e) => e.isActive('bulletList'),
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    label: 'Numbered list',
    icon: ListOrdered,
    active: (e) => e.isActive('orderedList'),
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  { label: 'To-do list', icon: ListTodo, active: (e) => e.isActive('taskList'), run: (e) => e.chain().focus().toggleTaskList().run() },
  { label: 'Quote', icon: Quote, active: (e) => e.isActive('blockquote'), run: (e) => e.chain().focus().toggleBlockquote().run() },
  {
    label: 'Code block',
    icon: SquareCode,
    active: (e) => e.isActive('codeBlock'),
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
];

/**
 * Formatting for the selected text, floating just above it: the marks
 * Markdown has, then what the selected lines are (a list, a quote, code).
 */
export function FormatBar({ editor, container }: { editor: Editor; container: RefObject<HTMLElement | null> }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const { selection } = e.state;
      const shown = e.isEditable && e.isFocused && !selection.empty && !('node' in selection) && !e.isActive('codeBlock');
      if (!shown || !container.current) return null;
      const box = container.current.getBoundingClientRect();
      const start = e.view.coordsAtPos(selection.from);
      const end = e.view.coordsAtPos(selection.to);
      const left = Math.min(Math.max((start.left + end.left) / 2 - box.left, 120), Math.max(120, box.width - 120));
      return {
        left,
        top: start.top - box.top,
        active: [...MARKS, ...BLOCKS].map((t) => t.active(e)),
      };
    },
  });
  if (!state) return null;
  const button = (tool: Tool, i: number) => (
    <button
      key={tool.label}
      type="button"
      // Keep the selection: a mousedown would move focus off the editor.
      onMouseDown={(ev) => {
        ev.preventDefault();
        tool.run(editor);
      }}
      aria-label={tool.label}
      aria-pressed={state.active[i]}
      title={tool.keys ? `${tool.label} (${tool.keys})` : tool.label}
      className={cn(
        'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        state.active[i] && 'bg-muted text-foreground',
      )}
    >
      <tool.icon className="size-3.5" />
    </button>
  );
  return (
    <div
      role="toolbar"
      aria-label="Format"
      style={{ left: state.left, top: state.top }}
      className="absolute z-20 flex -translate-x-1/2 -translate-y-[calc(100%+6px)] items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-lg"
    >
      {MARKS.map((t, i) => button(t, i))}
      <span className="mx-0.5 h-4 w-px bg-border" />
      {BLOCKS.map((t, i) => button(t, MARKS.length + i))}
    </div>
  );
}
