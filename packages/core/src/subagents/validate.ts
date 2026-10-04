/**
 * Sub-agent frontmatter validation. Same posture as `skills/validate.ts`: a
 * definition that fails is skipped with a one-line reason, never fatal.
 */

import matter from 'gray-matter';

import type { ReasoningEffort } from '../provider/types.js';
import type { AgentDefinition, AgentSource } from './types.js';

/** Effort levels a definition may declare; the provider maps them per model. */
export const AGENT_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const VALID_EFFORTS = AGENT_EFFORTS;

export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;

export type ValidationResult =
  | { ok: true; agent: AgentDefinition }
  | { ok: false; reason: string };

export function parseAgent(input: {
  raw: string;
  /** Filename without `.md` — `name` must match this. */
  stem: string;
  source: AgentSource;
}): ValidationResult {
  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(input.raw);
    data = parsed.data as Record<string, unknown>;
    body = parsed.content.trim();
  } catch (err) {
    return { ok: false, reason: `frontmatter is not valid YAML: ${msg(err)}` };
  }

  const name = data.name;
  if (typeof name !== 'string' || name === '') {
    return { ok: false, reason: 'frontmatter is missing a "name"' };
  }
  if (name.length > MAX_NAME || !NAME_RE.test(name)) {
    return {
      ok: false,
      reason: `name "${name}" must be ≤${MAX_NAME} chars, lowercase alphanumeric and single hyphens only`,
    };
  }
  if (name !== input.stem) {
    return { ok: false, reason: `name "${name}" does not match its file "${input.stem}.md"` };
  }

  const description = data.description;
  if (typeof description !== 'string' || description.trim() === '') {
    return { ok: false, reason: 'frontmatter is missing a non-empty "description"' };
  }
  if (description.length > MAX_DESCRIPTION) {
    return { ok: false, reason: `description exceeds ${MAX_DESCRIPTION} characters` };
  }
  if (body === '') {
    return { ok: false, reason: 'the body (role instructions) is empty' };
  }

  const agent: AgentDefinition = {
    name,
    description: description.trim(),
    body,
    source: input.source,
  };

  const tools = data.tools;
  if (typeof tools === 'string' && tools.trim() !== '') {
    agent.tools = tools
      .split(/[\s,]+/)
      .filter((t) => t !== '')
      .map((t) => t.toLowerCase());
  } else if (Array.isArray(tools)) {
    agent.tools = tools.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase());
  }

  if (typeof data.model === 'string' && data.model.trim() !== '') {
    agent.model = data.model.trim();
  }

  if (typeof data.effort === 'string') {
    const effort = data.effort.trim().toLowerCase();
    if ((VALID_EFFORTS as readonly string[]).includes(effort)) {
      agent.effort = effort as ReasoningEffort;
    } else if (effort !== '') {
      return { ok: false, reason: `effort must be one of ${VALID_EFFORTS.join(', ')}` };
    }
  }

  return { ok: true, agent };
}

/** What a definition's file says, as a form edits it. */
export interface AgentFields {
  description: string;
  /** Omitted: the parent's built-in tools, all of them. Empty: none. */
  tools?: string[];
  model?: string;
  effort?: string;
  /** The role instructions. */
  body: string;
}

/** The frontmatter keys `AgentFields` (and the name) stand for. */
const FIELD_KEYS = ['name', 'description', 'tools', 'model', 'effort'];

/**
 * A definition's file: frontmatter for `name` and `fields`, then the body.
 * Whatever else the frontmatter of `previous` — the file it replaces — has
 * is kept, after them.
 */
export function formatAgentFile(name: string, fields: AgentFields, previous?: string): string {
  let kept: Record<string, unknown> = {};
  if (previous !== undefined) {
    try {
      // A copy: gray-matter caches what it parsed.
      kept = { ...(matter(previous).data as Record<string, unknown>) };
    } catch {
      // A file that doesn't parse has nothing to keep.
    }
  }
  for (const key of FIELD_KEYS) delete kept[key];
  const data: Record<string, unknown> = { name, description: fields.description.trim() };
  // No tools at all is a list; a string that says nothing would mean all of them.
  if (fields.tools) data.tools = fields.tools.length === 0 ? [] : fields.tools.join(' ');
  if (fields.model?.trim()) data.model = fields.model.trim();
  if (fields.effort?.trim()) data.effort = fields.effort.trim();
  // One line a value, never folded: a description reads as written.
  return matter.stringify(`\n${fields.body.trim()}\n`, { ...data, ...kept }, { lineWidth: -1 } as unknown as matter.GrayMatterOption<string, never>);
}

/** The fields of a definition that parsed, as `formatAgentFile` takes them. */
export function agentFields(agent: AgentDefinition): AgentFields {
  return {
    description: agent.description,
    ...(agent.tools ? { tools: agent.tools } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.effort ? { effort: agent.effort } : {}),
    body: agent.body,
  };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
