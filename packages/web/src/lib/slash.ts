/**
 * The `/` menu's command list. Four sources, one list:
 *  - client-side (`/help`, `/model`, …) — handled in the page, never sent,
 *  - server-side (`/compact`, `/plan`) — `SessionHost` handles them,
 *  - MCP prompts — whatever `session.slashCommands` reports,
 *  - skills — `/name [task]` asks the model to load the skill (`session.skills`).
 */

import type { PermissionMode, ReasoningEffort, SlashCommandInfo } from '@harness-code/core';
import type { SkillInfo } from '@harness-code/protocol';

export type SlashSource = 'client' | 'server' | 'mcp' | 'skill';

export interface SlashCommand {
  name: string;
  hint: string;
  source: SlashSource;
}

export const CLIENT_COMMANDS: SlashCommand[] = [
  { name: 'help', hint: 'Commands and keyboard shortcuts', source: 'client' },
  { name: 'clear', hint: 'Start a fresh session', source: 'client' },
  { name: 'model', hint: 'Switch the model — /model <provider/model>', source: 'client' },
  { name: 'effort', hint: 'Reasoning effort — /effort <level>', source: 'client' },
  { name: 'mode', hint: 'Permission mode — /mode <ask|acceptEdits|plan|readOnly|auto|yolo>', source: 'client' },
  { name: 'cost', hint: 'Context and what the session has spent', source: 'client' },
  { name: 'skills', hint: 'The installed skills', source: 'client' },
];

export const SERVER_COMMANDS: SlashCommand[] = [
  { name: 'compact', hint: 'Summarise the context now', source: 'server' },
  { name: 'plan', hint: 'Switch to plan mode', source: 'server' },
];

export function allCommands(mcp: readonly SlashCommandInfo[] = [], skills: readonly SkillInfo[] = []): SlashCommand[] {
  const taken = new Set([...CLIENT_COMMANDS, ...SERVER_COMMANDS].map((c) => c.name));
  const prompts = mcp.map((p) => ({ name: p.command, hint: `${p.server} prompt`, source: 'mcp' as const }));
  for (const p of prompts) taken.add(p.name);
  return [
    ...CLIENT_COMMANDS,
    ...SERVER_COMMANDS,
    ...prompts,
    // An MCP prompt of the same name wins on the server; don't list a skill it hides.
    ...skills.filter((s) => !taken.has(s.name)).map((s) => ({ name: s.name, hint: s.description, source: 'skill' as const })),
  ];
}

/**
 * The menu is open only while the text is a single `/token` — the first line,
 * no whitespace yet, so `/compact` matches but `/mcp foo bar` (already typing
 * arguments) does not. Returns null when the menu should be closed.
 */
export function slashQuery(text: string): string | null {
  const m = /^\/(\S*)$/.exec(text);
  return m ? (m[1] ?? '') : null;
}

/** Prefix matches first, then substring; stable within each group. */
export function filterCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (q === '') return [...commands];
  const prefix: SlashCommand[] = [];
  const rest: SlashCommand[] = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(c);
    else if (name.includes(q)) rest.push(c);
  }
  return [...prefix, ...rest];
}

/** A popover or dialog a command opens. */
export type CommandSurface = 'model' | 'effort' | 'mode' | 'usage' | 'skills';

/** What a client-side command asks for. */
export type ClientAction =
  | { kind: 'help' }
  | { kind: 'clear' }
  | { kind: 'open'; surface: CommandSurface }
  | { kind: 'model'; ref: string }
  | { kind: 'effort'; effort: ReasoningEffort }
  | { kind: 'mode'; mode: PermissionMode }
  | { kind: 'error'; message: string };

const EFFORTS: readonly ReasoningEffort[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const MODES: readonly PermissionMode[] = ['ask', 'plan', 'acceptEdits', 'readOnly', 'yolo', 'auto'];

/**
 * The client-side command `text` is, or null when it goes to the server (an
 * ordinary message, `/compact`, a prompt or a skill). A command without its
 * argument opens the picker for it.
 */
export function clientCommand(
  text: string,
  offer: { effortLevels: readonly ReasoningEffort[]; modes: readonly PermissionMode[] },
): ClientAction | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const name = m[1]!;
  const arg = (m[2] ?? '').trim();
  switch (name) {
    case 'help':
      return { kind: 'help' };
    case 'clear':
      return { kind: 'clear' };
    case 'cost':
      return { kind: 'open', surface: 'usage' };
    case 'skills':
      return { kind: 'open', surface: 'skills' };
    case 'model':
      return arg ? { kind: 'model', ref: arg } : { kind: 'open', surface: 'model' };
    case 'effort': {
      if (!arg) return { kind: 'open', surface: 'effort' };
      if (offer.effortLevels.length === 0) return { kind: 'error', message: 'This model has no reasoning effort to set.' };
      const effort = EFFORTS.find((e) => e === arg.toLowerCase());
      return effort && offer.effortLevels.includes(effort)
        ? { kind: 'effort', effort }
        : { kind: 'error', message: `No effort level "${arg}" — this model has ${offer.effortLevels.join(', ')}.` };
    }
    case 'mode': {
      if (!arg) return { kind: 'open', surface: 'mode' };
      const mode = MODES.find((md) => md.toLowerCase() === arg.toLowerCase().replace(/[-_\s]/g, ''));
      return mode && offer.modes.includes(mode)
        ? { kind: 'mode', mode }
        : { kind: 'error', message: `No mode "${arg}" here — try ${offer.modes.join(', ')}.` };
    }
    default:
      return null;
  }
}
