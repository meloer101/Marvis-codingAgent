import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CAPABILITIES, ScriptedProvider, SessionRecorder, updateSessionMeta } from '@harness-code/core';
import type { PermissionMode, ResolvedModel, ScriptedTurn } from '@harness-code/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionPreviewNotFoundError, SessionRegistry } from './registry.js';

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function scriptedModel(turns: readonly ScriptedTurn[] = []): ResolvedModel {
  const provider = new ScriptedProvider(turns);
  return {
    provider,
    providerId: provider.id,
    model: 'test-model',
    ref: `${provider.id}/test-model`,
    capabilities: { ...DEFAULT_CAPABILITIES },
  };
}

function registry(cwd: string, agentDir: string, buildConfig = vi.fn()) {
  return new SessionRegistry({
    cwd,
    agentDir,
    buildConfig,
    previewDefaults: async () => ({ modelRef: 'scripted/test-model', mode: 'ask' }),
  });
}

describe('SessionRegistry.preview', () => {
  it('returns disk transcript without calling buildConfig', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hc-registry-'));
    tmpDirs.push(cwd);
    const agentDir = join(cwd, '.agent');
    const buildConfig = vi.fn(() =>
      Promise.resolve({
        cwd,
        model: scriptedModel(),
        settings: {},
        budgets: {},
        mode: 'yolo',
        skills: false,
        subagents: false,
        mcp: false,
        memory: false,
        recorder: false,
        trace: false,
        projectMemory: null,
      }),
    );
    const reg = registry(cwd, agentDir, buildConfig);

    const recorder = new SessionRecorder(agentDir, 'disk-only');
    await recorder.recordMessage({ role: 'user', content: [{ type: 'text', text: 'hello' }] });

    const snap = await reg.preview({ id: 'disk-only' });
    expect(snap.transcript).toHaveLength(1);
    expect(snap.transcript[0]).toMatchObject({ type: 'message' });
    expect(snap.running).toBe(false);
    expect(snap.lastSeq).toBe(0);
    expect(buildConfig).not.toHaveBeenCalled();
  });

  it('throws when the session file is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hc-registry-'));
    tmpDirs.push(cwd);
    const reg = registry(cwd, join(cwd, '.agent'), vi.fn());
    await expect(reg.preview({ id: 'missing' })).rejects.toBeInstanceOf(SessionPreviewNotFoundError);
  });
});

describe('SessionRegistry resume from metadata', () => {
  async function diskSession(meta: Parameters<typeof updateSessionMeta>[2]) {
    const cwd = await mkdtemp(join(tmpdir(), 'hc-registry-'));
    tmpDirs.push(cwd);
    const agentDir = join(cwd, '.agent');
    const recorder = new SessionRecorder(agentDir, 'resumed');
    await recorder.recordMessage({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    await updateSessionMeta(agentDir, 'resumed', meta);
    const buildConfig = vi.fn((opts: { model?: string; mode?: PermissionMode }) =>
      opts.model === 'gone/model'
        ? Promise.reject(new Error('unknown provider "gone"'))
        : Promise.resolve({
            cwd,
            agentDir,
            model: scriptedModel(),
            settings: {},
            budgets: {},
            mode: opts.mode ?? 'ask',
            skills: false,
            subagents: false,
            mcp: false,
            memory: false,
            recorder: false,
            trace: false,
            projectMemory: null,
            resumeId: 'resumed',
          }),
    );
    const reg = registry(cwd, agentDir, buildConfig);
    return { reg, buildConfig };
  }

  it('resumes with the model, mode and effort the session last ran with', async () => {
    const { reg, buildConfig } = await diskSession({ model: 'scripted/test-model', mode: 'plan', effort: 'high' });
    const snap = await reg.open({ id: 'resumed' });
    expect(buildConfig).toHaveBeenCalledWith({
      resumeId: 'resumed',
      model: 'scripted/test-model',
      mode: 'plan',
      effort: 'high',
    });
    expect(snap.mode).toBe('plan');
    await reg.shutdown();
  });

  it('never re-enters yolo or auto implicitly', async () => {
    const { reg, buildConfig } = await diskSession({ mode: 'yolo' });
    const snap = await reg.open({ id: 'resumed' });
    expect(buildConfig).toHaveBeenCalledWith({ resumeId: 'resumed' });
    expect(snap.mode).toBe('ask');
    await reg.shutdown();
  });

  it('falls back to the defaults when the recorded model no longer resolves', async () => {
    const { reg, buildConfig } = await diskSession({ model: 'gone/model', mode: 'acceptEdits' });
    const snap = await reg.open({ id: 'resumed' });
    expect(buildConfig).toHaveBeenLastCalledWith({ resumeId: 'resumed', mode: 'acceptEdits' });
    expect(snap.mode).toBe('acceptEdits');
    await reg.shutdown();
  });

  it('previews with the recorded model and mode instead of the server defaults', async () => {
    const { reg, buildConfig } = await diskSession({ model: 'deepseek/deepseek-pro', mode: 'readOnly' });
    const snap = await reg.preview({ id: 'resumed' });
    expect(snap).toMatchObject({ modelRef: 'deepseek/deepseek-pro', mode: 'readOnly' });
    expect(buildConfig).not.toHaveBeenCalled();
  });
});
