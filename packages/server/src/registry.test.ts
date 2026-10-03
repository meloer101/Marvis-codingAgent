import { mkdtemp, realpath as realpathOf, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_CAPABILITIES,
  DEFAULT_REASONING_EFFORTS,
  ScriptedProvider,
  SessionRecorder,
  findSessionDir,
  readSessionMeta,
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

describe('SessionRegistry and sessions an earlier version logged in the project', () => {
  it('lists, previews, renames, forks and deletes them where they are; a fork goes where new ones do', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hc-registry-'));
    tmpDirs.push(cwd);
    const agentDir = join(cwd, 'home-state');
    const legacyDir = join(cwd, '.agent');
    await new SessionRecorder(legacyDir, 'old').recordMessage({ role: 'user', content: [{ type: 'text', text: 'from before' }] });
    const reg = new SessionRegistry({
      cwd,
      agentDir,
      legacyDir,
      buildConfig: vi.fn(),
      previewDefaults: async () => ({ modelRef: 'scripted/test-model', mode: 'ask' }),
      effortFor,
      sweepMs: 0,
    });

    expect((await reg.list()).map((row) => row.id)).toEqual(['old']);
    expect(await reg.has('old')).toBe(true);
    expect((await reg.preview({ id: 'old' })).transcript).toHaveLength(1);

    await reg.update('old', { title: 'Kept' });
    expect((await readSessionMeta(legacyDir, 'old'))?.title).toBe('Kept');

    const fork = await reg.fork('old');
    expect(await findSessionDir([agentDir, legacyDir], fork)).toBe(agentDir);
    expect((await reg.preview({ id: fork })).transcript).toHaveLength(1);

    await reg.delete('old');
    expect(await findSessionDir([legacyDir], 'old')).toBeUndefined();
    expect((await reg.list()).map((row) => row.id)).toEqual([fork]);
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

describe('SessionRegistry file changes', () => {
  it('says once that files may have changed, however many calls changed them', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hc-registry-'));
    tmpDirs.push(cwd);
    const model = scriptedModel([
      { toolCalls: [{ name: 'glob', input: { pattern: '*' } }] },
      { toolCalls: [{ name: 'write', input: { path: 'a.txt', content: 'a' } }] },
      { toolCalls: [{ name: 'write', input: { path: 'b.txt', content: 'b' } }] },
      { text: 'done' },
    ]);
    const reg = new SessionRegistry({
      cwd,
      agentDir: join(cwd, '.agent'),
      workspaceId: 'abc123',
      buildConfig: async () => ({
        cwd,
        model,
        settings: {},
        budgets: {},
        mode: 'yolo' as PermissionMode,
        skills: false,
        subagents: false,
        mcp: false,
        memory: false,
        recorder: false,
        trace: false,
        projectMemory: null,
      }),
      previewDefaults: async () => ({ modelRef: 'scripted/test-model', mode: 'yolo' }),
      effortFor,
      sweepMs: 0,
    });
    const changes: PushEvent[] = [];
    reg.onChange((e) => changes.push(e));
    const { id } = await reg.create({});
    const host = reg.get(id)!;
    const ended = new Promise<void>((resolve) => host.addListener((f) => f.t === 'evt' && f.event.type === 'run_end' && resolve()));
    await host.send('write two files');
    await ended;
    await new Promise((r) => setTimeout(r, 400));
    expect(changes.filter((e) => e.type === 'git_changed')).toEqual([{ type: 'git_changed', workspaceId: 'abc123' }]);
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

describe('background commands', () => {
  it('reach the page as events and in the snapshot, keep the host from being swept, and stop on request', async () => {
    const cwd = await realpathOf(await mkdtemp(join(tmpdir(), 'hc-registry-bg-')));
    tmpDirs.push(cwd);
    const buildConfig = vi.fn(async () => ({
      cwd,
      model: scriptedModel([
        { toolCalls: [{ name: 'bash', input: { command: 'echo up; sleep 30', run_in_background: true } }] },
        { text: 'serving' },
      ]),
      settings: { backgroundProcesses: true },
      budgets: {},
      mode: 'yolo' as const,
      skills: false,
      subagents: false,
      mcp: false,
      memory: false,
      recorder: false,
      trace: false,
      projectMemory: null,
    }));
    const reg = registry(cwd, join(cwd, '.agent'), buildConfig);
    const { snapshot } = await reg.start({ text: 'start the server' });
    const host = reg.get(snapshot.id)!;
    const events: string[] = [];
    let printed = '';
    host.addListener((f) => {
      if (f.t !== 'evt') return;
      events.push(f.event.type);
      if (f.event.type === 'process_output') printed += f.event.text;
    });
    const deadline = Date.now() + 5000;
    while (!printed.includes('up') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(printed).toContain('up');

    const snap = await host.snapshot();
    expect(snap.processes).toEqual([expect.objectContaining({ id: 'bg1', status: 'running', output: 'up\n' })]);
    expect(host.processesRunning).toBe(true);
    reg.sweep(Date.now() + 60 * 60_000);
    expect(reg.get(snapshot.id)).toBe(host);

    await expect(host.killProcess('bg7')).rejects.toBeInstanceOf(InvalidRequestError);
    expect(await host.killProcess('bg1')).toMatchObject({ id: 'bg1', status: 'killed' });
    expect(events).toContain('process_end');
    expect(host.processesRunning).toBe(false);
    await reg.shutdown();
  });
});
