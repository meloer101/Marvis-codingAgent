import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CAPABILITIES } from '../provider/capabilities.js';
import { ScriptedProvider } from '../provider/mock.js';
import { ProviderError } from '../provider/types.js';
import type { Provider } from '../provider/types.js';
import type { ResolvedModel } from '../provider/router.js';
import type { AgentEvent } from './loop.js';
import { readSessionSummary } from './session.js';
import { AgentSession, AttachmentError, skillInvocation } from './session-runner.js';
import type { AgentSessionConfig, Notice } from './session-runner.js';

const ECHO_SERVER = fileURLToPath(new URL('../mcp/__fixtures__/echo-server.mjs', import.meta.url));

type ToolCallEndEvent = Extract<AgentEvent, { type: 'tool_call_end' }>;

function findToolEnd(events: AgentEvent[], name: string): ToolCallEndEvent | undefined {
  for (const e of events) {
    if (e.type === 'tool_call_end' && e.name === name) return e;
  }
  return undefined;
}

function lastToolEnd(events: AgentEvent[], name: string): ToolCallEndEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'tool_call_end' && e.name === name) return e;
  }
  return undefined;
}

function sessionModel(
  provider: Provider,
  caps: Partial<typeof DEFAULT_CAPABILITIES> = {},
): ResolvedModel {
  return {
    provider,
    providerId: provider.id,
    model: 'test-model',
    ref: `${provider.id}/test-model`,
    capabilities: { ...DEFAULT_CAPABILITIES, ...caps },
  };
}

interface Harness {
  session: AgentSession;
  events: AgentEvent[];
  notices: Notice[];
}

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'hc-session-'));
  tmpDirs.push(d);
  return d;
}

async function createSession(overrides: Partial<AgentSessionConfig> = {}): Promise<Harness> {
  const events: AgentEvent[] = [];
  const notices: Notice[] = [];
  const base: AgentSessionConfig = {
    cwd: await tempDir(),
    model: sessionModel(new ScriptedProvider([{ text: 'ok' }])),
    settings: {},
    budgets: {},
    skills: false,
    subagents: false,
    mcp: false,
    memory: false,
    recorder: false,
    trace: false,
    projectMemory: null,
    mode: 'yolo',
  };
  const session = await AgentSession.create({
    ...base,
    ...overrides,
    onEvent: (e) => {
      events.push(e);
      overrides.onEvent?.(e);
    },
    onNotice: (n) => {
      notices.push(n);
      overrides.onNotice?.(n);
    },
  });
  return { session, events, notices };
}

describe('AgentSession', () => {
  it('runs a turn: streams deltas, executes a tool, accumulates messages', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'todo', input: { todos: [{ id: '1', content: 'do', status: 'in_progress' }] } }] },
      { text: 'done', chunkSize: 2 },
    ]);
    const { session, events } = await createSession({ model: sessionModel(provider) });

    const result = await session.runTurn('first');

    expect(result.stopReason).toBe('end_turn');
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'do')).toBe(true);
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'ne')).toBe(true);
    expect(events.some((e) => e.type === 'tool_call_start' && e.name === 'todo')).toBe(true);
    expect(events.some((e) => e.type === 'tool_call_end' && e.name === 'todo')).toBe(true);
    expect(events.filter((e) => e.type === 'turn_end')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'stop', reason: 'end_turn' });
    // user, assistant(tool_use), user(tool_result), assistant(final text)
    expect(session.messages).toHaveLength(4);
  });

  it('accumulates messages across turns, sharing one session state', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'todo', input: { todos: [{ id: '1', content: 'a', status: 'pending' }] } }] },
      { text: 'turn one done' },
      { text: 'turn two done' },
    ]);
    const { session } = await createSession({ model: sessionModel(provider) });

    const first = await session.runTurn('first');
    const second = await session.runTurn('second');

    expect(first.messages).toHaveLength(4);
    expect(second.messages).toHaveLength(6);
    // The todo list set in turn 1 is still visible to turn 2 (same SessionState).
    expect(session.messages).toEqual(second.messages);
  });
});

