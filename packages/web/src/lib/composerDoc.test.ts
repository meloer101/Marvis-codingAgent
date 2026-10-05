import { Editor } from '@tiptap/core';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';

import { IMAGE_NODE, MENTION_NODE, isEmptyDoc, placeImages, restoreDoc, toMessage, withoutImages } from '@/lib/composerDoc';

const PNG = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' };
const JPG = { mediaType: 'image/jpeg' as const, data: '/9j/4AAQ' };

const text = (t: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });
const item = (...content: JSONContent[]): JSONContent => ({ type: 'listItem', content });
const image = (img: typeof PNG | typeof JPG): JSONContent => ({ type: IMAGE_NODE, attrs: img });
const mention = (path: string): JSONContent => ({ type: MENTION_NODE, attrs: { path } });

describe('toMessage', () => {
  it('writes Markdown as typed: nothing escaped, blocks a blank line apart', () => {
    const m = toMessage(
      doc(
        p(text('rename snake_case to a*b in [brackets]')),
        p(),
        { type: 'heading', attrs: { level: 2 }, content: [text('Plan')] },
        { type: 'blockquote', content: [p(text('quoted')), p(text('twice'))] },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1;\n\nconst b = 2;')] },
        { type: 'horizontalRule' },
        p(text('one'), { type: 'hardBreak' }, text('two')),
      ),
    );
    expect(m.text).toBe(
      [
        'rename snake_case to a*b in [brackets]',
        '## Plan',
        '> quoted\n>\n> twice',
        '```ts\nconst a = 1;\n\nconst b = 2;\n```',
        '---',
        'one\ntwo',
      ].join('\n\n'),
    );
  });

  it('writes lists tight, nested ones indented under their text', () => {
    const m = toMessage(
      doc(
        { type: 'bulletList', content: [item(p(text('one'))), item(p(text('two')), { type: 'bulletList', content: [item(p(text('deep')))] })] },
        { type: 'orderedList', attrs: { start: 3 }, content: [item(p(text('third'))), item(p(text('fourth')), p(text('more')))] },
        {
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { checked: false }, content: [p(text('todo'))] },
            { type: 'taskItem', attrs: { checked: true }, content: [p(text('done'))] },
          ],
        },
      ),
    );
    expect(m.text).toBe('- one\n- two\n  - deep\n\n3. third\n4. fourth\n   more\n\n- [ ] todo\n- [x] done');
  });

  it('opens and closes marks only where they change', () => {
    const bold = { type: 'bold' };
    const italic = { type: 'italic' };
    const link = { type: 'link', attrs: { href: 'https://x.dev' } };
    const m = toMessage(doc(p(text('a', [bold]), text('b', [bold, italic]), text(' c '), text('code', [{ type: 'code' }]), text('site', [link, bold]))));
    expect(m.text).toBe('**a*b*** c `code`[**site**](https://x.dev)');
  });

  it('numbers images where they sit and collects them in order; mentions become @path', () => {
    const m = toMessage(doc(p(text('before')), image(PNG), p(text('look at '), mention('src/a.ts'), text(' and '), mention('src/a.ts')), image(JPG)));
    expect(m.text).toBe('before\n\n[Image #1]\n\nlook at @src/a.ts and @src/a.ts\n\n[Image #2]');
    expect(m.images).toEqual([PNG, JPG]);
    expect(m.mentions).toEqual(['src/a.ts']);
  });

  it('reads a document with only empty paragraphs as empty', () => {
    expect(isEmptyDoc(doc(p(), p()))).toBe(true);
    expect(isEmptyDoc(doc(image(PNG)))).toBe(false);
  });
});

describe('restoreDoc', () => {
  const editor = new Editor({ extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true }), Markdown] });
  const parse = (md: string): JSONContent => editor.markdown!.parse(md);

  it('round-trips a message: images back where they were, mentions as mentions', () => {
    const original = doc(
      p(text('see '), mention('src/a.ts')),
      image(PNG),
      { type: 'bulletList', content: [item(p(text('one'))), item(p(text('two')))] },
      image(JPG),
    );
    const sent = toMessage(original);
    const restored = restoreDoc(parse(sent.text), sent.images, sent.mentions);
    expect(toMessage(restored)).toEqual(sent);
    expect(restored.content?.[1]).toEqual(image(PNG));
    expect(restored.content?.[0]?.content).toContainEqual(mention('src/a.ts'));
  });

  it('puts images the text never placed first, and line breaks back as breaks', () => {
    const restored = restoreDoc(parse('first line\nsecond line'), [PNG], []);
    expect(restored.content?.[0]).toEqual(image(PNG));
    expect(restored.content?.[1]).toEqual(p(text('first line'), { type: 'hardBreak' }, text('second line')));
  });

  it("doesn't turn an @word that isn't attached, or one in code, into a mention", () => {
    const restored = restoreDoc(parse('ping @someone and `@src/a.ts`'), [], ['src/a.ts']);
    expect(JSON.stringify(restored)).not.toContain(MENTION_NODE);
  });
});

describe('withoutImages', () => {
  it('drops the images, and a quote left empty by it', () => {
    const kept = withoutImages(doc(p(text('a')), image(PNG), { type: 'blockquote', content: [image(JPG)] }));
    expect(kept).toEqual(doc(p(text('a'))));
  });
});

describe('placeImages', () => {
  it('turns markers alone on their line into images, not those in code or past the count', () => {
    const { text, placed } = placeImages('see\n\n[Image #1]\n\n- item\n  [Image #2]\n\n```\n[Image #1]\n```\n\n[Image #9] and [Image #1] inline', 2);
    expect(text).toBe('see\n\n![Image #1](#image-1)\n\n- item\n  ![Image #2](#image-2)\n\n```\n[Image #1]\n```\n\n[Image #9] and [Image #1] inline');
    expect([...placed]).toEqual([0, 1]);
  });
});
