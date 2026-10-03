import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionState } from '../agent/session.js';
import { BackgroundProcesses, MAX_BACKGROUND_PROCESSES, createBackgroundTools } from './background.js';
import type { BackgroundProcessEvent } from './background.js';
import { bashTool, createBashTool } from './bash.js';
import { toolDefinition } from './types.js';
import type { AnyToolSpec, ToolContext } from './types.js';

let cwd: string;
let ctx: ToolContext;
let bg: BackgroundProcesses;
let events: BackgroundProcessEvent[];

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'hc-bg-')));
  ctx = { cwd, session: new SessionState() };
  events = [];
  bg = new BackgroundProcesses({ root: cwd, onEvent: (e) => events.push(e) });
});

afterEach(async () => {
  await bg.killAll();
  await rm(cwd, { recursive: true, force: true });
});

/** Resolves once `test` holds, polling the events. */
async function until(test: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const printed = (id: string) =>
  events
    .filter((e): e is Extract<BackgroundProcessEvent, { type: 'process_output' }> => e.type === 'process_output' && e.id === id)
    .map((e) => e.text)
    .join('');

describe('BackgroundProcesses', () => {
  it('runs a command past the call, reading what is new each time, and stops it with what it started', async () => {
    const started = bg.start('echo ready; sleep 30 & wait', cwd, '');
    expect(started).toMatchObject({ id: 'bg1', status: 'running', cwd: '' });
    expect(events[0]).toEqual({ type: 'process_start', process: started });
    await until(() => printed('bg1').includes('ready'));

    expect(bg.read('bg1')).toMatchObject({ output: 'ready\n', dropped: 0, process: { status: 'running' } });
    expect(bg.read('bg1')?.output).toBe('');
    expect(bg.output('bg1')?.text).toBe('ready\n');

    const killed = await bg.kill('bg1');
    expect(killed).toMatchObject({ status: 'killed' });
    expect(killed?.exitCode).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'process_end', process: { id: 'bg1', status: 'killed' } });
    expect(bg.running).toBe(0);
  });

  it('records how one that ends on its own ended', async () => {
    bg.start('echo bye; exit 3', cwd, '');
    await until(() => events.some((e) => e.type === 'process_end'));
    expect(bg.list()[0]).toMatchObject({ status: 'exited', exitCode: 3 });
    expect(bg.read('bg1')?.output).toBe('bye\n');
  });

  it('refuses more than it can run at once', async () => {
    for (let i = 0; i < MAX_BACKGROUND_PROCESSES; i++) bg.start('sleep 30', cwd, '');
    expect(() => bg.start('sleep 30', cwd, '')).toThrow(/stop one with bash_kill/);
  });
});

describe('the background tools', () => {
  const names = (spec: AnyToolSpec) => Object.keys((toolDefinition(spec).inputSchema as { properties: object }).properties);

  it("leave bash as it was unless they're on", () => {
    expect(names(bashTool as AnyToolSpec)).toEqual(['command', 'timeoutMs', 'cwd']);
    expect(names(createBashTool(bg) as AnyToolSpec)).toEqual(['command', 'timeoutMs', 'cwd', 'run_in_background']);
    expect(toolDefinition(createBashTool(bg) as AnyToolSpec).description).toBe(toolDefinition(bashTool as AnyToolSpec).description);
  });

  it('start a command in the background, read it and stop it', async () => {
    await mkdir(join(cwd, 'web'));
    const bash = createBashTool(bg);
    const [output, kill] = createBackgroundTools(bg) as [AnyToolSpec, AnyToolSpec];
    const started = await bash.execute({ command: 'echo up; sleep 30', cwd: 'web', run_in_background: true }, ctx);
    expect(started.content).toMatch(/^Started in the background as bg1 \(pid \d+\)/);
    expect(bg.list()[0]?.cwd).toBe('web');
    await until(() => printed('bg1').includes('up'));

    expect((await output.execute({ id: 'bg1' }, ctx)).content).toBe('bg1 is running.\nup\n');
    expect((await output.execute({ id: 'bg1' }, ctx)).content).toBe('bg1 is running.\n(no new output)');
    expect((await kill.execute({ id: 'bg1' }, ctx)).content).toBe('bg1 was stopped.');
    expect((await kill.execute({ id: 'bg1' }, ctx)).content).toBe('bg1 was stopped already.');
    const missing = await output.execute({ id: 'bg9' }, ctx);
    expect(missing).toMatchObject({ isError: true, content: 'No background command bg9 (there are bg1).' });
  });

  it('run a foreground command as before', async () => {
    const result = await createBashTool(bg).execute({ command: 'echo hi', run_in_background: false }, ctx);
    expect(result.content.trim()).toBe('hi');
    expect(bg.list()).toEqual([]);
  });
});