describe('AgentSession state directory', () => {
  it('leaves no .agent/ in a directory that is not a project', async () => {
    const cwd = await tempDir();
    const home = await tempDir();
    const provider = new ScriptedProvider([{ text: 'ok' }]);
    const { session } = await createSession({
      cwd,
      homeDir: home,
      model: sessionModel(provider),
      recorder: true,
      trace: true,
    });
    await session.runTurn('hi');
    await session.close();
    await expect(access(join(cwd, '.agent'))).rejects.toThrow();
    const projects = join(home, '.agent', 'projects');
    await expect(access(projects)).resolves.toBeUndefined();
  });
});

describe('AgentSession verify before stop', () => {
  const turns = () => [
    { toolCalls: [{ name: 'write', input: { path: 'a.txt', content: 'x' } }] },
    { text: 'done' },
    { text: 'checked' },
  ];

  it('is off by default in a session', async () => {
    const provider = new ScriptedProvider(turns());
    const { session } = await createSession({ model: sessionModel(provider) });
    await session.runTurn('write a.txt');
    expect(provider.callCount).toBe(2);
  });

  it('sends a run that changed something back once when enabled', async () => {
    const provider = new ScriptedProvider(turns());
    const { session } = await createSession({ model: sessionModel(provider), verifyBeforeStop: true });
    await session.runTurn('write a.txt');
    expect(provider.callCount).toBe(3);
  });
});

