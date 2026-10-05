/**
 * The composer's document and the message it sends. The document is the
 * editor's (ProseMirror JSON); the message is Markdown as it was typed —
 * nothing escaped, so `snake_case` and `a*b` go as written — with each image
 * where it sits as `[Image #N]` (numbered in order; the images themselves go
 * alongside, in the same order) and each mentioned file as `@path`.
 *
 * Going back (editing a sent message, a draft from before the editor), the
 * Markdown is parsed by the editor and `restoreDoc` puts the images and
 * mentions back as what they were.
 */

import type { JSONContent } from '@tiptap/core';

import type { ImageInput } from '@harness-code/core';

export const IMAGE_NODE = 'composerImage';
export const MENTION_NODE = 'fileMention';

/** `[Image #3]` alone on its line: where image 3 sits. */
export const IMAGE_MARKER = /^\\?\[Image #(\d+)\\?\]$/;
export const imageMarker = (n: number): string => `[Image #${n}]`;

export interface ComposedMessage {
  text: string;
  images: ImageInput[];
  /** The files mentioned (`@path`), each once, in order. */
  mentions: string[];
}

interface Ctx {
  images: ImageInput[];
  mentions: string[];
}

/** The message a document sends. */
export function toMessage(doc: JSONContent): ComposedMessage {
  const ctx: Ctx = { images: [], mentions: [] };
  const text = blocks(doc.content ?? [], ctx, '\n\n').trim();
  return { text, images: ctx.images, mentions: ctx.mentions };
}

function blocks(nodes: readonly JSONContent[], ctx: Ctx, sep: string): string {
  return nodes
    .map((n) => block(n, ctx))
    .filter((s) => s !== '')
    .join(sep);
}

/** Prefix every line but the first with `rest`, the first with `first`. */
function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? first : line === '' ? rest.trimEnd() : rest) + line)
    .join('\n');
}

function block(node: JSONContent, ctx: Ctx): string {
  const children = node.content ?? [];
  switch (node.type) {
    case 'paragraph':
      return inline(children, ctx);
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      const text = inline(children, ctx);
      return text ? `${'#'.repeat(level)} ${text}` : '';
    }
    case 'blockquote': {
      const body = blocks(children, ctx, '\n\n');
      return body ? prefixLines(body, '> ', '> ') : '';
    }
    case 'codeBlock': {
      const lang = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
      const code = children.map((c) => c.text ?? '').join('');
      const fence = code.includes('```') ? '````' : '```';
      return `${fence}${lang}\n${code}\n${fence}`;
    }
    case 'horizontalRule':
      return '---';
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const start = Number(node.attrs?.start ?? 1);
      return children
        .map((item, i) => {
          const marker =
            node.type === 'orderedList'
              ? `${start + i}. `
              : node.type === 'taskList'
                ? `- [${item.attrs?.checked ? 'x' : ' '}] `
                : '- ';
          // Continuation lines line up under the item's text.
          const body = blocks(item.content ?? [], ctx, '\n') || '';
          return prefixLines(body, marker, ' '.repeat(node.type === 'taskList' ? 2 : marker.length));
        })
        .join('\n');
    }
    case IMAGE_NODE: {
      const { mediaType, data } = node.attrs ?? {};
      if (typeof data !== 'string' || typeof mediaType !== 'string') return '';
      ctx.images.push({ mediaType: mediaType as ImageInput['mediaType'], data });
      return imageMarker(ctx.images.length);
    }
    default:
      // Anything else that holds inline content reads as its text.
      return children.length > 0 && children.every((c) => c.type === 'text' || c.type === 'hardBreak')
        ? inline(children, ctx)
        : blocks(children, ctx, '\n\n');
  }
}

type Mark = NonNullable<JSONContent['marks']>[number];

/** Outermost first: a link can hold bold text, nothing holds code. */
const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'code'];
const DELIMS: Record<string, string> = { bold: '**', italic: '*', strike: '~~', code: '`' };

function sameMark(a: Mark, b: Mark): boolean {
  return a.type === b.type && (a.type !== 'link' || a.attrs?.href === b.attrs?.href);
}

function openMark(m: Mark): string {
  return m.type === 'link' ? '[' : (DELIMS[m.type] ?? '');
}

function closeMark(m: Mark): string {
  return m.type === 'link' ? `](${String(m.attrs?.href ?? '')})` : (DELIMS[m.type] ?? '');
}

/** Inline content: marks opened and closed only where they change, mentions as `@path`. */
function inline(nodes: readonly JSONContent[], ctx: Ctx): string {
  let out = '';
  let open: Mark[] = [];
  const closeFrom = (keep: number): void => {
    for (let i = open.length - 1; i >= keep; i--) out += closeMark(open[i]!);
    open = open.slice(0, keep);
  };
  for (const node of nodes) {
    const marks = (node.marks ?? [])
      .filter((m) => MARK_ORDER.includes(m.type))
      .sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
    let keep = 0;
    while (keep < open.length && keep < marks.length && sameMark(open[keep]!, marks[keep]!)) keep++;
    closeFrom(keep);
    if (node.type === 'text') {
      for (const m of marks.slice(keep)) out += openMark(m);
      open = marks;
      out += node.text ?? '';
    } else if (node.type === 'hardBreak') {
      out += '\n';
    } else if (node.type === MENTION_NODE) {
      const path = String(node.attrs?.path ?? '');
      if (path) {
        out += `@${path}`;
        if (!ctx.mentions.includes(path)) ctx.mentions.push(path);
      }
    }
  }
  closeFrom(0);
  return out;
}

