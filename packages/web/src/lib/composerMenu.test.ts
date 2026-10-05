import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { filterBlocks, triggerAt } from '@/lib/composerMenu';

let editor: Editor | undefined;
afterEach(() => editor?.destroy());

/** An editor holding `content`, the caret at the end of `text` (or of the document). */
function at(content: string | object, text?: string): Editor {
  editor = new Editor({ extensions: [StarterKit], content });
  let pos = editor.state.doc.content.size - 1;
  if (text) {
    editor.state.doc.descendants((node, p) => {
      if (node.isText && node.text?.includes(text)) pos = p + node.text.indexOf(text) + text.length;
    });
  }
  editor.commands.setTextSelection(pos);
  return editor;
}

describe('triggerAt', () => {
  it('offers commands only for a / that starts an otherwise empty message', () => {
    expect(triggerAt(at('<p>/comp</p>').state)).toMatchObject({ kind: '/', query: 'comp', from: 1, commands: true });
    expect(triggerAt(at('<p>fix it /bul</p>').state)).toMatchObject({ kind: '/', query: 'bul', commands: false });
    expect(triggerAt(at('<p>/bul</p><p>more</p>', '/bul').state)).toMatchObject({ commands: false });
    expect(triggerAt(at('<ul><li><p>/num</p></li></ul>').state)).toMatchObject({ commands: false });
  });

  it("doesn't open in a word, after a space, or in code", () => {
    expect(triggerAt(at('<p>src/lib</p>').state)).toBeNull();
    // (As a document: HTML would drop the trailing space.)
    expect(triggerAt(at({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '/help ' }] }] }).state)).toBeNull();
    expect(triggerAt(at('<pre><code>/x</code></pre>').state)).toBeNull();
  });

  it('opens the file menu for @ at the start of a word', () => {
    expect(triggerAt(at('<p>look at @comp</p>').state)).toMatchObject({ kind: '@', query: 'comp' });
    expect(triggerAt(at('<p>me@example.com</p>').state)).toBeNull();
  });
});

describe('filterBlocks', () => {
  it('matches label words first, then keywords', () => {
    expect(filterBlocks('').length).toBeGreaterThan(5);
    expect(filterBlocks('list').map((b) => b.id)).toEqual(['bullet', 'numbered', 'todo']);
    expect(filterBlocks('ul').map((b) => b.id)).toEqual(['bullet']);
    expect(filterBlocks('h2').map((b) => b.id)).toEqual(['h2']);
    expect(filterBlocks('zzz')).toEqual([]);
  });
});
