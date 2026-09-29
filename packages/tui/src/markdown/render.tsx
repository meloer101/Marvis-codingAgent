/**
 * Streaming Markdown → Ink elements, via `marked.lexer`.
 *
 * The accumulated text is re-lexed on every flush (cheap below ~10KB); an
 * unclosed code fence renders as a code block, so a fence in flight never
 * flashes as a paragraph. Code is rendered dim and monospace, no syntax
 * highlighting (that's `cli-highlight`, deferred to v1.1). Tables render as
 * plain text for now.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Marked } from 'marked';
import type { Token, Tokens } from 'marked';
import markedCjkFriendly from 'marked-cjk-friendly';

import type { Theme } from '../theme.js';

/**
 * CommonMark only closes `**` after punctuation when whitespace or more
 * punctuation follows, so `**注意：**这个` — Chinese puts no space there —
 * rendered with the asterisks showing. The extension relaxes that rule next
 * to CJK text (for `*` / `**`; `~~` keeps the stock rule).
 */
const marked = new Marked(markedCjkFriendly());

function inline(tokens: Token[] | undefined, theme: Theme): React.ReactNode {
  if (!tokens) return null;
  return tokens.map((t, i) => {
    switch (t.type) {
      case 'text':
        return <Text key={i}>{t.tokens ? inline(t.tokens, theme) : t.text}</Text>;
      case 'strong':
        return (
          <Text key={i} bold>
            {inline(t.tokens, theme)}
          </Text>
        );
      case 'em':
        return (
          <Text key={i} italic>
            {inline(t.tokens, theme)}
          </Text>
        );
      case 'codespan':
        return (
          <Text key={i} color={theme.dim} inverse>
            {t.text}
          </Text>
        );
      case 'link':
        return (
          <Text key={i} color={theme.accent} underline>
            {inline(t.tokens, theme)}
          </Text>
        );
      case 'del':
        return (
          <Text key={i} strikethrough>
            {inline(t.tokens, theme)}
          </Text>
        );
      case 'br':
        return '\n';
      default:
        return <Text key={i}>{('text' in t ? t.text : undefined) ?? ''}</Text>;
    }
  });
}

function listItemInlines(item: Tokens.ListItem): Token[] {
  const out: Token[] = [];
  for (const t of item.tokens ?? []) {
    if (t.type === 'text' && t.tokens) out.push(...t.tokens);
    else if (t.type === 'text') out.push(t);
  }
  return out;
}

function block(token: Token, theme: Theme): React.ReactNode {
  switch (token.type) {
    case 'heading':
      return (
        <Text bold>
          {inline(token.tokens, theme)}
        </Text>
      );
    case 'paragraph':
      return <Text wrap="wrap">{inline(token.tokens, theme)}</Text>;
    case 'space':
      return <Text> </Text>;
    case 'list': {
      const list = token as Tokens.List;
      const start = list.start === '' ? 1 : list.start;
      return (
        <>
          {list.items.map((item, i) => (
            <Text key={i}>
              {list.ordered ? `${start + i}. ` : '• '}
              {inline(listItemInlines(item), theme)}
            </Text>
          ))}
        </>
      );
    }
    case 'code': {
      const code = token as Tokens.Code;
      return (
        <Box flexDirection="column" marginY={0}>
          {code.text.split('\n').map((line, i) => (
            <Text key={i} color={theme.dim}>
              {line === '' ? ' ' : line}
            </Text>
          ))}
        </Box>
      );
    }
    case 'blockquote':
      return (
        <Box>
          <Text color={theme.faint}>│ </Text>
          <Box flexDirection="column" flexGrow={1}>
            {(token.tokens ?? []).map((t, i) => (
              <React.Fragment key={i}>{block(t, theme)}</React.Fragment>
            ))}
          </Box>
        </Box>
      );
    case 'hr':
      return <Text color={theme.faint}>{'─'.repeat(40)}</Text>;
    default:
      return <Text>{'text' in token ? token.text : ''}</Text>;
  }
}

export function Markdown({ text, theme }: { text: string; theme: Theme }) {
  const tokens = React.useMemo(() => marked.lexer(text), [text]);
  return (
    <>
      {tokens.map((t, i) => (
        <React.Fragment key={i}>{block(t, theme)}</React.Fragment>
      ))}
    </>
  );
}
