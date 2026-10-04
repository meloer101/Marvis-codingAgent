/**
 * The sub-agents sessions in a workspace can send, for the settings page:
 * listed as discovery finds them — the project's `.agent/agents/`, then
 * yours in `~/.agent/agents/`, then the ones Marvis ships with, a name used
 * where it is first found — with the files it skips and why; each read,
 * written from a form's fields or as a file, and deleted.
 *
 * Writes go only to the project's and yours: the built-in ones are read.
 */

import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AGENT_DIR, AGENT_EFFORTS, agentFields, builtinAgentsDir, builtinTools, formatAgentFile, parseAgent } from '@harness-code/core';
import type { AgentEntryInfo, AgentFields, AgentScope, AgentsView } from '@harness-code/protocol';

import { ConflictError, InvalidRequestError } from './host.js';
import type { SettingsPlace } from './settings.js';

type Place = Pick<SettingsPlace, 'projectRoot' | 'home'>;

export function agentDirs(place: Place): Record<AgentScope, string> {
  return {
    project: join(place.projectRoot, AGENT_DIR, 'agents'),
    user: join(place.home, AGENT_DIR, 'agents'),
    builtin: builtinAgentsDir().replace(/[/\\]$/, ''),
  };
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function agentPath(place: Place, scope: AgentScope, name: string): string {
  // The method's schema keeps `name` one path segment; this is the belt to those braces.
  if (name === '' || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new InvalidRequestError(`not a sub-agent: "${name}"`);
  return join(agentDirs(place)[scope], `${name}.md`);
}

export async function agentsView(place: Place): Promise<AgentsView> {
  const dirs = agentDirs(place);
  const used = new Set<string>();
  const agents: AgentEntryInfo[] = [];
  for (const scope of ['project', 'user', 'builtin'] as const) {
    let files: string[];
    try {
      files = (await readdir(dirs[scope], { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name)
        .sort();
    } catch {
      continue; // no sub-agents there: the usual case
    }
    for (const file of files) {
      const name = file.slice(0, -'.md'.length);
      const path = join(dirs[scope], file);
      const raw = await readOptional(path);
      if (raw === undefined) continue;
      const parsed = parseAgent({ raw, stem: name, source: scope });
      if (parsed.ok) {
        const { description, tools, model, effort } = parsed.agent;
        agents.push({
          name,
          scope,
          path,
          description,
          ...(tools ? { tools } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(used.has(name) ? { shadowed: true } : {}),
        });
        used.add(name);
      } else {
        agents.push({ name, scope, path, description: '', problem: parsed.reason });
      }
    }
  }
  return {
    agents,
    dirs,
    // What a sub-agent is given from: the built-in tools (`subagentToolSpecs`), `task` never among them.
    tools: builtinTools().map((t) => ({ name: t.name, readOnly: t.readOnly })),
    efforts: [...AGENT_EFFORTS],
  };
}

export async function getAgent(place: Place, scope: AgentScope, name: string): Promise<{ text: string; fields?: AgentFields }> {
  const text = await readOptional(agentPath(place, scope, name));
  if (text === undefined) throw new InvalidRequestError(`no sub-agent "${name}" in ${agentDirs(place)[scope]}`);
  const parsed = parseAgent({ raw: text, stem: name, source: scope });
  return { text, ...(parsed.ok ? { fields: agentFields(parsed.agent) } : {}) };
}

function checked(text: string, name: string, scope: AgentScope): void {
  const parsed = parseAgent({ raw: text, stem: name, source: scope });
  if (!parsed.ok) throw new InvalidRequestError(parsed.reason);
}

/**
 * Write a sub-agent from its fields: new, or — with `previousName` — over
 * that one, renaming its file when the names differ and keeping what else
 * its frontmatter had.
 */
export async function saveAgent(place: Place, scope: 'user' | 'project', name: string, fields: AgentFields, previousName?: string): Promise<void> {
  const path = agentPath(place, scope, name);
  const previousPath = previousName !== undefined ? agentPath(place, scope, previousName) : undefined;
  const previous = previousPath !== undefined ? await readOptional(previousPath) : undefined;
  if (previousPath !== undefined && previous === undefined) throw new InvalidRequestError(`no sub-agent "${previousName}" in ${agentDirs(place)[scope]}`);
  if (name !== previousName && (await exists(path))) throw new ConflictError(`there's a sub-agent "${name}" in ${agentDirs(place)[scope]} already`);
  const text = formatAgentFile(name, fields, previous);
  checked(text, name, scope);
  await mkdir(agentDirs(place)[scope], { recursive: true });
  if (previousPath !== undefined && previousPath !== path) await rename(previousPath, path);
  await writeFile(path, text, 'utf8');
}

/** Write a sub-agent's file as it is: it must parse as one named for its file. */
export async function writeAgent(place: Place, scope: 'user' | 'project', name: string, text: string): Promise<void> {
  const body = text.endsWith('\n') ? text : `${text}\n`;
  checked(body, name, scope);
  await mkdir(agentDirs(place)[scope], { recursive: true });
  await writeFile(agentPath(place, scope, name), body, 'utf8');
}

export async function deleteAgent(place: Place, scope: 'user' | 'project', name: string): Promise<void> {
  const path = agentPath(place, scope, name);
  if (!(await exists(path))) throw new InvalidRequestError(`no sub-agent "${name}" in ${agentDirs(place)[scope]}`);
  await rm(path, { force: true });
}