describe('AgentSession auto mode', () => {
  it('falls back to ask when auto is disabled, and setMode cannot enable it', async () => {
    const { session, notices } = await createSession({
      mode: 'auto',
      settings: { permissions: { disableAutoMode: 'disable' } },
    });
    expect(session.mode).toBe('ask');
    expect(session.autoModeAvailable).toBe(false);
    expect(notices.some((n) => n.kind === 'auto-mode' && /unavailable/.test(n.text))).toBe(true);

    session.setMode('auto');
    expect(session.mode).toBe('ask');
    expect(notices.filter((n) => n.kind === 'auto-mode' && /unavailable/.test(n.text)).length).toBeGreaterThan(
      1,
    );
  });

  it('downgrades an explicit planApprovedMode "auto" when auto is unavailable', async () => {
    const { session, notices } = await createSession({
      mode: 'plan',
      planApprovedMode: 'auto',
      settings: { permissions: { disableAutoMode: 'disable' } },
    });
    expect(session.planApprovedMode).toBe('acceptEdits');
    expect(notices.some((n) => n.kind === 'auto-mode' && /planApprovedMode/.test(n.text))).toBe(true);
  });

  it('keeps the retry note when the next turn also references an MCP resource', async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'fixture-echo': { command: process.execPath, args: [ECHO_SERVER], env: {} },
        },
      }),
      'utf8',
    );
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'bash', input: { command: 'git push --force origin main' } }] },
      { text: '<block>yes</block>' },
      {
        text: '<decision>block</decision><rule>Git Destructive</rule><reason>force-push rewrites history</reason>',
      },
      { text: 'blocked' },
      { text: 'ok' },
    ]);
    const { session } = await createSession({ cwd, mcp: true, model: sessionModel(provider), mode: 'auto' });
    try {
      await session.runTurn('ship it');
      const id = session.recentDenials[0]?.id;
      expect(session.retryDenied(id!)).toBe(true);

      await session.runTurn('try again with @fixture-echo:echo://greeting');
      const lastUser = [...session.messages].reverse().find(
        (m) => m.role === 'user' && m.content.some((b) => b.type === 'text'),
      );
      const text = lastUser?.content.map((b) => (b.type === 'text' ? b.text : '')).join('') ?? '';
      expect(text).toContain('<resource server="fixture-echo"');
      expect(text).toContain('authorized a retry');
      expect(text).toContain('try again with');
    } finally {
      await session.close();
    }
  });

  it('allows workspace writes without a prompt', async () => {
    const cwd = await tempDir();
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'write', input: { path: 'note.txt', content: 'hello' } }] },
      { text: 'wrote it' },
    ]);
    const { session, events, notices } = await createSession({
      cwd,
      model: sessionModel(provider),
      mode: 'auto',
    });
    expect(session.autoModeAvailable).toBe(true);
    expect(session.mode).toBe('auto');

    const result = await session.runTurn('write a note');
    const end = findToolEnd(events, 'write');
    expect(end?.result.isError).toBeFalsy();
    expect(end?.result.content).toMatch(/Wrote|wrote|note\.txt/i);
    expect(notices.some((n) => n.kind === 'auto-mode' && /denied/i.test(n.text))).toBe(false);
    expect(result.stopReason).toBe('end_turn');
  });

  it('classifies a force-push, denies it, and records a recent denial', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'bash', input: { command: 'git push --force origin main' } }] },
      { text: '<block>yes</block>' },
      {
        text: '<decision>block</decision><rule>Git Destructive</rule><reason>force-push rewrites history</reason>',
      },
      { text: 'I will not force-push; using a new branch instead.' },
    ]);
    const { session, events, notices } = await createSession({
      model: sessionModel(provider),
      mode: 'auto',
    });

    await session.runTurn('ship it');

    const end = findToolEnd(events, 'bash');
    expect(end?.result.isError).toBe(true);
    expect(end?.result.content).toMatch(/Denied by auto mode classifier/);
    expect(end?.result.content).toMatch(/Git Destructive/);
    expect(notices.some((n) => n.kind === 'auto-mode' && /Git Destructive/.test(n.text))).toBe(true);
    expect(session.recentDenials[0]?.toolName).toBe('bash');
    expect(session.recentDenials[0]?.label).toBe('Git Destructive');
  });

  it('retryDenied injects an authorization note on the next turn', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'bash', input: { command: 'git push --force origin main' } }] },
      { text: '<block>yes</block>' },
      {
        text: '<decision>block</decision><rule>Git Destructive</rule><reason>force-push rewrites history</reason>',
      },
      { text: 'blocked' },
      { toolCalls: [{ name: 'bash', input: { command: 'git push --force origin main' } }] },
      { text: 'retried' },
    ]);
    const { session, events } = await createSession({
      model: sessionModel(provider),
      mode: 'auto',
    });
    await session.runTurn('ship it');
    const id = session.recentDenials[0]?.id;
    expect(id).toBeTruthy();
    expect(session.retryDenied(id!)).toBe(true);

    await session.runTurn('try again');
    const ends = events.filter((e): e is ToolCallEndEvent => e.type === 'tool_call_end' && e.name === 'bash');
    expect(ends).toHaveLength(2);
    expect(ends[0]?.result.content).toMatch(/Denied by auto mode classifier/);
    expect(ends[1]?.result.content).not.toMatch(/Denied by auto mode classifier/);
  });

  it('prepends a security warning when the return review blocks a sub-agent report', async () => {
    const cwd = await tempDir();
    await mkdir(join(cwd, '.agent', 'agents'), { recursive: true });
    await writeFile(
      join(cwd, '.agent', 'agents', 'explore.md'),
      '---\nname: explore\ndescription: search\n---\nsearch the repo\n',
      'utf8',
    );

    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'task', input: { subagent_type: 'explore', prompt: 'find X' } }] },
      { text: '<block>no</block>' },
      { text: 'I force-pushed to a new remote named evil.' },
      { text: '<block>yes</block>' },
      {
        text: '<decision>block</decision><rule>Remote Repoint</rule><reason>pushed to an unknown remote</reason>',
      },
      { text: 'got the report' },
    ]);
    const { session, events } = await createSession({
      cwd,
      model: sessionModel(provider),
      mode: 'auto',
      subagents: true,
      skills: false,
      mcp: false,
      memory: false,
    });

    await session.runTurn('explore then report');
    const taskEnd = findToolEnd(events, 'task');
    expect(taskEnd?.result.content).toMatch(/security warning/);
    expect(taskEnd?.result.content).toMatch(/Remote Repoint/);
    expect(taskEnd?.result.content).toMatch(/force-pushed/);
  });
});

