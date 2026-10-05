/**
 * WebSocket integration tests: a real `startServer` bound to 127.0.0.1, driven
 * by the `ws` client. Covers the three handshake/transport guarantees from
 * docs/web.md "Security" — a bad `Origin` never upgrades, a bad token never
 * authenticates — plus one full authed round-trip (create → subscribe → send →
 * event stream).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CAPABILITIES, ScriptedProvider, userDotEnvPath } from '@harness-code/core';
import type { ResolvedModel, ScriptedTurn } from '@harness-code/core';
import type { PushEvent, ServerFrame, SessionSummary } from '@harness-code/protocol';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from './index.js';
import { loadPty } from './terminals.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

function scriptedModel(turns: readonly ScriptedTurn[]): ResolvedModel {
  const provider = new ScriptedProvider(turns);
  return {
    provider,
    providerId: provider.id,
    model: 'test-model',
    ref: `${provider.id}/test-model`,
    capabilities: { ...DEFAULT_CAPABILITIES },
  };
}

async function boot(turns: readonly ScriptedTurn[] = [{ text: 'hi from the server' }]): Promise<RunningServer> {
  const cwd = await mkdtemp(join(tmpdir(), 'hc-ws-'));
  const server = await startServer({
    cwd,
    buildConfig: () =>
      Promise.resolve({
        cwd,
        model: scriptedModel(turns),
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
  });
  cleanups.push(async () => {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return server;
}

/** A thin promise-based client over a `ws` socket. */
class Client {
  private nextId = 1;
  private readonly pending = new Map<number, (frame: ServerFrame) => void>();
  readonly events: ServerFrame[] = [];
  readonly pushes: PushEvent[] = [];
  readonly terms: Array<Extract<ServerFrame, { t: 'term' }>> = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as ServerFrame;
      if (frame.t === 'evt') {
        this.events.push(frame);
        return;
      }
      if (frame.t === 'push') {
        this.pushes.push(frame.event);
        return;
      }
      if (frame.t === 'term') {
        this.terms.push(frame);
        return;
      }
      this.pending.get(frame.id)?.(frame);
      this.pending.delete(frame.id);
    });
  }

  static open(url: string, origin: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { origin });
      ws.once('open', () => resolve(new Client(ws)));
      ws.once('error', reject);
      ws.once('unexpected-response', () => reject(new Error('unexpected-response')));
    });
  }

  call(method: string, params?: unknown): Promise<ServerFrame> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ t: 'req', id, method, params }));
    });
  }

  onClose(): Promise<number> {
    return new Promise((resolve) => this.ws.once('close', (code) => resolve(code)));
  }

  async waitForEvent(type: string, timeoutMs = 5000): Promise<ServerFrame> {
    const found = this.events.find((f) => f.t === 'evt' && f.event.type === type);
    if (found) return found;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      const check = (): void => {
        const hit = this.events.find((f) => f.t === 'evt' && f.event.type === type);
        if (hit) {
          clearTimeout(timer);
          this.ws.off('message', check);
          resolve(hit);
        }
      };
      this.ws.on('message', check);
    });
  }

  close(): void {
    this.ws.close();
  }
}

/** Terminals need node-pty, which may not load everywhere. */
const ptyLoads = (await loadPty()) !== null;

function wsUrl(server: RunningServer): string {
  return `ws://127.0.0.1:${server.port}/ws`;
}

