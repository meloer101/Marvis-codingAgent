/**
 * End-to-end through the real `App`: a scripted model asks to write a file in
 * `ask` mode, and the person answers the permission menu with the keyboard.
 * Covers the wiring the component tests can't — the flush tick mounting the
 * menu, the central key handler standing down, and the answer reaching the tool.
 */

import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';

import { AgentSession, DEFAULT_CAPABILITIES, ScriptedProvider } from '@harness-code/core';
import type { ResolvedModel } from '@harness-code/core';
import { EventBuffer } from '@harness-code/protocol';

import { App } from './app.js';
import { UiStore } from './state/bridges.js';

const DOWN = '\u001B[B';
const ENTER = '\r';
const ESC = '\u001B';

const tmpDirs: string[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** A TUI whose model asks to write `note.txt`, then wraps up. */
async function mountWriting() {
  const cwd = await mkdtemp(join(tmpdir(), 'hc-tui-'));
  tmpDirs.push(cwd);
  const provider = new ScriptedProvider([
    { toolCalls: [{ name: 'write', input: { path: 'note.txt', content: 'hello' } }] },
    { text: 'all done' },
  ]);
  const model: ResolvedModel = {
    provider,
    providerId: provider.id,
    model: 'test-model',
    ref: `${provider.id}/test-model`,
    capabilities: { ...DEFAULT_CAPABILITIES },
  };
  const buffer = new EventBuffer();
  const store = new UiStore(() => {});
  const session = await AgentSession.create({
    cwd,
    model,
    settings: {},
    budgets: {},
    skills: false,
    subagents: false,
    mcp: false,
    memory: false,
    recorder: false,
    trace: false,
    projectMemory: null,
    mode: 'ask',
    askHandler: store.ask,
    confirm: store.confirm,
    onEvent: (e) => buffer.onEvent(e),
    onNotice: (n) => store.pushNotice(n),
  });
  const sessionRef = { current: session as AgentSession | undefined };
  const app = render(
    <App
      initialSession={session}
      createSession={() => Promise.resolve(session)}
      sessionRef={sessionRef}
      buffer={buffer}
      store={store}
      modelRef={model.ref}
      cwd={cwd}
      onExit={() => {}}
    />,
  );
  const frame = (): string => app.lastFrame() ?? '';
  // A key written before an Ink `useInput` has mounted is dropped, and the first
  // frame shows up a beat before its handler does — so give each new screen a
  // moment before typing at it.
  const beat = (): Promise<void> => sleep(150);
  const type = async (data: string): Promise<void> => {
    app.stdin.write(data);
    await sleep(40);
  };
  await until(() => frame().includes('message the agent'), 'the input box');
  await beat();
  // Submit a message, then wait for the permission menu to be on screen.
  await type('write a note');
  await type(ENTER);
  await until(() => frame().includes('Do you want to proceed?'), 'the permission menu');
  await beat();
  return { frame, type, session, file: join(cwd, 'note.txt'), provider };
}

describe('App permission prompt', () => {
  it('shows a Claude Code style menu and allows on a bare Enter', async () => {
    const { frame, type, file, provider } = await mountWriting();
    expect(frame()).toContain('Write file');
    expect(frame()).toContain('note.txt');
    expect(frame()).toContain('❯ 1. Yes');
    expect(await exists(file)).toBe(false);

    await type(ENTER);
    await until(() => exists(file), 'the write to happen');
    expect(await readFile(file, 'utf8')).toBe('hello');
    await until(() => !frame().includes('Do you want to proceed?'), 'the menu to close');
    await until(() => provider.callCount === 2, 'the model to be called again');
  });

  it('denies on Esc — and does not abort the turn out from under the prompt', async () => {
    const { frame, type, file, provider } = await mountWriting();
    await type(ESC);
    await until(() => !frame().includes('Do you want to proceed?'), 'the menu to close');
    // The turn carries on (the model is told it was declined) rather than aborting.
    await until(() => provider.callCount === 2, 'the model to hear about the denial');
    expect(await exists(file)).toBe(false);
    const followUp = provider.requests[1]!;
    expect(JSON.stringify(followUp.messages)).toContain('User declined');
  });

  it('denies with the explanation typed on the last row', async () => {
    const { frame, type, file, provider } = await mountWriting();
    await type(DOWN);
    await type(DOWN);
    await type('write it to docs/ instead');
    await until(() => frame().includes('write it to docs/ instead'), 'the feedback to show');
    await type(ENTER);
    await until(() => provider.callCount === 2, 'the model to hear about the denial');
    expect(await exists(file)).toBe(false);
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain(
      'User declined: write it to docs/ instead',
    );
  });

  it('allows for the rest of the session on 2 without asking again', async () => {
    const { frame, type, file } = await mountWriting();
    await type('2');
    await until(() => exists(file), 'the write to happen');
    await until(() => !frame().includes('Do you want to proceed?'), 'the menu to close');
  });
});