/** The document a message makes, from its parsed Markdown: images and mentions put back. */
export function restoreDoc(parsed: JSONContent, images: readonly ImageInput[], attachments: readonly string[]): JSONContent {
  const used = new Set<number>();
  const content = (parsed.content ?? []).map((n) => restoreNode(n, images, attachments, used));
  // Images the text doesn't place (sent before images had places) go first.
  const unplaced = images.flatMap((img, i) => (used.has(i) ? [] : [imageNode(img)]));
  return { type: 'doc', content: [...unplaced, ...content] };
}

export function imageNode(img: ImageInput): JSONContent {
  return { type: IMAGE_NODE, attrs: { mediaType: img.mediaType, data: img.data } };
}

function restoreNode(
  node: JSONContent,
  images: readonly ImageInput[],
  attachments: readonly string[],
  used: Set<number>,
): JSONContent {
  if (node.type === 'paragraph') {
    const only = node.content?.length === 1 ? node.content[0] : undefined;
    const m = only?.type === 'text' && !only.marks?.length ? IMAGE_MARKER.exec((only.text ?? '').trim()) : null;
    const index = m ? Number(m[1]) - 1 : -1;
    if (index >= 0 && images[index] && !used.has(index)) {
      used.add(index);
      return imageNode(images[index]);
    }
  }
  if (!node.content) return node;
  if (node.type === 'codeBlock') return node;
  return { ...node, content: node.content.flatMap((c) => (c.type === 'text' ? splitText(c, attachments) : [restoreNode(c, images, attachments, used)])) };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A text node with its line breaks as `hardBreak`s and attached files' `@path`s as mentions. */
function splitText(node: JSONContent, attachments: readonly string[]): JSONContent[] {
  const text = node.text ?? '';
  const isCode = node.marks?.some((m) => m.type === 'code') ?? false;
  const mention =
    attachments.length > 0 && !isCode
      ? new RegExp(`(^|\\s)@(${[...attachments].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?=\\s|$)`, 'g')
      : null;
  const out: JSONContent[] = [];
  const pushText = (s: string): void => {
    s.split('\n').forEach((part, i) => {
      if (i > 0) out.push({ type: 'hardBreak' });
      if (part) out.push({ ...node, text: part });
    });
  };
  let last = 0;
  if (mention) {
    for (const m of text.matchAll(mention)) {
      const at = m.index + m[1]!.length;
      pushText(text.slice(last, at));
      out.push({ type: MENTION_NODE, attrs: { path: m[2] } });
      last = at + 1 + m[2]!.length;
    }
  }
  pushText(text.slice(last));
  return out;
}

/**
 * A sent message's text for display: each `[Image #N]` alone on its line (not
 * in a code block) as a Markdown image `#image-N`, for the renderer to draw
 * image N there. Says which images it placed; the others have no place.
 */
export function placeImages(text: string, count: number): { text: string; placed: Set<number> } {
  const placed = new Set<number>();
  let fence: string | null = null;
  const lines = text.split('\n').map((line) => {
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) {
      if (fence === null) fence = open[1]!;
      else if (open[1]!.startsWith(fence)) fence = null;
      return line;
    }
    if (fence !== null) return line;
    const m = /^(\s*)\\?\[Image #(\d+)\\?\]\s*$/.exec(line);
    const n = m ? Number(m[2]) : 0;
    if (!m || n < 1 || n > count) return line;
    placed.add(n - 1);
    return `${m[1]}![Image #${n}](#image-${n})`;
  });
  return { text: lines.join('\n'), placed };
}

/** Plain text as a document, as typed: blank lines part paragraphs, a line break is one (`restoreDoc` makes them breaks). */
export function plainTextDoc(text: string): JSONContent {
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  return { type: 'doc', content: paragraphs.map((p) => ({ type: 'paragraph', ...(p ? { content: [{ type: 'text', text: p }] } : {}) })) };
}

/** The document without its images (a draft kept in storage holds no image bytes). */
export function withoutImages(doc: JSONContent): JSONContent {
  if (!doc.content) return doc;
  const content = doc.content
    .filter((n) => n.type !== IMAGE_NODE)
    .map(withoutImages)
    // A quote that held only an image would be left empty, which the schema doesn't take.
    .filter((n) => !(n.content && n.content.length === 0 && n.type !== 'paragraph' && n.type !== 'codeBlock'));
  return { ...doc, content };
}

/** Whether a document holds nothing worth keeping or sending. */
export function isEmptyDoc(doc: JSONContent): boolean {
  const m = toMessage(doc);
  return m.text === '' && m.images.length === 0;
}