describe('ws transport', () => {
  it('refuses the upgrade when the Origin is wrong', async () => {
    const server = await boot();
    await expect(Client.open(wsUrl(server), 'http://evil.example.com')).rejects.toBeTruthy();
  });

  it('closes the socket on a bad auth token', async () => {
    const server = await boot();
    const client = await Client.open(wsUrl(server), `http://127.0.0.1:${server.port}`);
    const closed = client.onClose();
    const res = await client.call('auth', { token: 'not-the-token' });
    expect(res).toMatchObject({ t: 'res', ok: false, error: { code: 'unauthorized' } });
    expect(await closed).toBe(4001);
  });

  it('rejects RPC before auth', async () => {
    const server = await boot();
    const client = await Client.open(wsUrl(server), `http://127.0.0.1:${server.port}`);
    const res = await client.call('session.list');
    expect(res).toMatchObject({ t: 'res', ok: false, error: { code: 'unauthorized' } });
  });

  it('runs a full authed round-trip: create → subscribe → send → events', async () => {
    const server = await boot([{ text: 'hello over the wire', chunkSize: 4 }]);
    const client = await Client.open(wsUrl(server), `http://127.0.0.1:${server.port}`);

    const auth = await client.call('auth', { token: server.token });
    expect(auth).toMatchObject({ t: 'res', ok: true });

    const created = await client.call('session.create', {});
    expect(created).toMatchObject({ t: 'res', ok: true });
    const snapshot = (created as { result: { id: string } }).result;
    expect(typeof snapshot.id).toBe('string');

    const sub = await client.call('session.subscribe', { id: snapshot.id });
    expect(sub).toMatchObject({ t: 'res', ok: true, result: { reset: true } });

    const sent = await client.call('session.send', { id: snapshot.id, text: 'go' });
    expect(sent).toMatchObject({ t: 'res', ok: true });
    expect((sent as { result: { runId: string } }).result.runId).toBeTruthy();

    const runEnd = await client.waitForEvent('run_end');
    expect(runEnd).toMatchObject({ t: 'evt', sessionId: snapshot.id });

    const texts = client.events
      .filter((f) => f.t === 'evt' && f.event.type === 'text_delta')
      .map((f) => (f.t === 'evt' && f.event.type === 'text_delta' ? f.event.text : ''));
    expect(texts.join('')).toBe('hello over the wire');

    client.close();
  });

  it('pushes session-list changes to every authed socket, subscribed or not', async () => {
    const server = await boot([{ text: 'done' }]);
    const origin = `http://127.0.0.1:${server.port}`;
    const actor = await Client.open(wsUrl(server), origin);
    const watcher = await Client.open(wsUrl(server), origin);
    const stranger = await Client.open(wsUrl(server), origin); // never authenticates
    await actor.call('auth', { token: server.token });
    await watcher.call('auth', { token: server.token });

    const created = await actor.call('session.create', {});
    const id = (created as { result: { id: string } }).result.id;
    await actor.call('session.send', { id, text: 'fix the flaky test' });

    const rows = async (done: (r: SessionSummary[]) => boolean): Promise<SessionSummary[]> => {
      const deadline = Date.now() + 5000;
      for (;;) {
        const got = watcher.pushes.flatMap((e) => (e.type === 'session_upsert' && e.summary.id === id ? [e.summary] : []));
        if (done(got) || Date.now() > deadline) return got;
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    // Rows carry the state as of when they were computed, so a run this quick
    // may never be seen running — but the last row is always the final state.
    const seen = await rows((r) => r.length >= 2 && r.at(-1)?.running === false && r.at(-1)?.title !== '(new session)');
    expect(seen[0]).toMatchObject({ live: true, running: false }); // created
    expect(seen.at(-1)).toMatchObject({ live: true, running: false, pending: false, title: 'fix the flaky test' });
    const revs = seen.map((s) => s.rev);
    expect(revs).toEqual([...revs].sort((a, b) => a - b)); // strictly newer each time
    expect(stranger.pushes).toEqual([]);

    // A later list outranks every push that came before it.
    const listed = await watcher.call('session.list');
    const listRow = (listed as { result: SessionSummary[] }).result.find((s) => s.id === id);
    expect(listRow!.rev).toBeGreaterThan(revs.at(-1)!);
    for (const c of [actor, watcher, stranger]) c.close();
  });

  it('resets instead of replaying when the epoch names another host', async () => {
    const server = await boot([{ text: 'one' }]);
    const client = await Client.open(wsUrl(server), `http://127.0.0.1:${server.port}`);
    await client.call('auth', { token: server.token });
    const created = await client.call('session.create', {});
    const snap = (created as { result: { id: string; epoch: string; lastSeq: number } }).result;
    expect(snap.epoch).toBeTruthy();

    const same = await client.call('session.subscribe', { id: snap.id, sinceSeq: snap.lastSeq, epoch: snap.epoch });
    expect(same).toMatchObject({ ok: true, result: { lastSeq: snap.lastSeq } });
    const other = await client.call('session.subscribe', { id: snap.id, sinceSeq: snap.lastSeq, epoch: 'gone' });
    expect(other).toMatchObject({ ok: true, result: { reset: true, snapshot: { epoch: snap.epoch } } });
    client.close();
  });

  it('lists the workspaces, and refuses ids that are not ids', async () => {
    const server = await boot();
    const client = await Client.open(wsUrl(server), `http://127.0.0.1:${server.port}`);
    await client.call('auth', { token: server.token });

    const listed = await client.call('workspace.list');
    const workspaces = (listed as { result: Array<{ id: string; root: string; defaults: unknown }> }).result;
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.id).toMatch(/^[0-9a-f]{12}$/);
    expect(workspaces[0]!.defaults).toMatchObject({ modes: expect.any(Array), effortLevels: expect.any(Array) });

    // Ids end up in file paths: nothing but an id's own characters gets through.
    expect(await client.call('session.preview', { id: '../../etc/passwd' })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
    expect(await client.call('session.start', { text: 'x', workspaceId: 'ffffffffffff' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    client.close();
  });

  it("answers a workspace's git status and diff, and refuses a path outside it", async () => {
    const server = await boot();
    const client = await Client.open(wsUrl(server), `http://127.0.0.1:${server.port}`);
    await client.call('auth', { token: server.token });
    const workspaces = (await client.call('workspace.list')) as { result: Array<{ id: string }> };
    const workspaceId = workspaces.result[0]!.id;

    expect(await client.call('git.status', { workspaceId })).toMatchObject({ ok: true, result: { repo: expect.any(Boolean) } });
    expect(await client.call('git.diff', { workspaceId, path: '../outside' })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
    client.close();
  });

  it.skipIf(!ptyLoads)('runs a terminal: output to the sockets attached to it, the list to every tab', async () => {
    const shell = process.env['SHELL'];
    process.env['SHELL'] = '/bin/sh';
    try {
      const server = await boot();
      const origin = `http://127.0.0.1:${server.port}`;
      const a = await Client.open(wsUrl(server), origin);
      const b = await Client.open(wsUrl(server), origin);
      await a.call('auth', { token: server.token });
      await b.call('auth', { token: server.token });
      const info = (await a.call('server.info')) as { result: { capabilities: { terminal: boolean } } };
      expect(info.result.capabilities.terminal).toBe(true);
      const workspaceId = ((await a.call('workspace.list')) as { result: Array<{ id: string }> }).result[0]!.id;

      const created = (await a.call('terminal.create', { workspaceId, cols: 80, rows: 24 })) as { result: { id: string } };
      const { id } = created.result;
      expect(await a.call('terminal.attach', { id })).toMatchObject({ ok: true, result: { scrollback: expect.any(String) } });
      await a.call('terminal.input', { id, data: 'echo hi-from-$((40+2)); exit 5\r' });
      const deadline = Date.now() + 5000;
      while (!a.terms.some((f) => 'exitCode' in f) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      const printed = a.terms.flatMap((f) => ('data' in f ? [f.data] : [])).join('');
      expect(printed).toContain('hi-from-42');
      expect(a.terms.at(-1)).toEqual({ t: 'term', id, exitCode: 5 });
      // B never attached: no output, but it learns the list.
      expect(b.terms).toEqual([]);
      expect(b.pushes.some((p) => p.type === 'terminals' && p.terminals.some((t) => t.id === id))).toBe(true);

      await a.call('terminal.close', { id });
      expect(await a.call('terminal.input', { id, data: 'x' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
      a.close();
      b.close();
    } finally {
      process.env['SHELL'] = shell;
    }
  });

  it('saves an upload where a message can attach it', async () => {
    const server = await boot([{ text: 'read it' }]);
    const client = await Client.open(wsUrl(server), `http://127.0.0.1:${server.port}`);
    await client.call('auth', { token: server.token });

    const up = await client.call('files.upload', { name: '../notes.md', data: Buffer.from('ship it\n').toString('base64') });
    expect(up).toMatchObject({ t: 'res', ok: true, result: { name: 'notes.md', size: 8 } });
    const { path } = (up as { result: { path: string } }).result;
    expect(await readFile(path, 'utf8')).toBe('ship it\n');

    const created = (await client.call('session.create', {})) as { result: { id: string } };
    const sent = await client.call('session.send', { id: created.result.id, text: 'look', attachments: [path] });
    expect(sent).toMatchObject({ t: 'res', ok: true });

    expect(await client.call('files.upload', { name: 'x', data: 'not base64!' })).toMatchObject({
      t: 'res',
      ok: false,
      error: { code: 'bad_request' },
    });
    client.close();
  });

  it('serves server.info once authed', async () => {
    const server = await boot();
    const client = await Client.open(wsUrl(server), `http://127.0.0.1:${server.port}`);
    await client.call('auth', { token: server.token });
    const info = await client.call('server.info');
    expect(info).toMatchObject({ t: 'res', ok: true });
    const result = (info as { result: { version: string; modes: string[] } }).result;
    expect(result.modes).toContain('plan');
    expect(typeof result.version).toBe('string');
  });
});

describe('an API key given in the page', () => {
  it("is saved in the user's ~/.agent/.env and used at once: the default model's problem goes away, no restart", async () => {
    // A project whose default model is on a provider of its own, so the key's variable is nobody else's.
    const cwd = await mkdtemp(join(tmpdir(), 'hc-ws-key-'));
    await mkdir(join(cwd, '.agent'));
    await writeFile(
      join(cwd, '.agent', 'settings.json'),
      JSON.stringify({
        model: 'keytest/some-model',
        providers: {
          keytest: { label: 'Key Test', baseUrl: 'http://127.0.0.1:9/v1', requiresKey: true, apiKeyEnv: ['MARVIS_KEYTEST_API_KEY'] },
        },
      }),
    );
    const server = await startServer({ cwd });
    cleanups.push(async () => {
      await server.close();
      await rm(cwd, { recursive: true, force: true });
    });
    const client = await Client.open(wsUrl(server), `http://127.0.0.1:${server.port}`);
    await client.call('auth', { token: server.token });
    type Listed = { result: Array<{ id: string; defaults: { keyProblem?: string } }> };
    const defaults = async () => ((await client.call('workspace.list')) as Listed).result[0]!.defaults;
    const workspaceId = ((await client.call('workspace.list')) as Listed).result[0]!.id;
    expect((await defaults()).keyProblem).toMatch(/Key Test needs an API key/);

    // Not a key: nothing is written.
    expect(await client.call('providers.setKey', { workspaceId, provider: 'keytest', key: 'two words' })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });

    const saved = await client.call('providers.setKey', { workspaceId, provider: 'keytest', key: 'kt-0123456789' });
    expect(saved).toMatchObject({ ok: true });
    const view = (saved as unknown as { result: { providers: Array<{ id: string; keySource?: string }>; envPath: string } }).result;
    expect(view.providers.find((p) => p.id === 'keytest')).toMatchObject({ keySource: 'user', keySourceVar: 'MARVIS_KEYTEST_API_KEY' });
    expect(JSON.stringify(saved)).not.toContain('kt-0123456789'); // never sent back
    expect(view.envPath).toBe(userDotEnvPath());
    expect(await readFile(userDotEnvPath(), 'utf8')).toContain('MARVIS_KEYTEST_API_KEY=kt-0123456789');

    expect((await defaults()).keyProblem).toBeUndefined();
    const pushed = (): boolean =>
      client.pushes.some((e) => e.type === 'workspaces' && e.workspaces.some((w) => w.id === workspaceId && !w.defaults.keyProblem));
    for (let i = 0; i < 100 && !pushed(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(pushed()).toBe(true); // every open page hears it

    // Removed again: back to needing one.
    expect(await client.call('providers.setKey', { workspaceId, provider: 'keytest', key: null })).toMatchObject({ ok: true });
    expect((await defaults()).keyProblem).toMatch(/Key Test needs an API key/);
    client.close();
  });
});
