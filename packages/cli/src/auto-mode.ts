/**
 * `hc auto-mode` helpers: print built-in rules, dump the effective config
 * with `$defaults` expanded, critique custom rules, and reset user settings.
 */

import { createInterface } from 'node:readline';

import {
  DEFAULT_ALLOW,
  DEFAULT_ENVIRONMENT,
  DEFAULT_HARD_DENY,
  DEFAULT_SOFT_DENY,
  ProviderRegistry,
  clearUserAutoMode,
  isAutoModeAvailable,
  listUsesDefaults,
  loadSettings,
  resolveAutoModeRules,
  ruleLabel,
  userSettingsPath,
} from '@harness-code/core';
import type { AutoModeConfig, Settings } from '@harness-code/core';

const GROUPS = [
  ['environment', DEFAULT_ENVIRONMENT],
  ['allow', DEFAULT_ALLOW],
  ['soft_deny', DEFAULT_SOFT_DENY],
  ['hard_deny', DEFAULT_HARD_DENY],
] as const;

export function formatDefaultRules(labelPrefix?: string): string {
  const prefix = labelPrefix?.trim().toLowerCase() ?? '';
  const parts: string[] = [];
  for (const [name, rules] of GROUPS) {
    const picked = prefix === '' ? [...rules] : rules.filter((r) => ruleLabel(r).toLowerCase().startsWith(prefix));
    if (picked.length === 0) continue;
    parts.push(`## ${name}`);
    for (const r of picked) parts.push(`- ${r}`);
    parts.push('');
  }
  return parts.join('\n').trimEnd();
}

export function formatAutoModeConfig(settings: Settings): string {
  const cfg = settings.autoMode ?? {};
  const resolved = resolveAutoModeRules(settings);
  return `${JSON.stringify(
    {
      model: cfg.model ?? settings.model ?? null,
      classifyAllShell: cfg.classifyAllShell === true,
      injectionProbe: cfg.injectionProbe === true,
      usesDefaults: {
        environment: listUsesDefaults(cfg.environment),
        allow: listUsesDefaults(cfg.allow),
        soft_deny: listUsesDefaults(cfg.soft_deny),
        hard_deny: listUsesDefaults(cfg.hard_deny),
      },
      environment: resolved.environment,
      allow: resolved.allow,
      soft_deny: resolved.soft_deny,
      hard_deny: resolved.hard_deny,
    },
    null,
    2,
  )}\n`;
}

export function customAutoModeEntries(cfg: AutoModeConfig | undefined): { group: string; entries: string[] }[] {
  const groups = ['environment', 'allow', 'soft_deny', 'hard_deny'] as const;
  const out: { group: string; entries: string[] }[] = [];
  for (const group of groups) {
    const entries = (cfg?.[group] ?? []).filter((e) => e !== '$defaults' && e.trim() !== '');
    if (entries.length > 0) out.push({ group, entries });
  }
  return out;
}

const CRITIQUE_PROMPT = `You review custom auto-mode classifier rules for a coding agent.

The built-in lists already cover common allow / soft-deny / hard-deny cases. The user added the custom entries below. For each entry, say:
- whether the label is clear and the prose is specific enough to classify real tool calls
- overlaps or contradictions with typical built-in labels
- how an agent might route around a vague rule

Reply in Markdown. Be concrete. Do not rewrite the entire default list.`;

export function critiqueUserMessage(custom: { group: string; entries: string[] }[]): string {
  return custom
    .map((g) => `## ${g.group}\n${g.entries.map((e) => `- ${e}`).join('\n')}`)
    .join('\n\n');
}

export async function runAutoModeConfig(): Promise<string> {
  const { settings } = await loadSettings();
  return formatAutoModeConfig(settings);
}

export async function runAutoModeCritique(): Promise<string> {
  const { settings } = await loadSettings();
  const custom = customAutoModeEntries(settings.autoMode);
  if (custom.length === 0) {
    return 'no custom auto-mode rules to critique (only $defaults / built-in lists)\n';
  }
  const registry = new ProviderRegistry({ settings });
  const avail = isAutoModeAvailable(settings, registry);
  if (!avail.available) {
    throw new Error(`auto mode unavailable: ${avail.reason}`);
  }
  const model = registry.resolve(avail.modelRef);
  const res = await model.provider.complete({
    model: model.model,
    system: [{ id: 'auto_mode_critique', text: CRITIQUE_PROMPT }],
    messages: [{ role: 'user', content: [{ type: 'text', text: critiqueUserMessage(custom) }] }],
    maxOutputTokens: 2048,
    temperature: 0,
  });
  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return text === '' ? '(classifier returned no critique)\n' : `${text}\n`;
}

export async function runAutoModeReset(opts: { yes?: boolean }): Promise<string> {
  const path = userSettingsPath();
  if (!opts.yes) {
    const ok = await confirm(`Delete autoMode from ${path}? [y/N] `);
    if (!ok) return 'cancelled\n';
  }
  await clearUserAutoMode();
  return `removed autoMode from ${path}\n`;
}

function confirm(query: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      const raw = answer.trim().toLowerCase();
      resolve(raw === 'y' || raw === 'yes');
    });
  });
}