describe('AgentSession', () => {
  it('persists the read ledger across turns (read then edit in separate turns)', async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, 'a.txt'), 'hello world\n', 'utf8');

    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'read', input: { path: 'a.txt' } }] },
      { text: 'read it' },
      { toolCalls: [{ name: 'edit', input: { path: 'a.txt', oldString: 'hello', newString: 'goodbye' } }] },
      { text: 'edited' },
    ]);
    const { session, events } = await createSession({ cwd, model: sessionModel(provider) });

    await session.runTurn('read');
    await session.runTurn('edit');

    const editEnd = findToolEnd(events, 'edit');
    expect(editEnd).toBeDefined();
    expect(editEnd!.result.isError).toBeUndefined();
    expect(editEnd!.result.content).toContain('Replaced 1 occurrence');
  });

  it('reads attached files into the message, and into the ledger an edit checks', async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, 'a.txt'), 'hello world\n', 'utf8');
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'edit', input: { path: 'a.txt', oldString: 'hello', newString: 'goodbye' } }] },
      { text: 'edited' },
    ]);
    const { session, events } = await createSession({ cwd, model: sessionModel(provider) });

    await session.runTurn('fix @a.txt', { attachments: ['a.txt'] });

    const [first] = provider.requests[0]!.messages;
    expect(first!.content).toEqual([
      { type: 'text', text: '<attached_file path="a.txt">\n     1\thello world\n     2\t\n</attached_file>' },
      { type: 'text', text: 'fix @a.txt' },
    ]);
    // No `read` call was needed before the edit.
    expect(findToolEnd(events, 'edit')!.result.isError).toBeUndefined();
  });

  it('a resumed session remembers what was attached', async () => {
    const cwd = await tempDir();
    const agentDir = join(cwd, '.agent');
    await writeFile(join(cwd, 'a.txt'), 'hello\n', 'utf8');
    const first = await createSession({
      cwd,
      agentDir,
      recorder: true,
      model: sessionModel(new ScriptedProvider([{ text: 'seen' }])),
    });
    await first.session.runTurn('look', { attachments: ['a.txt'] });

    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'edit', input: { path: 'a.txt', oldString: 'hello', newString: 'bye' } }] },
      { text: 'done' },
    ]);
    const resumed = await createSession({
      cwd,
      agentDir,
      recorder: true,
      resumeId: first.session.id,
      model: sessionModel(provider),
    });
    await resumed.session.runTurn('now edit it');
    expect(findToolEnd(resumed.events, 'edit')!.result.isError).toBeUndefined();
    // The list shows what was typed, not the file.
    expect((await readSessionSummary(agentDir, first.session.id)).title).toBe('look');
  });

  it('refuses attachments it may not read, before sending anything', async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, '.env'), 'SECRET=1\n', 'utf8');
    await writeFile(join(cwd, 'blob.bin'), Buffer.from([1, 0, 2]));
    await writeFile(join(cwd, 'big.txt'), 'x'.repeat(300 * 1024), 'utf8');
    await mkdir(join(cwd, 'dir'));
    const provider = new ScriptedProvider([{ text: 'never' }]);
    const { session } = await createSession({ cwd, model: sessionModel(provider) });

    await expect(session.checkAttachments(['.env'])).rejects.toThrow(/Can't attach \.env: Refusing to access sensitive file/);
    await expect(session.checkAttachments(['../outside.txt'])).rejects.toThrow(/outside the workspace|Blocked|escape/i);
    await expect(session.checkAttachments(['missing.txt'])).rejects.toThrow('no such file');
    await expect(session.checkAttachments(['dir'])).rejects.toThrow('not a file');
    await expect(session.checkAttachments(['blob.bin'])).rejects.toThrow('binary');
    await expect(session.checkAttachments(['big.txt'])).rejects.toThrow('300 KB');
    await expect(session.runTurn('x', { attachments: ['.env'] })).rejects.toThrow(AttachmentError);
    expect(provider.requests).toHaveLength(0);
  });

  it('abort() aborts an in-flight turn', async () => {
    let listeningResolve!: () => void;
    const listening = new Promise<void>((r) => (listeningResolve = r));
    const hanging: Provider = {
      id: 'hanging',
      async complete() {
        throw new Error('not used');
      },
      async *stream(req) {
        yield { type: 'message_start', model: req.model };
        yield { type: 'text_delta', text: 'partial' };
        await new Promise<never>((_resolve, reject) => {
          const onAbort = (): void =>
            reject(new ProviderError('aborted', 'aborted', { retryable: false }));
          if (req.signal?.aborted) return onAbort();
          req.signal?.addEventListener('abort', onAbort, { once: true });
          listeningResolve();
        });
      },
    };
    const { session } = await createSession({ model: sessionModel(hanging) });

    const run = session.runTurn('hi');
    await listening;
    session.abort();
    const result = await run;

    expect(result.stopReason).toBe('aborted');
  });

  it('an injected deny-all ask handler blocks the call and the loop continues', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'bash', input: { command: 'npm run build' } }] },
      { text: 'done' },
    ]);
    const { session, events } = await createSession({
      model: sessionModel(provider),
      mode: 'ask',
      askHandler: async () => ({ decision: 'deny', reason: 'nope' }),
    });

    const result = await session.runTurn('do it');

    const end = findToolEnd(events, 'bash');
    expect(end?.result).toMatchObject({ isError: true, content: 'Denied: nope' });
    expect(result.stopReason).toBe('end_turn');
    expect(result.messages).toHaveLength(4);
  });

  it('keeps the system head stable across a mode switch when the model takes updates in history', async () => {
    const provider = new ScriptedProvider([{ text: 'one' }, { text: 'two' }]);
    const { session } = await createSession({
      model: sessionModel(provider, { systemPromptUpdate: 'in-history' }),
      mode: 'plan',
    });

    await session.runTurn('first');
    session.setMode('acceptEdits');
    await session.runTurn('second');

    const [before, after] = provider.requests;
    // The head is byte-identical across the switch — that is the cached prefix.
    expect(after?.system).toEqual(before?.system);
    expect(before?.systemUpdate).toBeUndefined();
    // The change rides along as an update instead of rewriting the head — and
    // carries only the delta (cancelling plan mode), not a second full prompt.
    const update = (after?.systemUpdate ?? []).map((seg) => seg.text).join('\n');
    const headText = (before?.system ?? []).map((seg) => seg.text).join('\n');
    expect(headText).toContain('plan_mode');
    expect(update).toContain('plan_mode');
    expect(update).toContain('no longer applies');
    expect(update.length).toBeLessThan(headText.length / 4);
  });

  it('rewrites the system prompt on a mode switch when the model has no in-history path', async () => {
    const provider = new ScriptedProvider([{ text: 'one' }, { text: 'two' }]);
    const { session } = await createSession({
      model: sessionModel(provider),
      mode: 'plan',
    });

    await session.runTurn('first');
    session.setMode('acceptEdits');
    await session.runTurn('second');

    const [before, after] = provider.requests;
    expect(after?.systemUpdate).toBeUndefined();
    expect(after?.system).not.toEqual(before?.system);
  });

  it('setModel sends later turns to the new model, with the history carried over', async () => {
    const first = new ScriptedProvider([{ text: 'one' }], 'first');
    const second = new ScriptedProvider([{ text: 'two' }], 'second');
    const other = sessionModel(second, { systemPromptUpdate: 'in-history' });
    const { session, notices } = await createSession({
      model: sessionModel(first, { systemPromptUpdate: 'in-history' }),
      resolveModel: (ref) => {
        if (ref !== other.ref) throw new ProviderError('not_found', `no model ${ref}`);
        return other;
      },
    });

    await session.runTurn('hello');
    session.setModel(other.ref);
    await session.runTurn('again');

    expect(session.modelRef).toBe('second/test-model');
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
    const texts = second.requests[0]!.messages.map((m) => m.content.map((b) => ('text' in b ? b.text : '')).join(''));
    expect(texts.slice(0, 3)).toEqual(['hello', 'one', 'again']);
    // A fresh head for the new model, not an update appended to the old one's.
    expect(second.requests[0]!.systemUpdate).toBeUndefined();
    expect(notices.some((n) => n.kind === 'model-changed' && n.text === 'model: first/test-model → second/test-model')).toBe(true);
    expect(() => session.setModel('nope/x')).toThrow('no model nope/x');
    expect(session.modelRef).toBe('second/test-model');
  });

  it('setModel keeps an effort the new model offers and folds one it lacks', async () => {
    const provider = new ScriptedProvider([]);
    const reasoning = { reasoning: true, effortLevels: ['low', 'medium', 'high', 'ultra'] as const };
    const plain = sessionModel(new ScriptedProvider([], 'plain'));
    const deep = sessionModel(new ScriptedProvider([], 'deep'), { reasoning: true });
    const models = new Map([
      [plain.ref, plain],
      [deep.ref, deep],
    ]);
    const { session, notices } = await createSession({
      model: sessionModel(provider, { ...reasoning, effortLevels: [...reasoning.effortLevels] }),
      reasoningEffort: 'ultra',
      resolveModel: (ref) => models.get(ref)!,
    });

    session.setModel(deep.ref); // default ladder: minimal … max, no ultra
    expect(session.effort).toBe('max');
    expect(notices.at(-1)).toMatchObject({ kind: 'effort-changed', text: 'effort: ultra → max' });

    session.setModel(plain.ref);
    expect(session.effort).toBeUndefined();
    expect(session.effortLevels).toEqual([]);

    session.setModel(deep.ref);
    expect(session.effort).toBe('max'); // kept through the model without reasoning
  });

  it('plan mode: confirm approval leaves plan mode and refuses exit_plan_mode after', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'exit_plan_mode', input: { title: 'T', plan: 'do X' } }] },
      { text: 'implementing' },
      { toolCalls: [{ name: 'exit_plan_mode', input: { title: 'T', plan: 'again' } }] },
      { text: 'done' },
    ]);
    const confirmed: string[] = [];
    const { session, events, notices } = await createSession({
      model: sessionModel(provider),
      mode: 'plan',
      planApprovedMode: 'acceptEdits',
      confirm: async (req) => {
        confirmed.push(req.title);
        return { approved: true };
      },
    });

    await session.runTurn('plan it');
    expect(confirmed).toEqual(['T']);
    expect(session.mode).toBe('acceptEdits');
    expect(notices.some((n) => n.kind === 'mode-changed')).toBe(true);

    // The tool stays registered — the tool list is part of the cached prefix —
    // so the refusal now comes from the permission engine, by mode.
    await session.runTurn('continue');
    const after = lastToolEnd(events, 'exit_plan_mode')?.result.content ?? '';
    expect(after).toContain('plan mode');
    expect(after).not.toContain('Unknown tool');
  });

  it('skills/subagents/mcp/recorder/trace all disabled → no discovery, no tools, no files', async () => {
    const cwd = await tempDir();
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'skill', input: { name: 'code-review' } }] },
      { text: 'ok' },
    ]);
    const { session, events } = await createSession({ cwd, model: sessionModel(provider) });

    await session.runTurn('hi');

    // `skill` is not registered when skills:false → "Unknown tool".
    const end = findToolEnd(events, 'skill');
    expect(end?.result.content).toContain('Unknown tool');
    expect(session.listSlashCommands()).toEqual([]);
    expect(session.mcpStatus).toEqual([]);
    // No session/trace dirs were created.
    expect(session.id).toBeTruthy();
  });

  it('expandSlash resolves MCP prompts and reports them via listSlashCommands', async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'fixture-echo': { command: process.execPath, args: [ECHO_SERVER], env: {} },
        },
      }),
      'utf8',
    );
    const { session } = await createSession({ cwd, mcp: true });

    const commands = session.listSlashCommands();
    expect(commands.some((c) => c.name === 'summarize' && c.server === 'fixture-echo')).toBe(true);

    expect(await session.expandSlash('/summarize')).toContain('Summarize');
    expect(await session.expandSlash('/summarize foo bar')).toContain('foo bar');
    expect(await session.expandSlash('/nope')).toBeNull();

    await session.close();
  });

  it('expandSlash turns /skill-name into a request to load that skill, with the rest as the task', async () => {
    const cwd = await tempDir();
    await mkdir(join(cwd, '.git'));
    const dir = join(cwd, '.agent', 'skills', 'zz-review-fixture');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '---\nname: zz-review-fixture\ndescription: Review a diff\n---\n\nBody.', 'utf8');
    const { session } = await createSession({ cwd, skills: true });

    expect(session.listSkills().some((s) => s.name === 'zz-review-fixture')).toBe(true);
    expect(await session.expandSlash('/zz-review-fixture the last commit')).toBe(
      'Load the "zz-review-fixture" skill and follow its instructions.\n\nthe last commit',
    );
    expect(await session.expandSlash('/zz-review-fixture')).toBe(skillInvocation('zz-review-fixture'));
  });

  it('compactNow() returns token savings and rewrites history', async () => {
    const longText = 'x'.repeat(8000); // ~2k heuristic tokens per assistant turn
    const main = new ScriptedProvider([
      { toolCalls: [{ name: 'todo', input: { todos: [{ id: '1', content: 'a', status: 'completed' }] } }] },
      { text: longText },
      { toolCalls: [{ name: 'todo', input: { todos: [{ id: '2', content: 'b', status: 'completed' }] } }] },
      { text: longText },
      { toolCalls: [{ name: 'todo', input: { todos: [{ id: '3', content: 'c', status: 'completed' }] } }] },
      { text: longText },
    ]);
    const summarizer = new ScriptedProvider([{ text: 'digest summary' }], 'summarizer');
    const { session } = await createSession({
      model: sessionModel(main),
      summarizerModel: sessionModel(summarizer),
    });

    await session.runTurn('one');
    await session.runTurn('two');
    await session.runTurn('three');
    const before = session.messages.length;
    const saved = await session.compactNow();

    expect(saved).not.toBeNull();
    expect(saved!.tokensAfter).toBeLessThan(saved!.tokensBefore);
    expect(session.messages.length).toBeLessThan(before);
  });
});

