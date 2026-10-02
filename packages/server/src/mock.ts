/**
 * `--mock` mode: a `SessionConfigFactory` backed by a `ScriptedProvider`
 * (`@harness-code/core`) that replays a fixed script instead of calling a real
 * model. Frontend development and demos cost nothing and stay deterministic
 * for screenshots (`hc web --mock`, docs/web.md "Running it").
 *
 * The script, consumed across two sends, covers every UI surface: streamed
 * thinking + text, read-only lookups, a task list, a `bash` tool, `write` +
 * `edit` file tools (each asks for permission in `ask` mode), and — after the
 * client switches to plan mode — an `exit_plan_mode` plan approval.
 */

import {
  DEFAULT_ALLOW_RULES,
  DEFAULT_CAPABILITIES,
  ProviderError,
  ScriptedProvider,
  effortOptions,
} from '@harness-code/core';
import type {
  AgentSessionConfig,
  EffortOptions,
  ModelCapabilities,
  ModelDescription,
  Provider,
  ResolvedModel,
  ScriptedTurn,
} from '@harness-code/core';

import type { SessionConfigFactory } from './registry.js';

const MOCK_FILE = 'mock-demo.txt';

/** The reel's task list: looking around is done; the other two go as given. */
function mockTodos(commands: string, scratch: string): Array<{ id: string; content: string; status: string }> {
  return [
    { id: '1', content: 'Look around the workspace', status: 'completed' },
    { id: '2', content: 'Check that commands run', status: commands },
    { id: '3', content: 'Set up a scratch file', status: scratch },
  ];
}

/** The fixed reel. A fresh copy is handed to every new session. */
function mockScript(): ScriptedTurn[] {
  return [
    // Send #1 (ask mode): look around (read-only, so no prompts — the web
    // folds these into one line), then three tools that each prompt.
    {
      thinking: 'Let me get my bearings in this workspace before I touch anything.',
      toolCalls: [
        { name: 'glob', input: { pattern: '*.md' } },
        { name: 'grep', input: { pattern: 'TODO', glob: '*.md' } },
      ],
    },
    {
      thinking: 'A README would say what this project is. And a plan, to keep track.',
      toolCalls: [
        { name: 'read', input: { path: 'README.md', limit: 20 } },
        { name: 'todo', input: { todos: mockTodos('in_progress', 'pending') } },
      ],
    },
    {
      // `tee` keeps this out of the read-only set — read-only commands are
      // allowed in every mode now, and this reel exists to show the approval
      // flow. The loop prints in steps, in colour, to show output streaming.
      text: "I'll check that I can run commands here.",
      chunkSize: 12,
      toolCalls: [
        {
          name: 'bash',
          input: {
            command:
              'echo "hello from the hc web mock"; ' +
              "for i in 1 2 3; do sleep 0.25; printf '\\033[32m✓\\033[0m step %s of 3\\n' \"$i\"; done | tee /dev/null",
          },
        },
      ],
    },
    {
      text: 'Good. Now I need a scratch file to work in.',
      chunkSize: 12,
      toolCalls: [
        { name: 'write', input: { path: MOCK_FILE, content: 'first line\nsecond line\n' } },
      ],
    },
    {
      text: 'Let me refine that first line.',
      toolCalls: [
        {
          name: 'edit',
          input: {
            path: MOCK_FILE,
            oldString: 'first line',
            newString: 'first line (edited by the mock)',
          },
        },
        { name: 'todo', input: { todos: mockTodos('completed', 'completed') } },
      ],
    },
    { text: 'All set — the scratch file is ready.' },
    // Send #2 (plan mode): draft a plan and hand it over for approval.
    {
      thinking: 'They switched me to plan mode, so I should propose a plan rather than act.',
      text: "Here's what I'd do.",
      toolCalls: [
        {
          name: 'exit_plan_mode',
          input: {
            title: 'Mock plan',
            plan: '1. Read the existing code\n2. Make the change\n3. Add a test\n4. Verify',
          },
        },
      ],
    },
    { text: 'Thanks — the plan is approved, so I can proceed.' },
  ];
}

