import { isValidElement, memo } from 'react';
import type { ReactElement, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly';
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough/parseOnly';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import type { ImageInput } from '@harness-code/core';

import { CodeBlock } from '@/components/CodeBlock';
import { InlineImage } from '@/components/ImageThumbs';
import { closeOpenFences } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import { platform } from '@/platform';

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

function makeComponents(streaming: boolean): Components {
  return {
    pre({ children }) {
      const child = Array.isArray(children) ? children[0] : children;
      const props = isValidElement(child)
        ? (child as ReactElement<{ className?: string; children?: ReactNode }>).props
        : {};
      const lang = /language-([\w+-]+)/.exec(props.className ?? '')?.[1];
      const code = textOf(props.children).replace(/\n$/, '');
      return <CodeBlock code={code} lang={lang} streaming={streaming} />;
    },
    a({ href, children }) {
      return (
        <a
          href={href}
          onClick={(e) => {
            if (!href) return;
            e.preventDefault();
            platform.openExternal(href);
          }}
        >
          {children}
        </a>
      );
    },
    table({ children }) {
      return (
        <div className="my-2 overflow-x-auto">
          <table>{children}</table>
        </div>
      );
    },
  };
}

/**
 * CommonMark only closes `**` after punctuation when whitespace or more
 * punctuation follows, so `**注意：**这个` and `这是**「重点」**内容` — Chinese
 * puts no space there — rendered with the asterisks showing. The cjk-friendly
 * plugins relax that rule next to CJK text, for `**`, `*` and GFM's `~~`.
 */
const remarkPlugins = [remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough];
/** What the user wrote: a line break they typed is one, as it was in the composer. */
const typedPlugins = [...remarkPlugins, remarkBreaks];

const settledComponents = makeComponents(false);
const streamingComponents = makeComponents(true);

/** `![Image #N](#image-N)` (see `placeImages`) drawn as the message's image N. */
function withImages(base: Components, images: readonly ImageInput[]): Components {
  return {
    ...base,
    img({ src, alt }) {
      const n = /^#image-(\d+)$/.exec(typeof src === 'string' ? src : '');
      const image = n ? images[Number(n[1]) - 1] : undefined;
      return image ? <InlineImage image={image} label={alt || `Image ${n![1]}`} /> : null;
    },
  };
}

export const MarkdownBody = memo(function MarkdownBody({
  text,
  streaming = false,
  breaks = false,
  images,
  className,
}: {
  text: string;
  streaming?: boolean;
  /** Single line breaks are breaks (a user's message), not spaces. */
  breaks?: boolean;
  /** The message's images, for its `#image-N` images (a user's message). */
  images?: readonly ImageInput[];
  className?: string;
}) {
  const base = streaming ? streamingComponents : settledComponents;
  return (
    <div className={cn('md', className)}>
      <ReactMarkdown
        remarkPlugins={breaks ? typedPlugins : remarkPlugins}
        components={images?.length ? withImages(base, images) : base}
      >
        {streaming ? closeOpenFences(text) : text}
      </ReactMarkdown>
    </div>
  );
});
