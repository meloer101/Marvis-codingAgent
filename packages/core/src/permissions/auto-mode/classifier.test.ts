import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_CAPABILITIES } from '../../provider/capabilities.js';
import { ScriptedProvider } from '../../provider/mock.js';
import type { ResolvedModel } from '../../provider/router.js';
import type { ToolUseBlock } from '../../provider/types.js';
import { userText } from '../../provider/types.js';
import { createPermissionEngine } from '../engine.js';
import { createPermissionHooks, nonInteractiveAskHandler } from '../hooks.js';
import { AutoModeClassifier } from './classifier.js';
import { AutoModeState } from './state.js';

function model(provider: ScriptedProvider): ResolvedModel {
  return {
    provider,
    providerId: provider.id,
    model: 'scripted-model',
    ref: `${provider.id}/scripted-model`,
    capabilities: { ...DEFAULT_CAPABILITIES },
  };
}

const call: ToolUseBlock = {
  type: 'tool_use',
  id: '1',
  name: 'bash',
  input: { command: 'git push --force' },
};

const messages = [userText('ship it')];

describe('AutoModeClassifier', () => {
  it('allows on phase-1 no and does not call phase 2', async () => {
    const provider = new ScriptedProvider([{ text: '<block>no</block>' }]);
    const classifier = new AutoModeClassifier({ model: model(provider) });
    const result = await classifier.classify(call, messages, { cwd: process.cwd(), mode: 'auto' });
    expect(result.decision).toBe('allow');
    expect(result.countsTowardThreshold).toBe(false);
    expect(provider.callCount).toBe(1);
  });

  it('blocks on phase-2 after phase-1 yes, using the parsed rule label', async () => {
    const provider = new ScriptedProvider([
      { text: '<block>yes</block>' },
      {
        text: '<decision>block</decision><rule>Git Destructive</rule><reason>force-push rewrites history</reason>',
      },
    ]);
    const classifier = new AutoModeClassifier({ model: model(provider) });
    const result = await classifier.classify(call, messages, { cwd: process.cwd(), mode: 'auto' });
    expect(result.decision).toBe('deny');
    expect(result.label).toBe('Git Destructive');
    expect(result.countsTowardThreshold).toBe(true);
    expect(provider.callCount).toBe(2);
    expect(provider.requests[0]?.system?.[0]?.text).not.toContain('<decision>allow</decision>');
    expect(provider.requests[1]?.system?.[0]?.text).toContain('<decision>allow</decision>');
    expect(provider.requests[1]?.messages).toEqual(provider.requests[0]?.messages);
  });

  it('denies without counting when the model errors', async () => {
    const provider = new ScriptedProvider([
      { error: { kind: 'network', message: 'classifier down' } },
    ]);
    const classifier = new AutoModeClassifier({ model: model(provider) });
    const result = await classifier.classify(call, messages, { cwd: process.cwd(), mode: 'auto' });
    expect(result.decision).toBe('deny');
    expect(result.countsTowardThreshold).toBe(false);
    expect(result.reason).toMatch(/cannot determine the safety/);
    expect(result.reason).toContain('classifier down');
    expect(result.undetermined).toBe(true);
  });
});

describe('createPermissionHooks auto mode', () => {
  it('pauses after three counted denials; non-interactive then denies and keeps the run going', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hc-auto-'));
    try {
      const provider = new ScriptedProvider(
        Array.from({ length: 6 }, () => ({
          text: '<block>yes</block>',
        })).flatMap((p1) => [
          p1,
          {
            text: '<decision>block</decision><rule>Git Destructive</rule><reason>nope</reason>',
          },
        ]),
      );
      const engine = createPermissionEngine({
        workspaceRoot: root,
        mode: 'auto',
        allow: [],
        ask: [],
        deny: [],
      });
      const state = new AutoModeState();
      const notices: string[] = [];
      const hooks = createPermissionHooks(engine, nonInteractiveAskHandler, {
        classifier: new AutoModeClassifier({ model: model(provider) }),
        state,
        onNotice: (n) => notices.push(n.kind),
      });
      const ctx = { turn: 1, cwd: root, messages };
      for (let i = 0; i < 3; i++) {
        const d = await hooks.onBeforeToolCall?.(
          { ...call, id: String(i) },
          ctx,
        );
        expect(d?.decision).toBe('deny');
      }
      expect(state.paused).toBe(true);
      expect(notices.filter((k) => k === 'paused')).toHaveLength(1);

      const fourth = await hooks.onBeforeToolCall?.({ ...call, id: '3' }, ctx);
      expect(fourth?.decision).toBe('deny');
      if (fourth && fourth.decision === 'deny') {
        expect(fourth.reason).toMatch(/non-interactive/i);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('hands the call to the ask handler when the classifier cannot decide', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hc-auto-'));
    try {
      const provider = new ScriptedProvider([
        { error: { kind: 'network', message: 'classifier down' } },
      ]);
      const engine = createPermissionEngine({
        workspaceRoot: root,
        mode: 'auto',
        allow: [],
        ask: [],
        deny: [],
      });
      const state = new AutoModeState();
      const asked: string[] = [];
      const hooks = createPermissionHooks(
        engine,
        async ({ reason }) => {
          asked.push(reason);
          return { decision: 'allow' };
        },
        { classifier: new AutoModeClassifier({ model: model(provider) }), state },
      );
      const decision = await hooks.onBeforeToolCall?.(call, { turn: 1, cwd: root, messages });
      expect(decision).toEqual({ decision: 'allow' });
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatch(/could not classify.*classifier down/);
      expect(state.consecutiveDenials).toBe(0);
      expect(state.recentDenials).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('consumeRetry allows the matching call without invoking the classifier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hc-auto-'));
    try {
      const provider = new ScriptedProvider([]);
      const engine = createPermissionEngine({
        workspaceRoot: root,
        mode: 'auto',
        allow: [],
        ask: [],
        deny: [],
      });
      const state = new AutoModeState();
      state.recordDenial({
        id: '1',
        toolName: 'bash',
        input: call.input,
        reason: 'blocked',
        at: 0,
      });
      expect(state.markRetry('1')).toBeTruthy();
      const hooks = createPermissionHooks(engine, nonInteractiveAskHandler, {
        classifier: new AutoModeClassifier({ model: model(provider) }),
        state,
      });
      const decision = await hooks.onBeforeToolCall?.(call, { turn: 1, cwd: root, messages });
      expect(decision).toEqual({ decision: 'allow' });
      expect(provider.callCount).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