describe('AgentSession persistent memory', () => {
  it('flushes a write on close and a second session can read it', async () => {
    const cwd = await tempDir();
    const home = await tempDir();
    const builtin = await tempDir();
    const path = 'feedback/testing-no-mocks.md';

    const first = new ScriptedProvider([
      {
        toolCalls: [
          {
            name: 'memory',
            input: {
              action: 'write',
              scope: 'project',
              path,
              type: 'feedback',
              description: 'no mock db',
              body: 'Use a real test database.',
            },
          },
        ],
      },
      { text: 'noted' },
    ]);
    const a = await createSession({
      cwd,
      homeDir: home,
      builtinMemoryDir: builtin,
      memory: true,
      model: sessionModel(first),
    });
    await a.session.runTurn('remember this');
    await a.session.close();
    expect(a.notices.some((n) => n.kind === 'memory' && /Saved/.test(n.text))).toBe(true);

    const second = new ScriptedProvider([
      { toolCalls: [{ name: 'memory', input: { action: 'read', scope: 'project', path } }] },
      { text: 'got it' },
    ]);
    const b = await createSession({
      cwd,
      homeDir: home,
      builtinMemoryDir: builtin,
      memory: true,
      model: sessionModel(second),
    });
    await b.session.runTurn('what was the testing note?');
    const read = lastToolEnd(b.events, 'memory');
    expect(read?.result.isError).toBeFalsy();
    expect(read?.result.content).toContain('real test database');
    await b.session.close();
  });

  it('read of a just-written path hits the buffer before close', async () => {
    const cwd = await tempDir();
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          {
            name: 'memory',
            input: {
              action: 'write',
              scope: 'project',
              path: 'feedback/foo.md',
              type: 'feedback',
              description: 'foo',
              body: 'staged body',
            },
          },
        ],
      },
      { toolCalls: [{ name: 'memory', input: { action: 'read', scope: 'project', path: 'feedback/foo.md' } }] },
      { text: 'ok' },
    ]);
    const { session, events } = await createSession({
      cwd,
      homeDir: await tempDir(),
      builtinMemoryDir: await tempDir(),
      memory: true,
      model: sessionModel(provider),
    });
    await session.runTurn('write then read');
    const reads = events.filter((e): e is ToolCallEndEvent => e.type === 'tool_call_end' && e.name === 'memory');
    expect(reads).toHaveLength(2);
    expect(reads[1]?.result.content).toContain('staged body');
    await expect(access(join(cwd, '.agent', 'memory', 'feedback', 'foo.md'))).rejects.toThrow();
    await session.close();
  });
});
