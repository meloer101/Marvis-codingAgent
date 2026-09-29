import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_CAPABILITIES,
  DEFAULT_REASONING_EFFORTS,
  ScriptedProvider,
  SessionRecorder,
  updateSessionMeta,
} from '@harness-code/core';
import type { EffortOptions, PermissionMode, ResolvedModel, ScriptedTurn } from '@harness-code/core';
import type { PushEvent } from '@harness-code/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InvalidRequestError } from './host.js';
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

/** The scripted test model offers the default ladder, starting at medium; nothing else offers effort. */
const effortFor = (ref: string): EffortOptions =>
  ref === 'scripted/test-model'
    ? { levels: DEFAULT_REASONING_EFFORTS, initial: 'medium' }
    : { levels: [], initial: undefined };

function registry(cwd: string, agentDir: string, buildConfig = vi.fn()) {
  return new SessionRegistry({
    cwd,
    agentDir,
    buildConfig,
    previewDefaults: async () => ({ modelRef: 'scripted/test-model', mode: 'ask' }),
    effortFor,
    sweepMs: 0,
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

describe('SessionRegistry resume from metadata', () => {
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

describe('SessionRegistry lifecycle', () => {
  it('shares one resume between concurrent opens of a session', async () => {
    const { reg, buildConfig } = await diskSession({});
    const [a, b] = await Promise.all([reg.open({ id: 'resumed' }), reg.open({ id: 'resumed' })]);
    expect(buildConfig).toHaveBeenCalledTimes(1);
    expect(a.epoch).toBeTruthy();
    expect(a.epoch).toBe(b.epoch);
    await reg.shutdown();
  });

  it('previews without resuming: the host appears only once something acts on the session', async () => {
    const { reg, buildConfig } = await diskSession({});
    const preview = await reg.preview({ id: 'resumed' });
    expect(preview.epoch).toBeUndefined();
    expect(reg.get('resumed')).toBeUndefined();
    const host = await reg.ensure('resumed');
    expect(reg.get('resumed')).toBe(host);
    expect((await reg.preview({ id: 'resumed' })).epoch).toBe(host.epoch);
    expect(buildConfig).toHaveBeenCalledTimes(1);
    await reg.shutdown();
  });

  it('sweeps hosts nobody watches once idle, and pushes that they went offline', async () => {
    const { reg } = await diskSession({});
    const host = await reg.ensure('resumed');
    const later = Date.now() + 60 * 60_000;

    const unsub = host.addListener(() => {});
    reg.sweep(later);
    expect(reg.get('resumed')).toBe(host); // someone is watching

    unsub();
    reg.sweep(Date.now() + 1000);
    expect(reg.get('resumed')).toBe(host); // not idle for long enough

    const changes: PushEvent[] = [];
    reg.onChange((e) => changes.push(e));
    reg.sweep(later);
    expect(reg.get('resumed')).toBeUndefined();
    const deadline = Date.now() + 2000;
    while (changes.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(changes.at(-1)).toMatchObject({ type: 'session_upsert', summary: { id: 'resumed', live: false } });
    await reg.shutdown();
  });
});

describe('SessionRegistry effort', () => {
  it("drops a recorded effort the resumed model doesn't offer", async () => {
    const { reg, buildConfig } = await diskSession({ model: 'scripted/test-model', effort: 'ultra' });
    await reg.open({ id: 'resumed' });
    expect(buildConfig).toHaveBeenCalledWith({ resumeId: 'resumed', model: 'scripted/test-model' });
    await reg.shutdown();
  });

  it('previews with the recorded effort and the levels of the recorded model', async () => {
    const { reg } = await diskSession({ model: 'scripted/test-model', effort: 'low' });
    expect(await reg.preview({ id: 'resumed' })).toMatchObject({
      effort: 'low',
      effortLevels: [...DEFAULT_REASONING_EFFORTS],
    });
    const other = await diskSession({ model: 'other/model', effort: 'low' });
    const plain = await other.reg.preview({ id: 'resumed' });
    expect(plain.effortLevels).toEqual([]);
    expect(plain.effort).toBeUndefined();
  });

  it('checks the effort a new session asks for against its model', async () => {
    const { reg, buildConfig } = await diskSession({});
    await expect(reg.create({ effort: 'ultra' })).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(reg.create({ model: 'other/model', effort: 'low' })).rejects.toThrow(/no reasoning effort/);
    expect(buildConfig).not.toHaveBeenCalled();
    await reg.create({ effort: 'low' });
    expect(buildConfig).toHaveBeenCalledWith({ effort: 'low' });
    await reg.shutdown();
  });
});
