/**
 * `WorkspaceHub`: several workspaces behind one server — each its own
 * registry and state dir, one shared rev counter, sessions found by id alone
 * (live, remembered, or on disk after a restart).
 */

import { access, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CAPABILITIES, ScriptedProvider, resolveStateDir } from '@harness-code/core';
import type { AgentSessionConfig, ResolvedModel } from '@harness-code/core';
import type { PushEvent } from '@harness-code/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { BusyError, InvalidRequestError } from './host.js';
import { WorkspaceHub, WorkspaceNotFoundError } from './hub.js';
import type { WorkspaceSetupFactory } from './hub.js';
import { SessionPreviewNotFoundError } from './registry.js';
import { memoryWorkspaceStore } from './workspaces.js';
import type { WorkspaceStore } from './workspaces.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function scriptedModel(): ResolvedModel {
  const provider = new ScriptedProvider([{ text: 'done' }, { text: 'done again' }]);
  return { provider, providerId: provider.id, model: 'test-model', ref: `${provider.id}/test-model`, capabilities: { ...DEFAULT_CAPABILITIES } };
}

/** Real state-dir resolution; scripted sessions that record to disk; each config remembers its cwd. */
const setups: WorkspaceSetupFactory = async (root) => {
  const agentDir = await resolveStateDir(root);
  return {
    projectRoot: root,
    agentDir,
    buildConfig: async (o): Promise<AgentSessionConfig> => ({
      cwd: root,
      agentDir,
      model: scriptedModel(),
      settings: {},
      budgets: {},
      mode: o.mode ?? 'yolo',
      skills: false,
      subagents: false,
      mcp: false,
      memory: false,
      recorder: true,
      trace: false,
      projectMemory: null,
      ...(o.resumeId ? { resumeId: o.resumeId } : {}),
    }),
    previewDefaults: async () => ({ modelRef: 'scripted/test-model', mode: 'yolo' }),
    effortFor: () => ({ levels: [], initial: undefined }),
    defaults: async () => ({ model: 'scripted/test-model', mode: 'yolo', modes: ['yolo'], effortLevels: [] }),
  };
};

async function hubOn(
  store: WorkspaceStore,
  launch: string,
  home?: string,
): Promise<{ hub: WorkspaceHub; launchId: string }> {
  const hub = new WorkspaceHub({ store, setup: setups, sweepMs: 0, ...(home ? { home } : {}) });
  cleanups.push(() => hub.shutdown());
  return { hub, launchId: await hub.init(launch) };
}

/** A project directory (a `.git` marks it, so its state lives in `<dir>/.agent`). */
async function project(name: string): Promise<string> {
  const dir = await tempDir(`hc-hub-${name}-`);
  await mkdir(join(dir, '.git'));
  return dir;
}

async function runToEnd(hub: WorkspaceHub, id: string): Promise<void> {
  const host = hub.host(id)!;
  await new Promise<void>((resolve) => {
    const unsub = host.addListener((f) => {
      if (f.t === 'evt' && (f.event.type === 'run_end' || f.event.type === 'run_error')) {
        unsub();
        resolve();
      }
    });
    if (!host.running) resolve();
  });
}

