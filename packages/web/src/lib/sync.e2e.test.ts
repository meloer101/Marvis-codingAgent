// @vitest-environment node
/**
 * End to end: the web client's `SessionSync` against a real `hc web --mock`
 * server over a real socket — auth, create, send, the mock's three permission
 * asks, run end — plus a second "tab" that opens the session mid-ask and
 * answers it (pending ask survives a reload; first answer wins for everyone).
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPty, startServer } from '@harness-code/server';
import type { RunningServer } from '@harness-code/server';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';

import type { SocketLike } from './rpc';
import type { AppState } from './store';
import { SessionSync } from './sync';

const emptyState = (): AppState => ({
  status: 'closed',
  info: null,
  workspaces: [],
  sessions: [],
  views: {},
  slash: {},
  skills: {},
  models: {},
  git: {},
  gitRev: {},
  terminals: {},
  restored: {},
  error: null,
  helpOpen: false,
  addProjectOpen: false,
  paletteOpen: false,
  request: null,
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** The calls the mock reel opens with, before its first prompt: lookups and a task list. */
const LOOK_AROUND = ['glob', 'grep', 'read', 'todo'];

async function boot(): Promise<{ server: RunningServer; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'hc-web-e2e-'));
  const server = await startServer({ cwd, mock: true });
  cleanups.push(async () => {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return { server, cwd };
}

function tab(server: RunningServer, wrap?: (socket: SocketLike) => void, opts: { releaseMs?: number } = {}) {
  const store = createStore<AppState>(() => emptyState());
  const origin = `http://127.0.0.1:${server.port}`;
  const sync = new SessionSync({
    url: `ws://127.0.0.1:${server.port}/ws`,
    token: server.token,
    store,
    ...opts,
    scheduleFrame: (fn) => setTimeout(fn, 0),
    createSocket: (url) => {
      const socket = new WebSocket(url, { origin }) as unknown as SocketLike;
      wrap?.(socket);
      return socket;
    },
  });
  sync.start();
  cleanups.push(() => sync.stop());
  return { sync, store };
}

/** Terminals need node-pty, which may not load everywhere. */
const ptyLoads = (await loadPty()) !== null;

let debugState: (() => unknown) | undefined;
async function until<T>(read: () => T | undefined | null | false, what: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(debugState?.())}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('SessionSync ↔ hc web --mock', () => {
  it('queues a message sent mid-run; a second tab sees it, and Stop hands it back to the first', async () => {
    const { server } = await boot();
    const a = tab(server);
    await until(() => a.store.getState().info, 'server info');
    const id = await a.sync.create();
    const view = () => a.store.getState().views[id!];
    expect(await a.sync.send(id!, 'set up a scratch file')).toBe(true);
    await until(() => view()?.askId, 'first ask');

    expect(await a.sync.send(id!, 'and then tidy up')).toBe(true);
    await until(() => view()?.queue.length === 1, 'the queued message');
    const b = tab(server);
    await b.sync.open(id!);
    await until(() => b.store.getState().views[id!]?.queue[0]?.text === 'and then tidy up', 'tab B sees the queue');

    await a.sync.abort(id!);
    await until(() => a.store.getState().restored[id!]?.text === 'and then tidy up', 'the message handed back');
    await until(() => b.store.getState().views[id!]?.queue.length === 0, 'tab B sees the queue emptied');
    await until(() => !view()?.running, 'the run stopped');
    a.sync.takeRestored(id!);
    expect(a.store.getState().restored[id!]).toBeUndefined();
  });

  it('runs a full turn with permission asks, and a second tab can answer', async () => {
    const { server, cwd } = await boot();
    const a = tab(server);
    debugState = () => {
      const s = a.store.getState();
      return { status: s.status, error: s.error };
    };
    await until(() => a.store.getState().info, 'server info');

    const id = await a.sync.create();
    expect(id).toBeTruthy();
    const view = () => a.store.getState().views[id!];
    await until(view, 'initial view');
    // Startup notices predate the snapshot; a new session replays them.
    await until(
      () => view()?.entries.some((e) => e.kind === 'notice' && e.notice.kind === 'session-start'),
      'startup notice',
    );

    expect(await a.sync.send(id!, 'set up a scratch file')).toBe(true);

    // Ask #1 (bash) — answered from tab A.
    const ask1 = await until(() => view()?.askId, 'first ask');
    expect(view()!.pendingAsk?.toolName).toBe('bash');
    await a.sync.answerAsk(id!, ask1, 'once');

    // Ask #2 (write) — a second tab opens the session and sees it pending.
    const ask2 = await until(() => {
      const v = view();
      return v?.askId && v.askId !== ask1 ? v.askId : null;
    }, 'second ask');
    const b = tab(server);
    await b.sync.open(id!);
    const bView = () => b.store.getState().views[id!];
    await until(() => bView()?.askId === ask2, 'tab B sees the pending ask');
    expect(bView()!.pendingAsk?.toolName).toBe('write');
    // The mid-run snapshot carries the turn so far (not just finished turns).
    expect(bView()!.entries[0]).toMatchObject({ kind: 'user', text: 'set up a scratch file' });
    const bTools = () => bView()!.entries.flatMap((e) => (e.kind === 'assistant' ? e.tools : []));
    expect(bTools().map((t) => t.name)).toEqual([...LOOK_AROUND, 'bash', 'write']);
    expect(bTools()[LOOK_AROUND.length]!.result?.content).toContain('hello from the hc web mock');
    await b.sync.answerAsk(id!, ask2, 'once');
    await until(() => view()?.askId !== ask2, 'tab A sees ask #2 resolved');

    // Ask #3 (edit) — back on tab A.
    const ask3 = await until(() => {
      const v = view();
      return v?.askId && v.askId !== ask2 ? v.askId : null;
    }, 'third ask');
    await a.sync.answerAsk(id!, ask3, 'once');

    await until(() => view() && !view()!.running && view()!.entries.length >= 5, 'run end');
    const final = view()!;
    expect(final.entries.find((e) => e.kind === 'user')).toMatchObject({ text: 'set up a scratch file' });
    const tools = final.entries.flatMap((e) => (e.kind === 'assistant' ? e.tools.map((t) => t.name) : []));
    expect(tools).toEqual([...LOOK_AROUND, 'bash', 'write', 'edit', 'todo']);
    expect(final.entries.at(-1)).toMatchObject({ kind: 'assistant', text: 'All set — the scratch file is ready.' });
    expect(await readFile(join(cwd, 'mock-demo.txt'), 'utf8')).toContain('edited by the mock');

    // Tab B folded the same run from its mid-run snapshot onwards.
    await until(() => bView() && !bView()!.running, 'tab B run end');
    expect(bView()!.entries.at(-1)).toMatchObject({ text: 'All set — the scratch file is ready.' });
    // The write card came from the snapshot; its result arrived as a later event.
    expect(bTools().map((t) => [t.name, t.result !== undefined])).toEqual([
      ...LOOK_AROUND.map((name) => [name, true]),
      ['bash', true],
      ['write', true],
      ['edit', true],
      ['todo', true],
    ]);

    // The sidebar list shows the session.
    await until(() => a.store.getState().sessions.some((s) => s.id === id && !s.running), 'session in list');
  });

  it("follows a project's git status while it is watched, as a run changes files", async () => {
    const { server, cwd } = await boot();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd });
    const a = tab(server);
    await until(() => a.store.getState().info, 'server info');
    const workspaceId = a.store.getState().workspaces[0]!.id;
    const release = a.sync.watchGit(workspaceId);
    const git = () => a.store.getState().git[workspaceId];
    await until(() => git()?.repo === true, 'the first status');
    expect(git()).toMatchObject({ repo: true, branch: 'main', files: [] });

    const id = await a.sync.create();
    const view = () => a.store.getState().views[id!];
    expect(await a.sync.send(id!, 'set up a scratch file')).toBe(true);
    const bash = await until(() => view()?.askId, 'the bash ask');
    await a.sync.answerAsk(id!, bash, 'once');
    const write = await until(() => (view()?.askId !== bash ? view()?.askId : null), 'the write ask');
    await a.sync.answerAsk(id!, write, 'once');

    // The write pushes git_changed; the watched status reloads with the new file.
    await until(() => {
      const g = git();
      return g?.repo === true && g.files.some((f) => f.path === 'mock-demo.txt');
    }, 'the new file listed');
    expect(a.store.getState().gitRev[workspaceId]).toBeGreaterThan(0);
    const diff = await a.sync.gitDiff(workspaceId, 'mock-demo.txt');
    expect(diff.kind === 'text' && diff.patch).toContain('+first line');
    release();
    await a.sync.abort(id!);
  });

  it('turns a draft into a session with its first message', async () => {
    const { server } = await boot();
    const a = tab(server);
    await until(() => a.store.getState().info, 'tab A connected');
    const before = a.store.getState().sessions.length;

    const id = await a.sync.startSession('set up a scratch file', { mode: 'ask' });
    expect(id).toBeTruthy();
    const view = () => a.store.getState().views[id!];
    // The snapshot predates the message: the notices and the run replay after it.
    await until(
      () => view()?.entries.some((e) => e.kind === 'notice' && e.notice.kind === 'session-start'),
      'startup notices',
    );
    await until(() => view()?.entries.some((e) => e.kind === 'user' && e.text === 'set up a scratch file'), 'message');
    await until(() => view()?.askId, 'the run reaches its first ask');
    expect(a.store.getState().sessions).toHaveLength(before + 1);
    expect(a.store.getState().sessions.find((s) => s.id === id)?.title).toBe('set up a scratch file');
    await a.sync.abort(id!);
  });

  it('changes a session effort, and refuses a level the model does not offer', async () => {
    const { server } = await boot();
    const a = tab(server);
    await until(() => a.store.getState().info, 'tab A connected');
    const id = await a.sync.create();
    const view = () => a.store.getState().views[id!];
    await until(() => view()?.effortLevels.length, 'effort levels');
    expect(view()).toMatchObject({ effort: 'medium', effortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] });

    await a.sync.setEffort(id!, 'max');
    await until(() => view()?.effort === 'max', 'effort event');
    expect(view()!.entries.some((e) => e.kind === 'notice' && e.notice.kind === 'effort-changed')).toBe(true);

    await a.sync.setEffort(id!, 'ultra');
    await until(() => a.store.getState().error, 'the refusal');
    expect(a.store.getState().error).toMatch(/not an effort level/);
    expect(view()!.effort).toBe('max');

    // A draft can ask for a level up front; one the model lacks is refused before anything is created.
    const started = await a.sync.startSession('set up a scratch file', { effort: 'low' });
    await until(() => a.store.getState().views[started!]?.effort === 'low', 'draft effort');
    await a.sync.abort(started!);
  });

  it('adds a project that every tab learns of, and starts a session in it', async () => {
    const { server } = await boot();
    const a = tab(server);
    const b = tab(server);
    await until(() => a.store.getState().workspaces.length && b.store.getState().workspaces.length, 'workspaces');
    const other = await realpath(await mkdtemp(join(tmpdir(), 'hc-web-e2e-other-')));
    cleanups.push(() => rm(other, { recursive: true, force: true }));
    await mkdir(join(other, '.git'));

    const added = await a.sync.addWorkspace(other);
    expect(added).toMatchObject({ root: other });
    await until(() => b.store.getState().workspaces.some((w) => w.id === added!.id), 'tab B hears of it');

    const id = await a.sync.startSession('set up a scratch file', { workspaceId: added!.id });
    await until(() => a.store.getState().views[id!]?.workspaceId === added!.id, 'the session is in that project');
    await until(
      () => b.store.getState().sessions.find((s) => s.id === id)?.workspaceId === added!.id,
      "tab B's row names the project",
    );
    await a.sync.abort(id!);
  });

  it('renames, archives and deletes a session, every tab in step', async () => {
    const { server } = await boot();
    const a = tab(server);
    const b = tab(server);
    await until(() => a.store.getState().info && b.store.getState().info, 'both tabs connected');
    const id = await a.sync.startSession('set up a scratch file');
    await until(() => a.store.getState().views[id!]?.askId, 'first ask');
    await a.sync.abort(id!);
    await until(() => a.store.getState().views[id!] && !a.store.getState().views[id!]!.running, 'run end');

    const rowB = () => b.store.getState().sessions.find((s) => s.id === id);
    expect(await a.sync.updateSession(id!, { title: 'Scratch file', archived: true })).toMatchObject({
      title: 'Scratch file',
      archived: true,
    });
    await until(() => rowB()?.title === 'Scratch file' && rowB()?.archived, 'tab B sees it renamed and archived');

    await a.sync.deleteSession(id!);
    await until(() => !rowB(), 'tab B drops it');
    expect(a.store.getState().error).toBeNull();
  });

  it('badges a session this tab never opened, from pushes alone', async () => {
    const { server } = await boot();
    const a = tab(server);
    const b = tab(server);
    await until(() => a.store.getState().info && b.store.getState().info, 'both tabs connected');

    const id = await a.sync.create();
    expect(await a.sync.send(id!, 'set up a scratch file')).toBe(true);
    const row = () => b.store.getState().sessions.find((s) => s.id === id);
    await until(() => row()?.pending, 'tab B sees the pending ask');
    expect(row()).toMatchObject({ live: true, title: 'set up a scratch file' });
    expect(b.store.getState().views[id!]).toBeUndefined(); // B never opened it

    await a.sync.abort(id!);
    await until(() => row() && !row()!.pending && !row()!.running, 'tab B sees the run end');
  });

  it('views a session without resuming it, and resumes it on the first message', async () => {
    const { server } = await boot();
    const a = tab(server);
    await until(() => a.store.getState().info, 'tab A connected');
    const id = await a.sync.create();
    await a.sync.send(id!, 'set up a scratch file');
    await until(() => a.store.getState().views[id!]?.askId, 'first ask');
    await a.sync.abort(id!);
    await until(() => a.store.getState().views[id!] && !a.store.getState().views[id!]!.running, 'run end');
    await a.sync.rpc.call('session.close', { id: id! });
    const row = (t: ReturnType<typeof tab>) => t.store.getState().sessions.find((s) => s.id === id);
    await until(() => row(a)?.live === false, 'host closed');

    const b = tab(server);
    await until(() => b.store.getState().info, 'tab B connected');
    await b.sync.open(id!);
    const bView = () => b.store.getState().views[id!];
    await until(() => bView()?.entries.some((e) => e.kind === 'user'), 'B shows the log');
    await new Promise((r) => setTimeout(r, 50));
    expect(row(b)?.live).toBe(false); // viewing did not resume it

    expect(await b.sync.send(id!, 'set up a scratch file')).toBe(true);
    await until(() => row(b)?.live === true, 'resumed by the message');
    await until(() => bView()?.askId, "B follows its session's run live");
    await b.sync.abort(id!);
  });

  it('lets go of a session it stopped showing, and picks it up again on return', async () => {
    const { server } = await boot();
    const a = tab(server, undefined, { releaseMs: 20 });
    await until(() => a.store.getState().info, 'tab A connected');
    const id = await a.sync.create();
    await a.sync.open(id!);
    const view = () => a.store.getState().views[id!];
    await until(view, 'view');

    a.sync.release(id!);
    await new Promise((r) => setTimeout(r, 80));

    // Another tab runs it: A's list badges it, but A's released view stays put.
    const c = tab(server);
    await until(() => c.store.getState().info, 'tab C connected');
    await c.sync.open(id!);
    expect(await c.sync.send(id!, 'set up a scratch file')).toBe(true);
    await until(() => a.store.getState().sessions.find((s) => s.id === id)?.pending, 'A badges the ask');
    expect(view()!.askId).toBeNull();

    // Coming back to it catches up with what happened meanwhile.
    await a.sync.open(id!);
    await until(() => view()?.askId, 'A shows the pending ask after returning');
    await c.sync.abort(id!);
  });

  it('retries an open that a dropped socket cut off', async () => {
    const { server } = await boot();
    const a = tab(server);
    await until(() => a.store.getState().info, 'server info');
    const id = await a.sync.create();
    expect(id).toBeTruthy();

    // Tab B's first socket dies the moment it asks for the preview.
    let dropped = false;
    const b = tab(server, (socket) => {
      const send = socket.send.bind(socket);
      socket.send = (data: string) => {
        if (!dropped && data.includes('"session.preview"')) {
          dropped = true;
          socket.close();
          return;
        }
        send(data);
      };
    });
    await until(() => b.store.getState().status === 'open', 'tab B connected');
    await b.sync.open(id!);
    expect(dropped).toBe(true);
    const bView = () => b.store.getState().views[id!];
    await until(() => bView() && !bView()!.hydrating, 'tab B view after the reconnect', 8000);
  });

  it.skipIf(!ptyLoads)('runs a terminal, and replays what it printed after the socket drops', async () => {
    const shell = process.env['SHELL'];
    process.env['SHELL'] = '/bin/sh';
    try {
      const { server } = await boot();
      let socket: SocketLike | undefined;
      const a = tab(server, (s) => (socket = s));
      await until(() => a.store.getState().info, 'server info');
      expect(a.store.getState().info!.capabilities.terminal).toBe(true);
      const workspaceId = a.store.getState().workspaces[0]!.id;
      const t = await a.sync.createTerminal(workspaceId, 80, 24);
      expect(t).toBeTruthy();
      await until(() => a.store.getState().terminals[workspaceId]?.length === 1, 'the terminal listed');

      let screen = '';
      let resets = 0;
      let exitCode: number | undefined;
      a.sync.attachTerminal(t!.id, {
        onReset: (scrollback) => {
          resets++;
          screen = scrollback;
        },
        onData: (d) => (screen += d),
        onExit: (code) => (exitCode = code),
        onGone: () => {},
      });
      await until(() => resets === 1, 'attached');
      a.sync.terminalInput(t!.id, 'echo first-$((1+1))\r');
      await until(() => screen.includes('first-2'), 'the first output');

      // The socket drops; the terminal carries on; the reconnect replays it.
      socket!.close();
      await until(() => resets === 2 && a.store.getState().status === 'open', 'attached again after the reconnect', 8000);
      expect(screen).toContain('first-2');
      a.sync.terminalInput(t!.id, 'exit 4\r');
      await until(() => exitCode === 4, 'the exit');
      await a.sync.closeTerminal(t!.id);
      await until(() => a.store.getState().terminals[workspaceId]?.length === 0, 'the terminal gone from the list');
    } finally {
      process.env['SHELL'] = shell;
    }
  });

  it('reports a bad token as unauthorized without retrying', async () => {
    const { server } = await boot();
    const store = createStore<AppState>(() => emptyState());
    const sync = new SessionSync({
      url: `ws://127.0.0.1:${server.port}/ws`,
      token: 'nope',
      store,
      createSocket: (url) => new WebSocket(url, { origin: `http://127.0.0.1:${server.port}` }) as unknown as SocketLike,
    });
    sync.start();
    cleanups.push(() => sync.stop());
    await until(() => store.getState().status === 'unauthorized', 'unauthorized status');
  });
});
