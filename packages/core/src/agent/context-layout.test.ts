/**
 * What the model sees, request by request, across a multi-turn session with a
 * mode switch — pinned two ways:
 *
 * - Prefix invariants. Every request's history extends the previous one
 *   (append-only), and system prompt and tool list stay byte-identical within a
 *   mode (and, on a model that takes updates in history, across modes). A
 *   change that breaks one of these throws away the provider's prompt cache for
 *   everything after the break, and shows up here instead of as a cassette miss.
 * - A layout snapshot: the normalized shape of the final request. Any change to
 *   prompt structure shows up as a reviewable snapshot diff.
 *
 * Modelled on codex's `core/tests/suite/prompt_caching.rs` and
 * `core/tests/common/context_snapshot.rs`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CAPABILITIES } from '../provider/capabilities.js';
import type { ModelCapabilities } from '../provider/capabilities.js';
import { ScriptedProvider } from '../provider/mock.js';
import type { ScriptedTurn } from '../provider/mock.js';
import { toOpenAIMessages } from '../provider/openai-compat.js';
import type { ResolvedModel } from '../provider/router.js';
import type { ModelRequest, StreamEvent } from '../provider/types.js';
import { AgentSession } from './session-runner.js';

/** Keeps a deep copy of each request: the loop hands the provider its live history array. */
class SnapshottingProvider extends ScriptedProvider {
  readonly snapshots: Omit<ModelRequest, 'signal'>[] = [];

  override async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    const { signal: _signal, ...rest } = req;
    this.snapshots.push(structuredClone(rest));
    yield* super.stream(req);
  }
}

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const todo = (content: string): ScriptedTurn => ({
  toolCalls: [{ name: 'todo', input: { todos: [{ id: '1', content, status: 'in_progress' }] } }],
});

/** Two user turns — the first in plan mode, the second after switching to acceptEdits — each with a tool call. */
async function runScenario(caps: Partial<ModelCapabilities>) {
  const provider = new SnapshottingProvider([
    todo('look around'),
    { text: 'here is the plan' },
    todo('implement'),
    { text: 'done' },
  ]);
  const model: ResolvedModel = {
    provider,
    providerId: provider.id,
    model: 'test-model',
    ref: `${provider.id}/test-model`,
    capabilities: { ...DEFAULT_CAPABILITIES, ...caps },
  };
  const cwd = await mkdtemp(join(tmpdir(), 'hc-layout-'));
  tmpDirs.push(cwd);
  const session = await AgentSession.create({
    cwd,
    model,
    settings: {},
    budgets: {},
    skills: false,
    subagents: false,
    mcp: false,
    memory: false,
    recorder: false,
    trace: false,
    projectMemory: null,
    mode: 'plan',
  });
  await session.runTurn('plan the change');
  session.setMode('acceptEdits');
  await session.runTurn('go ahead');
  await session.close();
  expect(provider.snapshots).toHaveLength(4);
  return { requests: provider.snapshots, caps: model.capabilities };
}

function expectAppendOnly<T>(requests: T[][]): void {
  for (let i = 1; i < requests.length; i++) {
    const prev = requests[i - 1]!;
    expect(requests[i]!.slice(0, prev.length), `request ${i} rewrote history`).toEqual(prev);
  }
}

const toolNames = (req: Omit<ModelRequest, 'signal'>) => (req.tools ?? []).map((t) => t.name);

function layout(req: Omit<ModelRequest, 'signal'>): string {
  const clip = (s: string) => JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}…` : s);
  const lines = [
    `system: ${(req.system ?? []).map((s) => s.id).join(', ')}`,
    ...(req.systemUpdate ? [`systemUpdate: ${req.systemUpdate.map((s) => s.id).join(', ')}`] : []),
    `tools: ${toolNames(req).join(', ')}`,
    ...req.messages.map(
      (m) =>
        `${m.role}: ${m.content
          .map((b) => {
            if (b.type === 'text') return `text ${clip(b.text)}`;
            if (b.type === 'tool_use') return `tool_use ${b.name}`;
            if (b.type === 'tool_result') return b.isError ? 'tool_result (error)' : 'tool_result';
            return b.type;
          })
          .join(' + ')}`,
    ),
  ];
  return lines.join('\n');
}

describe('context layout', () => {
  it('on an in-history model: one head, one tool list, append-only history for the whole session', async () => {
    const { requests, caps } = await runScenario({ systemPromptUpdate: 'in-history' });

    for (const req of requests) {
      expect(req.system).toEqual(requests[0]!.system);
      expect(req.tools).toEqual(requests[0]!.tools);
    }
    expectAppendOnly(requests.map((r) => r.messages));

    // The mode change rides along as an update, stable within the new mode.
    expect(requests[0]!.systemUpdate).toBeUndefined();
    expect(requests[1]!.systemUpdate).toBeUndefined();
    expect(requests[2]!.systemUpdate).toBeDefined();
    expect(requests[3]!.systemUpdate).toEqual(requests[2]!.systemUpdate);

    // On the wire the update floats to the end of the conversation; everything
    // else must still only grow.
    const wire = requests.map((r) =>
      toOpenAIMessages(r.system, r.messages, caps, {
        ...(r.systemUpdate ? { systemUpdate: r.systemUpdate } : {}),
      }).filter((m, i) => i === 0 || m.role !== 'system'),
    );
    expectAppendOnly(wire);
  });

  it('on a rewrite model: the tool list survives the mode switch, and the head changes only at it', async () => {
    const { requests } = await runScenario({});

    for (const req of requests) {
      expect(req.tools).toEqual(requests[0]!.tools);
      expect(req.systemUpdate).toBeUndefined();
    }
    expect(requests[1]!.system).toEqual(requests[0]!.system);
    expect(requests[3]!.system).toEqual(requests[2]!.system);
    expect(requests[2]!.system).not.toEqual(requests[0]!.system);
    expectAppendOnly(requests.map((r) => r.messages));
  });

  it('matches the layout snapshot', async () => {
    const { requests } = await runScenario({ systemPromptUpdate: 'in-history' });
    expect(layout(requests.at(-1)!)).toMatchInlineSnapshot(`
      "system: identity, conventions, plan_mode, environment
      systemUpdate: system_update, plan_mode_removed
      tools: read, write, edit, glob, grep, bash, todo, webfetch, exit_plan_mode
      user: text "plan the change"
      assistant: tool_use todo
      user: tool_result
      assistant: text "here is the plan"
      user: text "go ahead"
      assistant: tool_use todo
      user: tool_result"
    `);
  });
});