/** The model ref every mock session starts on. */
export const MOCK_MODEL_REF = 'mock/mock-model';

/**
 * A reasoning model on the default effort ladder, so the effort picker has
 * something to show. The scripted provider ignores the effort it is sent.
 */
const MOCK_CAPABILITIES: ModelCapabilities = { ...DEFAULT_CAPABILITIES, reasoning: true, defaultEffort: 'medium' };

/**
 * The models a mock session can switch between: the default, and a smaller
 * one without reasoning, so the model picker has something to show. Both
 * play the same reel.
 */
const MOCK_MODELS: Record<string, ModelCapabilities> = {
  [MOCK_MODEL_REF]: MOCK_CAPABILITIES,
  'mock/mock-mini': { ...DEFAULT_CAPABILITIES, contextWindow: 32_000, maxOutputTokens: 4_096 },
};

/** A mock model's effort levels and starting level (the default model's, for an unknown ref). */
export function mockEffortOptions(ref: string = MOCK_MODEL_REF): EffortOptions {
  return effortOptions(MOCK_MODELS[ref] ?? MOCK_CAPABILITIES);
}

/** What `model.list` offers under `--mock`. */
export function mockModels(): ModelDescription[] {
  return Object.entries(MOCK_MODELS).map(([ref, caps]) => {
    const { levels, initial } = effortOptions(caps);
    return {
      ref,
      contextWindow: caps.contextWindow,
      maxOutputTokens: caps.maxOutputTokens,
      effortLevels: [...levels],
      ...(initial ? { defaultEffort: initial } : {}),
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    };
  });
}

/** `ref` as a model on `provider` — one provider per session, so a switch keeps the reel's place. */
function mockModel(provider: Provider, ref: string = MOCK_MODEL_REF): ResolvedModel {
  const caps = MOCK_MODELS[ref];
  if (!caps) throw new ProviderError('not_found', `no mock model "${ref}"`);
  return {
    provider,
    providerId: provider.id,
    model: ref.slice('mock/'.length),
    ref,
    capabilities: { ...caps },
  };
}

/**
 * Build sessions that talk to the scripted provider. `ask` mode by default so
 * the tools prompt; trace off.
 *
 * `agentDir` is where the mock records its sessions. Recording matters: the
 * recorder persists each message as the loop commits it, which is what lets a
 * snapshot taken mid-run (a reload during a permission ask) show the turn so
 * far — without it the snapshot only sees turns that already finished.
 * `startServer` points this at a throwaway temp dir so mock sessions never
 * land in the project's real `.agent/`. Omitted, recording stays off.
 */
export function mockConfigFactory(cwd: string, agentDir?: string): SessionConfigFactory {
  return (opts) => {
    const provider = new ScriptedProvider(mockScript(), 'mock');
    const config: AgentSessionConfig = {
      cwd,
      model: mockModel(provider, opts.model && MOCK_MODELS[opts.model] ? opts.model : MOCK_MODEL_REF),
      resolveModel: (ref) => mockModel(provider, ref),
      // A real project's defaults: lookups run without asking.
      settings: { permissions: { allow: [...DEFAULT_ALLOW_RULES] } },
      budgets: {},
      mode: opts.mode ?? 'ask',
      skills: false,
      subagents: false,
      mcp: false,
      memory: false,
      recorder: agentDir !== undefined,
      ...(agentDir !== undefined ? { agentDir } : {}),
      trace: false,
      projectMemory: null,
      ...(opts.effort ? { reasoningEffort: opts.effort } : {}),
      ...(opts.resumeId ? { resumeId: opts.resumeId } : {}),
    };
    return Promise.resolve(config);
  };
}
