/**
 * Driving the composer's editor in tests. jsdom has no typing into a
 * contenteditable, so text goes in through the editor (Tiptap hangs it on its
 * element as `.editor`), and keys go to that element as ProseMirror hears them.
 */

import { act, fireEvent, screen } from '@testing-library/react';
import type { Editor } from '@tiptap/core';

import { toMessage } from '@/lib/composerDoc';

/** The composer's editable box. */
export function composerBox(): HTMLElement {
  return screen.getByRole('textbox', { name: 'Message' });
}

/** The editor in it. */
export function composerEditor(box: HTMLElement = composerBox()): Editor {
  return (box as HTMLElement & { editor: Editor }).editor;
}

/** Replace what is written with `text` (one paragraph), the caret at its end — as if typed. */
export function typeInComposer(text: string, box: HTMLElement = composerBox()): void {
  const editor = composerEditor(box);
  act(() => {
    editor
      .chain()
      .setContent(text ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } : '')
      .focus('end')
      .run();
  });
}

/** What the composer would send now. */
export function composerText(box: HTMLElement = composerBox()): string {
  return toMessage(composerEditor(box).getJSON()).text;
}

/** A key pressed in the composer. */
export function pressInComposer(init: KeyboardEventInit & { key: string }, box: HTMLElement = composerBox()): void {
  fireEvent.keyDown(box, init);
}
