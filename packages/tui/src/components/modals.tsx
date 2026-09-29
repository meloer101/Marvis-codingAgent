/**
 * Modal overlays: permission approval, plan approval, the resume / skills
 * pickers, and the `/help` overlay. Every choice is a `SelectMenu` in Claude
 * Code's style (↑/↓ + Enter, number keys, Esc to cancel) and owns its keys
 * while mounted — the app's central handler stands down for them.
 */

import React from 'react';
import { Box, Text } from 'ink';

import { askOptions, describeToolInput, planOptions, toolDisplayName } from '@harness-code/core';
import type { AskChoice, PermissionMode, PlanChoice } from '@harness-code/core';

import { Markdown } from '../markdown/render.js';
import type { PendingAsk, PendingPlan } from '../state/reducer.js';
import type { Theme } from '../theme.js';
import { truncate } from '../util/width.js';
import { SelectMenu } from './select.js';

export type { AskChoice, PlanChoice };

const PREVIEW_LINES = 12;

/** The heading of a permission prompt, by what is being asked for. */
function askTitle(toolName: string): string {
  switch (toolName.toLowerCase()) {
    case 'bash':
      return 'Bash command';
    case 'write':
      return 'Write file';
    case 'edit':
      return 'Edit file';
    case 'webfetch':
      return 'Fetch URL';
    default:
      return toolName;
  }
}

export function PermissionModal({
  ask,
  theme,
  offerAuto,
  onAnswer,
}: {
  ask: PendingAsk;
  theme: Theme;
  offerAuto?: boolean;
  /** `feedback` accompanies a `deny` the user explained. */
  onAnswer: (choice: AskChoice, feedback?: string) => void;
}) {
  const lines = describeToolInput(ask.toolName, ask.input).split('\n');
  const hidden = Math.max(0, lines.length - PREVIEW_LINES);
  const options = askOptions({ toolLabel: toolDisplayName(ask.toolName), offerAuto: offerAuto === true });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold>{askTitle(ask.toolName)}</Text>
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        <Text>{lines.slice(0, PREVIEW_LINES).join('\n')}</Text>
        {hidden > 0 && <Text color={theme.dim}>… {hidden} more lines</Text>}
        <Text color={theme.dim}>{ask.reason}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>Do you want to proceed?</Text>
      </Box>
      <SelectMenu
        options={options}
        theme={theme}
        onSelect={(choice, feedback) => onAnswer(choice, feedback)}
        onCancel={() => onAnswer('deny')}
      />
    </Box>
  );
}

export function PlanModal({
  plan,
  theme,
  yesMode,
  onAnswer,
}: {
  plan: PendingPlan;
  theme: Theme;
  /** The mode approving switches to — `session.planApprovedMode`. */
  yesMode: PermissionMode;
  onAnswer: (choice: PlanChoice, feedback?: string) => void;
}) {
  const options = planOptions(yesMode);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold>{plan.title}</Text>
      <Markdown text={plan.body} theme={theme} />
      <Box marginTop={1}>
        <Text>Would you like to proceed?</Text>
      </Box>
      <SelectMenu
        options={options}
        theme={theme}
        onSelect={(choice, feedback) => onAnswer(choice, feedback)}
        onCancel={() => onAnswer('no')}
      />
    </Box>
  );
}

export function ResumePicker({
  sessions,
  theme,
  onPick,
  onClose,
}: {
  sessions: { id: string; mtimeMs: number }[];
  theme: Theme;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold>Resume session</Text>
      {sessions.length === 0 && <Text color={theme.dim}>(no sessions)</Text>}
      <SelectMenu
        options={sessions.map((s) => ({ value: s.id, label: s.id }))}
        theme={theme}
        onSelect={onPick}
        onCancel={onClose}
      />
    </Box>
  );
}

export function SkillPicker({
  skills,
  theme,
  onPick,
  onClose,
}: {
  skills: { name: string; description: string }[];
  theme: Theme;
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold>Skills</Text>
      {skills.length === 0 && <Text color={theme.dim}>(no skills installed)</Text>}
      <SelectMenu
        options={skills.map((s) => ({
          value: s.name,
          label: s.name,
          hint: truncate(s.description, 60, 'end'),
        }))}
        theme={theme}
        onSelect={onPick}
        onCancel={onClose}
      />
    </Box>
  );
}

export function Overlay({ theme }: { theme: Theme }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold>keys</Text>
      <Text color={theme.dim}>Esc — abort turn / close · Shift+Tab — cycle mode · Ctrl+C ×2 — quit · Ctrl+D — quit (empty) · Ctrl+O — expand output</Text>
      <Text color={theme.dim}>In prompts: ↑/↓ — select · Enter — confirm · 1-9 — pick · Esc — cancel</Text>
      <Text bold>commands</Text>
      <Text color={theme.dim}>
        /help /clear /quit /compact /cost /resume /mode /plan /effort /permissions /auto-mode-setup /skills · Tab — complete · MCP prompts via /name
      </Text>
    </Box>
  );
}