describe('WorkspaceHub', () => {
  it('remembers workspaces, the launch directory becoming the most recent', async () => {
    const [a, b] = [await project('a'), await project('b')];
    const store = memoryWorkspaceStore();
    const first = await hubOn(store, a);
    await first.hub.shutdown();
    const second = await hubOn(store, b);
    const list = await second.hub.workspaces();
    expect(list.map((w) => w.root)).toEqual([b, a]);
    expect(list[0]).toMatchObject({ id: second.launchId, name: b.split('/').at(-1), defaults: { model: 'scripted/test-model' } });
  });

  it('starts sessions in the workspace asked for, the most recent by default, and lists them all with one rev', async () => {
    const [a, b] = [await project('a'), await project('b')];
    const store = memoryWorkspaceStore();
    await (await hubOn(store, a)).hub.shutdown();
    const { hub, launchId } = await hubOn(store, b); // b is now the most recent
    const idA = (await hub.workspaces()).find((w) => w.root === a)!.id;

    const inB = await hub.start({ text: 'in b' }); // no workspace named: the most recent, b
    const inA = await hub.start({ workspaceId: idA, text: 'in a' });
    expect(inB.snapshot.workspaceId).toBe(launchId);
    expect(inA.snapshot.workspaceId).toBe(idA);
    await runToEnd(hub, inA.snapshot.id);
    await runToEnd(hub, inB.snapshot.id);

    const rows = await hub.list();
    expect(rows.map((r) => [r.id, r.workspaceId]).sort()).toEqual(
      [
        [inA.snapshot.id, idA],
        [inB.snapshot.id, launchId],
      ].sort(),
    );
    expect(new Set(rows.map((r) => r.rev)).size).toBe(1);
    // Starting in a workspace makes it the most recent.
    expect((await hub.workspaces())[0]!.id).toBe(idA);
    await expect(hub.start({ workspaceId: 'ffffffffffff', text: 'x' })).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  it('finds a session by id alone after a restart, from the log on disk', async () => {
    const [a, b] = [await project('a'), await project('b')];
    const store = memoryWorkspaceStore();
    const first = await hubOn(store, a);
    const idB = (await (async () => {
      await first.hub.shutdown();
      const h = await hubOn(store, b);
      const started = await h.hub.start({ text: 'hello from b' });
      await runToEnd(h.hub, started.snapshot.id);
      await h.hub.shutdown();
      return started.snapshot.id;
    })());

    const { hub } = await hubOn(store, a); // a fresh hub that has never seen the session
    const preview = await hub.preview(idB);
    expect(preview.workspaceId).toBe((await hub.workspaces()).find((w) => w.root === b)!.id);
    expect(preview.transcript.length).toBeGreaterThan(0);
    expect(hub.host(idB)).toBeUndefined(); // previewing does not resume
    const opened = await hub.open(idB);
    expect(hub.host(idB)?.epoch).toBe(opened.epoch);
    await expect(hub.preview('no-such-session')).rejects.toBeInstanceOf(SessionPreviewNotFoundError);
  });

  it('maps a directory inside a workspace to that workspace, not a second copy of its sessions', async () => {
    const a = await project('a');
    const sub = join(a, 'packages', 'sub');
    await mkdir(sub, { recursive: true });
    const store = memoryWorkspaceStore();
    await (await hubOn(store, a)).hub.shutdown();
    const { hub, launchId } = await hubOn(store, sub);
    expect((await hub.workspaces()).map((w) => w.root)).toEqual([a]);
    expect((await hub.workspace(launchId)).root).toBe(a);
  });

  it('pushes session rows tagged with their workspace', async () => {
    const a = await project('a');
    const { hub, launchId } = await hubOn(memoryWorkspaceStore(), a);
    const events: PushEvent[] = [];
    hub.onChange((e) => events.push(e));
    const started = await hub.start({ text: 'hi' });
    await runToEnd(hub, started.snapshot.id);
    const deadline = Date.now() + 2000;
    while (!events.some((e) => e.type === 'session_upsert') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(events.find((e) => e.type === 'session_upsert')).toMatchObject({ summary: { workspaceId: launchId } });
  });
});

describe('WorkspaceHub add / remove', () => {
  it('adds a project, pushing the new list; adding it (or a folder inside it) again returns it', async () => {
    const [a, b] = [await project('a'), await project('b')];
    const { hub, launchId } = await hubOn(memoryWorkspaceStore(), a);
    const events: PushEvent[] = [];
    hub.onChange((e) => events.push(e));

    const added = await hub.add(b);
    expect(added).toMatchObject({ root: b, name: b.split('/').at(-1) });
    await mkdir(join(b, 'src'));
    expect((await hub.inspect(join(b, 'src'))).workspace?.id).toBe(added.id);
    expect((await hub.add(join(b, 'src'))).id).toBe(added.id);
    expect((await hub.inspect(a)).workspace?.id).toBe(launchId);

    const deadline = Date.now() + 2000;
    while (!events.some((e) => e.type === 'workspaces') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const pushed = events.find((e) => e.type === 'workspaces');
    expect(pushed?.type === 'workspaces' && pushed.workspaces.map((w) => w.root).sort()).toEqual([a, b].sort());
  });

  it('only creates a .agent/ marker when told to', async () => {
    const home = await tempDir('hc-hub-home-');
    await mkdir(join(home, '.agent'));
    const notes = join(home, 'notes');
    await mkdir(notes);
    const a = await project('a');
    const { hub } = await hubOn(memoryWorkspaceStore(), a, home);
    await expect(hub.add(notes)).rejects.toBeInstanceOf(InvalidRequestError);
    const added = await hub.add(notes, { createMarker: true });
    expect(added.root).toBe(notes);
    expect((await hub.inspect(notes)).needsMarker).toBe(false); // it has its own marker now
  });

  it('removes a workspace but never the last one, nor one with a session running', async () => {
    const [a, b] = [await project('a'), await project('b')];
    const { hub, launchId } = await hubOn(memoryWorkspaceStore(), a);
    const added = await hub.add(b);
    const running = await hub.start({ workspaceId: added.id, text: 'hi' });
    // While its run is going it stays.
    if (hub.host(running.snapshot.id)?.running) await expect(hub.remove(added.id)).rejects.toBeInstanceOf(BusyError);
    await runToEnd(hub, running.snapshot.id);
    await hub.remove(added.id);
    expect((await hub.workspaces()).map((w) => w.id)).toEqual([launchId]);
    expect(hub.host(running.snapshot.id)).toBeUndefined(); // its live session closed with it
    await expect(hub.remove(launchId)).rejects.toThrow(/last workspace/);
  });
});

describe('session update / delete', () => {
  it('renames, pins and archives through the metadata, and an empty title goes back to the first message', async () => {
    const a = await project('a');
    const { hub } = await hubOn(memoryWorkspaceStore(), a);
    const started = await hub.start({ text: 'first message' });
    const id = started.snapshot.id;
    await runToEnd(hub, id);

    expect(await hub.update(id, { title: '  Login   flake ', pinned: true })).toMatchObject({
      title: 'Login flake',
      pinned: true,
      archived: false,
    });
    expect(await hub.update(id, { archived: true, pinned: false })).toMatchObject({ pinned: false, archived: true });
    expect((await hub.update(id, { title: '' })).title).toBe('first message');
    expect((await hub.list()).find((r) => r.id === id)).toMatchObject({ archived: true, title: 'first message' });
    await expect(hub.update('nope', { pinned: true })).rejects.toBeInstanceOf(SessionPreviewNotFoundError);
  });

  it('deletes every file a session left, closing its live host first', async () => {
    const a = await project('a');
    const { hub } = await hubOn(memoryWorkspaceStore(), a);
    const events: PushEvent[] = [];
    hub.onChange((e) => events.push(e));
    const started = await hub.start({ text: 'to delete' });
    const id = started.snapshot.id;
    if (hub.host(id)?.running) await expect(hub.delete(id)).rejects.toBeInstanceOf(BusyError);
    await runToEnd(hub, id);
    await hub.update(id, { pinned: true }); // a metadata sidecar

    const sessions = join(a, '.agent', 'sessions');
    await mkdir(join(sessions, id), { recursive: true });
    await writeFile(join(sessions, id, 'toolout-1.txt'), 'offloaded output');
    await writeFile(join(sessions, `${id}.meta.json.4f2a.tmp`), '{}'); // left by a crash
    await mkdir(join(a, '.agent', 'traces'), { recursive: true });
    await writeFile(join(a, '.agent', 'traces', `${id}.jsonl`), '{}\n');
    expect(hub.host(id)).toBeDefined(); // live, and idle

    await hub.delete(id);
    expect(hub.host(id)).toBeUndefined();
    expect((await readdir(sessions)).filter((n) => n.startsWith(id))).toEqual([]);
    await expect(access(join(a, '.agent', 'traces', `${id}.jsonl`))).rejects.toThrow();
    expect((await hub.list()).some((r) => r.id === id)).toBe(false);
    const deadline = Date.now() + 2000;
    while (!events.some((e) => e.type === 'session_removed' && e.id === id) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(events.some((e) => e.type === 'session_removed' && e.id === id)).toBe(true);
    await expect(hub.delete(id)).rejects.toBeInstanceOf(SessionPreviewNotFoundError);
  });
});
