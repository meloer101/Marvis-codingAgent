import { PassThrough, Writable } from 'node:stream';
import { createInterface } from 'node:readline';

import { describe, expect, it } from 'vitest';

import { createPrompter, interactiveAskHandler } from './prompter.js';
import type { Prompter } from './prompter.js';

function harness() {
  const input = new PassThrough();
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const rl = createInterface({ input, output, terminal: false });
  const prompter = createPrompter(rl);
  return {
    prompter,
    send: (line: string) => input.write(`${line}\n`),
    out: () => chunks.join(''),
    close: () => rl.close(),
  };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('ReadlinePrompter.confirm', () => {
  it('maps "y" to allow-once', async () => {
    const h = harness();
    const p = h.prompter.confirm({ title: 'Bash requires approval', detail: 'npm test', alwaysLabel: 'Bash' });
    await tick();
    h.send('y');
    expect(await p).toEqual({ choice: 'once' });
    h.close();
  });

  it('lists the same numbered choices the menu shows, and takes a number', async () => {
    const h = harness();
    const p = h.prompter.confirm({ title: 'T', detail: 'd', alwaysLabel: 'Bash' });
    await tick();
    expect(h.out()).toContain('Do you want to proceed?');
    expect(h.out()).toContain('1. Yes');
    expect(h.out()).toContain("2. Yes, and don't ask again for Bash this session");
    expect(h.out()).toContain('3. No, and tell the agent what to do differently');
    h.send('1');
    expect(await p).toEqual({ choice: 'once' });
    h.close();
  });

  it('takes 2 as always', async () => {
    const h = harness();
    const p = h.prompter.confirm({ title: 'T', detail: 'd' });
    await tick();
    h.send('2');
    expect(await p).toEqual({ choice: 'always' });
    h.close();
  });

  it('numbers the auto-mode row 3 and the No row 4 when auto is offered', async () => {
    const h = harness();
    const p = h.prompter.confirm({ title: 'T', detail: 'd', offerAuto: true });
    await tick();
    h.send('3');
    expect(await p).toEqual({ choice: 'auto' });
    h.close();
  });

  it('treats the No number as a deny and still asks why', async () => {
    const h = harness();
    const p = h.prompter.confirm({ title: 'T', detail: 'd' });
    await tick();
    h.send('3');
    await tick();
    h.send('read-only please');
    expect(await p).toEqual({ choice: 'deny', feedback: 'read-only please' });
    h.close();
  });

  it('maps "a" to always', async () => {
    const h = harness();
    const p = h.prompter.confirm({ title: 'T', detail: 'd' });
    await tick();
    h.send('a');
    expect(await p).toEqual({ choice: 'always' });
    h.close();
  });

  it('treats "n" as deny and captures the follow-up reason', async () => {
    const h = harness();
    const p = h.prompter.confirm({ title: 'T', detail: 'd' });
    await tick();
    h.send('n');
    await tick();
    h.send('do not touch prod');
    expect(await p).toEqual({ choice: 'deny', feedback: 'do not touch prod' });
    h.close();
  });

  it('deny with an empty reason omits feedback', async () => {
    const h = harness();
    const p = h.prompter.confirm({ title: 'T', detail: 'd' });
    await tick();
    h.send('n');
    await tick();
    h.send('');
    expect(await p).toEqual({ choice: 'deny' });
    h.close();
  });

  it('settles as deny when the signal is already aborted, without reading input', async () => {
    const h = harness();
    const res = await h.prompter.confirm({
      title: 'T',
      detail: 'd',
      signal: AbortSignal.abort(),
    });
    expect(res.choice).toBe('deny');
    expect(res.feedback).toBe('用户中断');
    h.close();
  });

  it('maps "s" to auto when offered', async () => {
    const h = harness();
    const p = h.prompter.confirm({ title: 'T', detail: 'd', offerAuto: true });
    await tick();
    expect(h.out()).toContain('3. Yes, and switch to auto mode');
    h.send('s');
    expect(await p).toEqual({ choice: 'auto' });
    h.close();
  });

  it('serializes concurrent prompts — the second is not shown until the first is answered', async () => {
    const h = harness();
    const a = h.prompter.confirm({ title: 'FIRST', detail: 'a' });
    const b = h.prompter.confirm({ title: 'SECOND', detail: 'b' });
    await tick();

    expect(h.out()).toContain('FIRST');
    expect(h.out()).not.toContain('SECOND');

    h.send('y');
    expect(await a).toEqual({ choice: 'once' });
    await tick();

    expect(h.out()).toContain('SECOND');
    h.send('n');
    await tick();
    h.send('');
    await b;
    h.close();
  });
});

describe('interactiveAskHandler', () => {
  const fakePrompter = (result: Awaited<ReturnType<Prompter['confirm']>>): Prompter => ({
    confirm: async () => result,
    approve: async () => ({ approved: false }),
    askText: async () => '',
    close: () => {},
  });

  it('"once" -> allow', async () => {
    const engine = { addAllowRule: () => {} };
    const ask = interactiveAskHandler(engine, fakePrompter({ choice: 'once' }));
    expect(await ask({ toolName: 'bash', input: { command: 'ls' }, reason: 'r' })).toEqual({
      decision: 'allow',
    });
  });

  it('"always" -> allow and appends a whole-tool rule', async () => {
    const added: string[] = [];
    const engine = { addAllowRule: (r: string) => added.push(r) };
    const echoed: string[] = [];
    const ask = interactiveAskHandler(engine, fakePrompter({ choice: 'always' }), {
      echo: (l) => echoed.push(l),
    });
    expect(await ask({ toolName: 'bash', input: {}, reason: 'r' })).toEqual({ decision: 'allow' });
    expect(added).toEqual(['Bash']);
    expect(echoed[0]).toContain('allow Bash');
  });

  it('"deny" -> deny, threading the feedback into the reason for the model', async () => {
    const engine = { addAllowRule: () => {} };
    const ask = interactiveAskHandler(engine, fakePrompter({ choice: 'deny', feedback: 'use the test db' }));
    const d = await ask({ toolName: 'bash', input: {}, reason: 'r' });
    expect(d.decision).toBe('deny');
    if (d.decision === 'deny') expect(d.reason).toContain('use the test db');
  });

  it('"auto" -> allow and calls onAuto', async () => {
    const engine = { addAllowRule: () => {} };
    let switched = false;
    const ask = interactiveAskHandler(engine, fakePrompter({ choice: 'auto' }), {
      getMode: () => 'ask',
      getAutoAvailable: () => true,
      onAuto: () => {
        switched = true;
      },
    });
    expect(await ask({ toolName: 'bash', input: { command: 'ls' }, reason: 'r' })).toEqual({
      decision: 'allow',
    });
    expect(switched).toBe(true);
  });
});

describe('ReadlinePrompter.approve', () => {
  it('maps "y" to approve with auto mode when available', async () => {
    const h = harness();
    const p = h.prompter.approve({ title: 'Plan', body: 'do it', autoAvailable: true, yesMode: 'auto' });
    await tick();
    expect(h.out()).toContain('1. Yes, and use auto mode');
    expect(h.out()).toContain('2. Yes, manually approve edits');
    h.send('y');
    expect(await p).toEqual({ approved: true, mode: 'auto' });
    h.close();
  });

  it('labels y with the real destination instead of claiming auto mode', async () => {
    const h = harness();
    const p = h.prompter.approve({ title: 'Plan', body: 'do it', autoAvailable: true, yesMode: 'yolo' });
    await tick();
    expect(h.out()).toContain('yolo');
    expect(h.out()).not.toContain('use auto mode');
    h.send('y');
    expect(await p).toEqual({ approved: true, mode: 'yolo' });
    h.close();
  });

  it('takes numbers for the plan choices too', async () => {
    const h = harness();
    const p = h.prompter.approve({ title: 'Plan', body: 'do it', yesMode: 'acceptEdits' });
    await tick();
    expect(h.out()).toContain('Would you like to proceed?');
    expect(h.out()).toContain('3. No, keep planning');
    h.send('2');
    expect(await p).toEqual({ approved: true, mode: 'ask' });
    h.close();
  });

  it('maps "m" to approve with ask mode', async () => {
    const h = harness();
    const p = h.prompter.approve({ title: 'Plan', body: 'do it', autoAvailable: true, yesMode: 'auto' });
    await tick();
    h.send('m');
    expect(await p).toEqual({ approved: true, mode: 'ask' });
    h.close();
  });
});

describe('ReadlinePrompter with an arrow-key menu', () => {
  // A TTY-shaped terminal, driven with real key sequences.
  async function menuHarness() {
    const { PassThrough, Writable } = await import('node:stream');
    const { emitKeypressEvents } = await import('node:readline');
    const input = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
    Object.assign(input, {
      isTTY: true,
      isRaw: false,
      setRawMode(mode: boolean) {
        (this as { isRaw: boolean }).isRaw = mode;
        return this;
      },
    });
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    }) as unknown as NodeJS.WriteStream;
    Object.assign(output, { isTTY: true, columns: 100 });
    emitKeypressEvents(input, { escapeCodeTimeout: 10 } as never);
    // The readline the prompter would borrow is not on this terminal, so a real
    // typed-answer read would hang: every answer below must come from the menu.
    const unused = createInterface({ input: new PassThrough(), output: new Writable({ write: (_c, _e, cb) => cb() }), terminal: false });
    const prompter = createPrompter(unused, { input, output });
    const press = async (data: string) => {
      input.write(data);
      await new Promise((r) => setTimeout(r, 15));
    };
    return { prompter, press, out: () => chunks.join('').replace(/\x1b\[[0-9;?]*[A-Za-z]|\r/g, ''), close: () => unused.close() };
  }

  it('shows the menu, and Enter alone allows once', async () => {
    const h = await menuHarness();
    const p = h.prompter.confirm({ title: 'Bash requires approval', detail: 'npm test', alwaysLabel: 'Bash' });
    await tick();
    expect(h.out()).toContain('❯ 1. Yes');
    expect(h.out()).toContain("2. Yes, and don't ask again for Bash this session");
    await h.press('\r');
    expect(await p).toEqual({ choice: 'once' });
    h.close();
  });

  it('allows for the session on 2', async () => {
    const h = await menuHarness();
    const p = h.prompter.confirm({ title: 'T', detail: 'd' });
    await tick();
    await h.press('2');
    expect(await p).toEqual({ choice: 'always' });
    h.close();
  });

  it('switches to auto mode from its own row', async () => {
    const h = await menuHarness();
    const p = h.prompter.confirm({ title: 'T', detail: 'd', offerAuto: true });
    await tick();
    await h.press('3');
    expect(await p).toEqual({ choice: 'auto' });
    h.close();
  });

  it('denies with the reason typed on the last row — no follow-up question', async () => {
    const h = await menuHarness();
    const p = h.prompter.confirm({ title: 'T', detail: 'd' });
    await tick();
    await h.press('3');
    await h.press('use the test db');
    await h.press('\r');
    expect(await p).toEqual({ choice: 'deny', feedback: 'use the test db' });
    expect(h.out()).not.toContain('why (optional');
    h.close();
  });

  it('denies on Esc with no feedback', async () => {
    const h = await menuHarness();
    const p = h.prompter.confirm({ title: 'T', detail: 'd' });
    await tick();
    await h.press('\x1b');
    await new Promise((r) => setTimeout(r, 40));
    expect(await p).toEqual({ choice: 'deny' });
    h.close();
  });

  it('serializes menus — the second waits for the first', async () => {
    const h = await menuHarness();
    const a = h.prompter.confirm({ title: 'FIRST', detail: 'a' });
    const b = h.prompter.confirm({ title: 'SECOND', detail: 'b' });
    await tick();
    expect(h.out()).toContain('FIRST');
    expect(h.out()).not.toContain('SECOND');
    await h.press('\r');
    expect(await a).toEqual({ choice: 'once' });
    await tick();
    expect(h.out()).toContain('SECOND');
    await h.press('\r');
    expect(await b).toEqual({ choice: 'once' });
    h.close();
  });

  it('approves a plan by menu, landing in the mode named on the row', async () => {
    const h = await menuHarness();
    const p = h.prompter.approve({ title: 'Plan', body: 'do it', yesMode: 'acceptEdits' });
    await tick();
    expect(h.out()).toContain('❯ 1. Yes, auto-accept edits');
    expect(h.out()).toContain('2. Yes, manually approve edits');
    await h.press('\r');
    expect(await p).toEqual({ approved: true, mode: 'acceptEdits' });
    h.close();
  });

  it('sends plan feedback typed on the last row', async () => {
    const h = await menuHarness();
    const p = h.prompter.approve({ title: 'Plan', body: 'do it', yesMode: 'acceptEdits' });
    await tick();
    await h.press('3');
    await h.press('split step two');
    await h.press('\r');
    expect(await p).toEqual({ approved: false, feedback: 'split step two' });
    h.close();
  });

  it('settles as denied when the signal fires while the menu is up', async () => {
    const h = await menuHarness();
    const ac = new AbortController();
    const p = h.prompter.confirm({ title: 'T', detail: 'd', signal: ac.signal });
    await tick();
    ac.abort();
    expect(await p).toEqual({ choice: 'deny', feedback: '用户中断' });
    h.close();
  });
});
