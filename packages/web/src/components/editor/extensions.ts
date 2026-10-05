/**
 * What the composer's editor is made of: StarterKit's blocks and marks (the
 * Markdown it can write), task lists, a placeholder, and two nodes of its own —
 * a mentioned file (`@path`) and an image held in the message.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import type { Extensions } from '@tiptap/core';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

import { ImageView } from '@/components/editor/ImageView';
import { IMAGE_NODE, MENTION_NODE } from '@/lib/composerDoc';

/** A file mentioned with `@`: attached while it stays in the text. */
export const FileMention = Node.create({
  name: MENTION_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      path: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-mention') ?? '',
        renderHTML: (attrs) => ({ 'data-mention': attrs.path as string }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-mention]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'composer-mention', title: node.attrs.path as string }),
      `@${node.attrs.path as string}`,
    ];
  },
  renderText({ node }) {
    return `@${node.attrs.path as string}`;
  },
});

/** An image in the message, where it sits; its bytes live in the node (never in storage). */
export const ComposerImage = Node.create({
  name: IMAGE_NODE,
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      mediaType: { default: 'image/png', rendered: false },
      data: { default: '', rendered: false },
    };
  },
  parseHTML() {
    // Only our own (copied within the composer): an <img> pasted from a page isn't bytes we have.
    return [
      {
        tag: 'img[data-composer-image]',
        getAttrs: (el) => {
          const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(el.getAttribute('src') ?? '');
          return m ? { mediaType: m[1], data: m[2] } : false;
        },
      },
    ];
  },
  renderHTML({ node }) {
    return ['img', { 'data-composer-image': '', src: `data:${node.attrs.mediaType as string};base64,${node.attrs.data as string}` }];
  },
  renderText() {
    return '[Image]';
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
  addProseMirrorPlugins() {
    // Each image's number — what the message calls it (`[Image #N]`) — as a
    // decoration, so the view shows it and it follows every edit.
    return [
      new Plugin({
        props: {
          decorations: (state) => {
            const found: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name !== IMAGE_NODE) return;
              found.push(Decoration.node(pos, pos + node.nodeSize, {}, { imageNumber: found.length + 1 }));
            });
            return DecorationSet.create(state.doc, found);
          },
        },
      }),
    ];
  },
});

/** The editor's extensions; `placeholder` is read each time the document is empty. */
export function composerExtensions(placeholder: () => string): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Links come from Markdown typed or pasted; a click shouldn't navigate away from a draft.
      link: { openOnClick: false, autolink: true, linkOnPaste: true },
      // Not underline: Markdown has none to send it as.
      underline: false,
      // The composer's own Shift+Enter (Composer.tsx) runs Enter's commands instead.
      hardBreak: { keepMarks: true },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder, showOnlyWhenEditable: false }),
    // Parsing only (a sent message coming back to edit); writing is `toMessage`'s.
    Markdown,
    FileMention,
    ComposerImage,
  ];
}
