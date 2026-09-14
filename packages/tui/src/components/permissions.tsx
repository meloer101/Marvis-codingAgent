/**
 * `/permissions` overlay: recently denied auto-mode calls, and the four
 * classifier rule lists. Keys are handled here (the app's useInput is inactive
 * while this overlay is open). Closing retries any denials marked with `r`.
 */

import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { AgentSession, AutoModeConfig, AutoModeDenial, AutoModeRuleGroup } from '@harness-code/core';
import { appendCustomRule, describeToolInput, listUsesDefaults } from '@harness-code/core';

import type { Theme } from '../theme.js';

type Tab = 'denied' | 'rules';

const GROUPS: { key: AutoModeRuleGroup; title: string }[] = [
  { key: 'environment', title: 'environment' },
  { key: 'allow', title: 'allow' },
  { key: 'soft_deny', title: 'soft deny' },
  { key: 'hard_deny', title: 'hard deny' },
];

interface RuleRow {
  group: AutoModeRuleGroup;
  index: number;
  text: string;
}

export function PermissionsOverlay({
  session,
  theme,
  onClose,
}: {
  session: AgentSession;
  theme: Theme;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('denied');
  const [selected, setSelected] = useState(0);
  const [retryIds, setRetryIds] = useState<Set<string>>(() => new Set());
  const [adding, setAdding] = useState<AutoModeRuleGroup | null>(null);
  const [draft, setDraft] = useState('');
  const [tick, setTick] = useState(0);

  const denials = session.recentDenials;
  const cfg = session.autoModeConfig;

  const rows = useMemo(() => flattenRules(cfg), [cfg, tick]);

  const close = (): void => {
    for (const id of retryIds) session.retryDenied(id);
    onClose();
  };

  useInput((input, key) => {
    if (adding) {
      if (key.escape) {
        setAdding(null);
        setDraft('');
        return;
      }
      if (key.return) {
        const group = adding;
        const next = appendCustomRule(cfg[group], draft);
        void session.patchUserAutoMode({ [group]: next }).then(() => setTick((n) => n + 1));
        setAdding(null);
        setDraft('');
        return;
      }
      if (key.backspace || key.delete) {
        setDraft((s) => s.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) setDraft((s) => s + input);
      return;
    }

    if (key.escape) {
      close();
      return;
    }
    if (input === '1') {
      setTab('denied');
      setSelected(0);
      return;
    }
    if (input === '2') {
      setTab('rules');
      setSelected(0);
      return;
    }
    if (key.tab) {
      setTab((t) => (t === 'denied' ? 'rules' : 'denied'));
      setSelected(0);
      return;
    }

    const max = tab === 'denied' ? denials.length : rows.length;
    if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
    else if (key.downArrow) setSelected((i) => Math.min(Math.max(0, max - 1), i + 1));

    if (tab === 'denied' && input === 'r' && denials[selected]) {
      const id = denials[selected]!.id;
      setRetryIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }

    if (tab === 'rules' && input === 'a') {
      const row = rows[selected];
      setAdding(row?.group ?? 'environment');
      setDraft('');
    }
    if (tab === 'rules' && (input === 'd' || key.delete || key.backspace) && rows[selected]) {
      const row = rows[selected]!;
      const list = [...(cfg[row.group] ?? ['$defaults'])];
      list.splice(row.index, 1);
      void session.patchUserAutoMode({ [row.group]: list }).then(() => {
        setTick((n) => n + 1);
        setSelected((i) => Math.max(0, i - 1));
      });
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold>permissions</Text>
      <Text>
        <Text color={tab === 'denied' ? theme.accent : theme.dim}>[1] recently denied</Text>
        {'  '}
        <Text color={tab === 'rules' ? theme.accent : theme.dim}>[2] auto mode</Text>
      </Text>
      {tab === 'denied' ? (
        <DeniedList denials={denials} selected={selected} retryIds={retryIds} theme={theme} />
      ) : (
        <RulesList cfg={cfg} rows={rows} selected={selected} theme={theme} />
      )}
      {adding ? (
        <Text>
          add {adding}: {draft}
          <Text color={theme.dim}>█</Text>
        </Text>
      ) : (
        <Text color={theme.dim}>
          {tab === 'denied'
            ? 'r retry · Esc close (retries marked)'
            : 'a add · d delete · Tab switch · Esc close'}
        </Text>
      )}
    </Box>
  );
}

function DeniedList({
  denials,
  selected,
  retryIds,
  theme,
}: {
  denials: readonly AutoModeDenial[];
  selected: number;
  retryIds: Set<string>;
  theme: Theme;
}) {
  if (denials.length === 0) {
    return <Text color={theme.dim}>(no recent auto-mode denials)</Text>;
  }
  return (
    <Box flexDirection="column">
      {denials.slice(0, 12).map((d, i) => {
        const mark = retryIds.has(d.id) ? '*' : ' ';
        const label = d.label ? `[${d.label}]` : '';
        const preview = describeToolInput(d.toolName, d.input);
        const line = `${mark} ${d.toolName} ${preview}${label ? `  ${label}` : ''}`;
        return (
          <Text key={d.id} color={i === selected ? theme.accent : theme.text} inverse={i === selected}>
            {line.slice(0, 100)}
          </Text>
        );
      })}
    </Box>
  );
}

function RulesList({
  cfg,
  rows,
  selected,
  theme,
}: {
  cfg: AutoModeConfig;
  rows: RuleRow[];
  selected: number;
  theme: Theme;
}) {
  let cursor = 0;
  return (
    <Box flexDirection="column">
      {GROUPS.map((g) => {
        const list = cfg[g.key];
        const uses = listUsesDefaults(list);
        const groupRows = rows.filter((r) => r.group === g.key);
        const block = (
          <Box key={g.key} flexDirection="column">
            <Text bold>
              {g.title}
              <Text color={theme.dim}>{uses ? '  · $defaults' : '  · custom only'}</Text>
            </Text>
            {groupRows.length === 0 && <Text color={theme.dim}>  (empty — add to replace defaults)</Text>}
            {groupRows.map((row) => {
              const i = cursor++;
              const isSel = i === selected;
              const text = row.text === '$defaults' ? '$defaults  (built-in rules splice here)' : row.text;
              return (
                <Text key={`${row.group}:${row.index}`} color={isSel ? theme.accent : theme.text} inverse={isSel}>
                  {'  '}
                  {text.slice(0, 90)}
                </Text>
              );
            })}
          </Box>
        );
        return block;
      })}
    </Box>
  );
}

function flattenRules(cfg: AutoModeConfig): RuleRow[] {
  const rows: RuleRow[] = [];
  for (const g of GROUPS) {
    const list = cfg[g.key];
    const items = list === undefined ? ['$defaults'] : list;
    items.forEach((text, index) => rows.push({ group: g.key, index, text }));
  }
  return rows;
}
