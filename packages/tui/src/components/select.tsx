/**
 * Vertical option list, Claude Code style: numbered rows with a ❯ pointer on
 * the highlighted one; ↑/↓ (or Ctrl+P/N) move, Enter confirms, a number key
 * picks that row directly, Esc cancels. Owns its keys while mounted.
 *
 * An option can carry an inline text field ("No, and tell the agent what to do
 * differently"): while it is highlighted, typing edits it — digits included, so
 * they are text there, not shortcuts — and Enter confirms with the text.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { Theme } from '../theme.js';

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  /** Dim text after the label, e.g. `(esc)`. */
  hint?: string;
  /** The row doubles as a text field: typing while it is highlighted fills it. */
  input?: boolean;
}

const DEFAULT_VISIBLE = 8;

export function SelectMenu<V extends string>({
  options,
  theme,
  onSelect,
  onCancel,
  maxVisible = DEFAULT_VISIBLE,
}: {
  options: readonly SelectOption<V>[];
  theme: Theme;
  /** `text` is the trimmed inline field of an `input` option, when non-empty. */
  onSelect: (value: V, text?: string) => void;
  onCancel: () => void;
  /** Rows shown at once; a longer list scrolls with the pointer. */
  maxVisible?: number;
}) {
  const [cursor, setCursor] = useState(0);
  const [draft, setDraft] = useState('');

  const count = options.length;
  const index = Math.min(cursor, Math.max(0, count - 1));
  const current = options[index];

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (count === 0) return;
    if (key.upArrow || (key.ctrl && input === 'p')) {
      setCursor((index - 1 + count) % count);
      return;
    }
    if (key.downArrow || (key.ctrl && input === 'n')) {
      setCursor((index + 1) % count);
      return;
    }
    if (key.return) {
      if (current) onSelect(current.value, current.input ? draft.trim() || undefined : undefined);
      return;
    }
    if (current?.input) {
      if (key.backspace || key.delete) setDraft((s) => s.slice(0, -1));
      else if (input && !key.ctrl && !key.meta && !key.tab) {
        setDraft((s) => s + input.replace(/[\r\n]+/g, ' '));
      }
      return;
    }
    if (/^[1-9]$/.test(input)) {
      const n = Number(input) - 1;
      const target = options[n];
      if (!target) return;
      // A field row is only focused by its number — the text still has to be typed.
      if (target.input) setCursor(n);
      else onSelect(target.value);
    }
  });

  const shown = Math.min(maxVisible, count);
  const start = Math.max(0, Math.min(index - Math.floor(shown / 2), count - shown));
  const above = start;
  const below = count - start - shown;
  const numWidth = String(count).length;

  return (
    <Box flexDirection="column">
      {above > 0 && <Text color={theme.dim}>{'  '}↑ {above} more</Text>}
      {options.slice(start, start + shown).map((opt, offset) => {
        const i = start + offset;
        const selected = i === index;
        const num = String(i + 1).padStart(numWidth);
        const typing = selected && opt.input && draft !== '';
        return (
          <Text key={opt.value} color={selected ? theme.accent : theme.text}>
            {selected ? '❯ ' : '  '}
            {num}. {typing ? draft : opt.label}
            {typing ? <Text color={theme.dim}>█</Text> : null}
            {opt.hint && !typing ? <Text color={theme.dim}> {opt.hint}</Text> : null}
          </Text>
        );
      })}
      {below > 0 && <Text color={theme.dim}>{'  '}↓ {below} more</Text>}
      <Box marginTop={1}>
        <Text color={theme.dim}>
          {current?.input
            ? 'Type your feedback · Enter to confirm · Esc to cancel'
            : '↑/↓ to select · Enter to confirm · Esc to cancel'}
        </Text>
      </Box>
    </Box>
  );
}
