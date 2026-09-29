/**
 * `--mock` mode: a `SessionConfigFactory` backed by a `ScriptedProvider`
 * (`@harness-code/core`) that replays a fixed script instead of calling a real
 * model. Frontend development and demos cost nothing and stay deterministic
 * for screenshots (`hc web --mock`, docs/web.md "Running it").
 *
 * The script, consumed across two sends, covers every UI surface: streamed
 * thinking + text, a `bash` tool, `write` + `edit` file tools (each asks for
 * permission in `ask` mode), and — after the client switches to plan mode —
 * an `exit_plan_mode` plan approval.
 */

import { DEFAULT_CAPABILITIES, ScriptedProvider, effortOptions } from '@harness-code/core';
import type { AgentSessionConfig, EffortOptions, ModelCapabilities, ResolvedModel, ScriptedTurn } from '@harness-code/core';

import type { SessionConfigFactory } from './registry.js';

const MOCK_FILE = 'mock-demo.txt';

/** The fixed reel. A fresh copy is handed to every new session. */
function mockScript(): ScriptedTurn[] {
  return [
    // Send #1 (ask mode): think, talk, then three tools that each prompt.
    {
      thinking: 'Let me get my bearings in this workspace before I touch anything.',
      // `tee` keeps this out of the read-only set — read-only commands are
      // allowed in every mode now, and this reel exists to show the approval
      // flow.
      text: "I'll check that I can run commands here.",
      chunkSize: 12,
      toolCalls: [
        {
          name: 'bash',
          input: { command: 'echo "hello from the hc web mock" | tee /dev/null' },
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

/** The model ref every mock session reports. */
export const MOCK_MODEL_REF = 'mock/mock-model';

/**
 * A reasoning model on the default effort ladder, so the effort picker has
 * something to show. The scripted provider ignores the effort it is sent.
 */
const MOCK_CAPABILITIES: ModelCapabilities = { ...DEFAULT_CAPABILITIES, reasoning: true, defaultEffort: 'medium' };

/** The mock model's effort levels and starting level. */
export function mockEffortOptions(): EffortOptions {
  return effortOptions(MOCK_CAPABILITIES);
}

/** A `ResolvedModel` whose provider is a fresh `ScriptedProvider`. */
function mockModel(): ResolvedModel {
  const provider = new ScriptedProvider(mockScript(), 'mock');
  return {
    provider,
    providerId: provider.id,
    model: 'mock-model',
    ref: MOCK_MODEL_REF,
    capabilities: { ...MOCK_CAPABILITIES },
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
    const config: AgentSessionConfig = {
      cwd,
      model: mockModel(),
      settings: {},
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
