import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { userText } from '../provider/types.js';
import { toOpenAIMessages } from '../provider/openai-compat.js';
import { DEFAULT_CAPABILITIES } from '../provider/capabilities.js';
import {
  SessionRecorder,
  SessionState,
  findSessionDir,
  forkSession,
  listSessionIds,
  loadSession,
  loadTranscript,
  normalizeHistory,
  readSessionMeta,
  readSessionSummary,
  rebuildSessionState,
  sessionArtifactsDir,
  sessionMetaPath,
  updateSessionMeta,
} from './session.js';

describe('sessionArtifactsDir', () => {
  it('is a sibling directory of the jsonl, named by session id', () => {
    expect(sessionArtifactsDir('/proj/.agent', 'abc')).toBe(join('/proj/.agent', 'sessions', 'abc'));
  });
});

describe('SessionState', () => {
  it('tracks which files have been read', () => {
    const session = new SessionState();
    expect(session.hasRead('/a.txt')).toBe(false);
    session.markRead('/a.txt', 123);
    expect(session.hasRead('/a.txt')).toBe(true);
  });

  it('exposes the recorded mtime, or undefined when never read', () => {
    const session = new SessionState();
    expect(session.readMtime('/a.txt')).toBeUndefined();
    session.markRead('/a.txt', 456);
    expect(session.readMtime('/a.txt')).toBe(456);
    session.markRead('/a.txt', 789);
    expect(session.readMtime('/a.txt')).toBe(789);
  });

  it('stores the todo list', () => {
    const session = new SessionState();
    expect(session.getTodos()).toEqual([]);
    session.setTodos([{ id: '1', content: 'x', status: 'pending' }]);
    expect(session.getTodos()).toHaveLength(1);
  });
});

describe('SessionRecorder / loadSession', () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await realpath(await mkdtemp(join(tmpdir(), 'hc-session-')));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it('replays recorded messages in order', async () => {
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordMessage(userText('hello'));
    await recorder.recordToolCall({
      id: 'call_1',
      name: 'read',
      input: { path: 'a.txt' },
      result: { content: '1\tfoo' },
    });
    await recorder.recordMessage({ role: 'assistant', content: [{ type: 'text', text: 'done' }] });

    const messages = await loadSession(agentDir, 'test-session');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(userText('hello'));
    expect(messages[1]?.role).toBe('assistant');
  });

  it('keeps thinking blocks across a resume', async () => {
    // A resumed DeepSeek session has to replay each assistant turn's reasoning
    // back to the endpoint, so the history on disk must still carry it.
    const recorder = new SessionRecorder(agentDir, 'thinking-session');
    await recorder.recordMessage(userText('hi'));
    await recorder.recordMessage({
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'weighing options' },
        { type: 'text', text: 'done' },
      ],
    });

    const messages = await loadSession(agentDir, 'thinking-session');
    expect(messages[1]?.content[0]).toEqual({ type: 'thinking', text: 'weighing options' });
  });

  it('resumes from the last compaction snapshot plus messages recorded after it', async () => {
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordMessage(userText('original goal'));
    await recorder.recordMessage({ role: 'assistant', content: [{ type: 'text', text: 'old turn 1' }] });
    await recorder.recordMessage(userText('old turn 2'));

    const snapshot = [userText('original goal\n---\ndigest'), { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'kept turn' }] }];
    await recorder.recordCompaction(snapshot, { tokensBefore: 5000, tokensAfter: 900, keptTurns: 1 });

    await recorder.recordMessage(userText('post-compaction message'));

    const messages = await loadSession(agentDir, 'test-session');
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual(snapshot[0]);
    expect(messages[1]).toEqual(snapshot[1]);
    expect(messages[2]).toEqual(userText('post-compaction message'));
  });

  it('fills aborted tool_results when resume history has tool_use without results', async () => {
    const recorder = new SessionRecorder(agentDir, 'killed-mid-tool');
    await recorder.recordMessage(userText('edit the file'));
    await recorder.recordMessage({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_edit',
          name: 'edit',
          input: { path: 'a.txt', oldString: 'x', newString: 'y' },
        },
      ],
    });
    // Process killed before tool_result was recorded.

    const messages = await loadSession(agentDir, 'killed-mid-tool');
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'call_edit',
          content: 'aborted',
          isError: true,
        },
      ],
    });

    const wire = toOpenAIMessages(undefined, messages, DEFAULT_CAPABILITIES);
    const assistantIdx = wire.findIndex((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(wire[assistantIdx + 1]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_edit',
      content: 'aborted',
    });
  });
});

describe('loadTranscript', () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await realpath(await mkdtemp(join(tmpdir(), 'hc-session-')));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it('replays every message event as a "message" item, in order', async () => {
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordMessage(userText('hello'));
    await recorder.recordMessage({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] });

    const transcript = await loadTranscript(agentDir, 'test-session');
    expect(transcript).toHaveLength(2);
    expect(transcript[0]).toMatchObject({ type: 'message', message: userText('hello') });
    expect(transcript[1]).toMatchObject({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    });
    expect(transcript[0]?.ts).toBeTypeOf('number');
  });

  it('ignores tool_call events — they are already embedded in message content', async () => {
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordMessage(userText('read a file'));
    await recorder.recordToolCall({
      id: 'call_1',
      name: 'read',
      input: { path: 'a.txt' },
      result: { content: '1\tfoo' },
    });

    const transcript = await loadTranscript(agentDir, 'test-session');
    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.type).toBe('message');
  });

  it("surfaces what a tool call's result carried for display", async () => {
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordToolCall({
      id: 'call_1',
      name: 'edit',
      input: {},
      result: { content: 'Replaced 1 occurrence(s) in a.ts', display: { startLine: 12 } },
    });
    const transcript = await loadTranscript(agentDir, 'test-session');
    expect(transcript).toMatchObject([{ type: 'tool_display', toolUseId: 'call_1', display: { startLine: 12 } }]);
  });

  it('turns a compaction event into a divider marker between the messages before and after it', async () => {
    // Unlike `loadSession` (which replays the post-compaction snapshot as the
    // model history), the transcript shows every message that was actually
    // said, exactly once, with a marker where compaction happened — the
    // snapshot's own messages are not replayed a second time.
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordMessage(userText('original goal'));
    await recorder.recordMessage({ role: 'assistant', content: [{ type: 'text', text: 'old turn' }] });
    await recorder.recordCompaction([userText('original goal\n---\ndigest')], {
      tokensBefore: 4200,
      tokensAfter: 800,
      keptTurns: 2,
    });
    await recorder.recordMessage(userText('post-compaction message'));

    const transcript = await loadTranscript(agentDir, 'test-session');
    expect(transcript.map((t) => t.type)).toEqual(['message', 'message', 'compaction', 'message']);
    expect(transcript[0]).toMatchObject({ type: 'message', message: userText('original goal') });
    expect(transcript[1]).toMatchObject({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'old turn' }] },
    });
    expect(transcript[2]).toMatchObject({ type: 'compaction', tokensBefore: 4200, tokensAfter: 800 });
    expect(transcript[3]).toMatchObject({ type: 'message', message: userText('post-compaction message') });
  });
});

describe('readSessionSummary', () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await realpath(await mkdtemp(join(tmpdir(), 'hc-session-')));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it('takes the title from the first user message', async () => {
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordMessage(userText('fix the flaky login test'));
    await recorder.recordMessage({ role: 'assistant', content: [{ type: 'text', text: 'sure' }] });

    const summary = await readSessionSummary(agentDir, 'test-session');
    expect(summary.id).toBe('test-session');
    expect(summary.title).toBe('fix the flaky login test');
    expect(summary.mtimeMs).toBeTypeOf('number');
  });

  it('collapses whitespace and truncates a long first message', async () => {
    const recorder = new SessionRecorder(agentDir, 'test-session');
    const longText = `line one\n\nline two   with   spaces ${'x'.repeat(100)}`;
    await recorder.recordMessage(userText(longText));

    const summary = await readSessionSummary(agentDir, 'test-session');
    expect(summary.title.includes('\n')).toBe(false);
    expect(summary.title.length).toBeLessThanOrEqual(80);
    expect(summary.title.endsWith('…')).toBe(true);
  });

  it('still finds the title after a compaction (first user message is before it)', async () => {
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordMessage(userText('the original ask'));
    await recorder.recordMessage({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
    await recorder.recordCompaction([userText('the original ask\n---\ndigest')], {
      tokensBefore: 5000,
      tokensAfter: 900,
      keptTurns: 1,
    });
    await recorder.recordMessage(userText('a follow-up after compaction'));

    const summary = await readSessionSummary(agentDir, 'test-session');
    expect(summary.title).toBe('the original ask');
  });

  it('falls back to a placeholder when there is no user message with text', async () => {
    const recorder = new SessionRecorder(agentDir, 'test-session');
    // A user message that is only a tool_result (no text) — e.g. a
    // resumed/odd session — should not become the title.
    await recorder.recordMessage({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'x', content: 'ok' }],
    });

    const summary = await readSessionSummary(agentDir, 'test-session');
    expect(summary.title).toBe('(untitled)');
  });

  it('pairs with listSessionIds: same id and mtimeMs for the same session', async () => {
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordMessage(userText('hello'));

    const [listed] = await listSessionIds(agentDir);
    const summary = await readSessionSummary(agentDir, 'test-session');

    expect(listed?.id).toBe(summary.id);
    expect(listed?.mtimeMs).toBe(summary.mtimeMs);
  });
});

describe('normalizeHistory', () => {
  it('inserts aborted results for a trailing assistant tool_use', () => {
    const normalized = normalizeHistory([
      userText('go'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'ls' } }],
      },
    ]);
    expect(normalized).toHaveLength(3);
    expect(normalized[2]?.content).toEqual([
      { type: 'tool_result', toolUseId: 'c1', content: 'aborted', isError: true },
    ]);
  });

  it('fills only the missing tool_result when some results already exist', () => {
    const normalized = normalizeHistory([
      userText('go'),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c1', name: 'read', input: {} },
          { type: 'tool_use', id: 'c2', name: 'read', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'c1', content: 'ok' }],
      },
    ]);
    expect(normalized[2]?.content).toEqual([
      { type: 'tool_result', toolUseId: 'c1', content: 'ok' },
      { type: 'tool_result', toolUseId: 'c2', content: 'aborted', isError: true },
    ]);
  });

  it('drops orphan tool_results and empty user messages', () => {
    const normalized = normalizeHistory([
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'ghost', content: 'orphan' }],
      },
      userText('real'),
    ]);
    expect(normalized).toEqual([userText('real')]);
  });
});

describe('rebuildSessionState', () => {
  let agentDir: string;
  let cwd: string;

  beforeEach(async () => {
    agentDir = await realpath(await mkdtemp(join(tmpdir(), 'hc-session-')));
    // realpath: on macOS, os.tmpdir() is itself a symlink, and
    // assertInsideWorkspace() realpaths everything it resolves — cwd has to
    // be canonical too, or it won't string-match what rebuildSessionState marks.
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'hc-session-cwd-')));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it('marks files touched by successful read/write/edit calls as read', async () => {
    await writeFile(join(cwd, 'a.txt'), 'hello', 'utf8');
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordToolCall({
      id: 'call_1',
      name: 'read',
      input: { path: 'a.txt' },
      result: { content: '1\thello' },
    });

    const session = await rebuildSessionState(agentDir, 'test-session', cwd);

    expect(session.hasRead(join(cwd, 'a.txt'))).toBe(true);
  });

  it('does not mark a file whose recorded call failed', async () => {
    await writeFile(join(cwd, 'a.txt'), 'hello', 'utf8');
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordToolCall({
      id: 'call_1',
      name: 'edit',
      input: { path: 'a.txt', oldString: 'x', newString: 'y' },
      result: { content: 'oldString not found', isError: true },
    });

    const session = await rebuildSessionState(agentDir, 'test-session', cwd);

    expect(session.hasRead(join(cwd, 'a.txt'))).toBe(false);
  });

  it('does not mark a file that no longer exists', async () => {
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordToolCall({
      id: 'call_1',
      name: 'read',
      input: { path: 'gone.txt' },
      result: { content: '1\thello' },
    });

    const session = await rebuildSessionState(agentDir, 'test-session', cwd);

    expect(session.hasRead(join(cwd, 'gone.txt'))).toBe(false);
  });

  it('ignores tool calls unrelated to the file ledger', async () => {
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordToolCall({
      id: 'call_1',
      name: 'bash',
      input: { command: 'echo hi' },
      result: { content: 'hi' },
    });

    const session = await rebuildSessionState(agentDir, 'test-session', cwd);

    expect(session.getTodos()).toEqual([]); // sanity: a fresh, otherwise-empty session
  });
});

describe('session metadata sidecar', () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await realpath(await mkdtemp(join(tmpdir(), 'hc-session-meta-')));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it('reads as null when missing or unreadable', async () => {
    expect(await readSessionMeta(agentDir, 'none')).toBeNull();
    await updateSessionMeta(agentDir, 'torn', { title: 'x' });
    await writeFile(sessionMetaPath(agentDir, 'torn'), '{"v":1,"tit', 'utf8');
    expect(await readSessionMeta(agentDir, 'torn')).toBeNull();
  });

  it('merges patches, clears keys set to undefined, and only fills defaults once', async () => {
    await updateSessionMeta(agentDir, 's', { model: 'a/one', mode: 'plan' }, { createdAt: 1 });
    await updateSessionMeta(agentDir, 's', { mode: 'ask', title: 'Named' }, { createdAt: 2 });
    expect(await readSessionMeta(agentDir, 's')).toEqual({
      v: 1,
      createdAt: 1,
      model: 'a/one',
      mode: 'ask',
      title: 'Named',
    });
    const cleared = await updateSessionMeta(agentDir, 's', { title: undefined });
    expect(cleared.title).toBeUndefined();
    expect('title' in cleared).toBe(false);
  });

  it('serializes concurrent patches so none is lost', async () => {
    await Promise.all([
      updateSessionMeta(agentDir, 's', { pinned: true }),
      updateSessionMeta(agentDir, 's', { archived: true }),
      updateSessionMeta(agentDir, 's', { mode: 'readOnly' }),
      updateSessionMeta(agentDir, 's', { effort: 'high' }),
    ]);
    expect(await readSessionMeta(agentDir, 's')).toMatchObject({
      pinned: true,
      archived: true,
      mode: 'readOnly',
      effort: 'high',
    });
  });

  it('gives a set title precedence in summaries, and stays out of the session list', async () => {
    const recorder = new SessionRecorder(agentDir, 'named');
    await recorder.recordMessage(userText('fix the flaky login test'));
    const before = await readSessionSummary(agentDir, 'named');
    expect(before.meta).toBeUndefined();

    await updateSessionMeta(agentDir, 'named', { title: 'Login flake', pinned: true });
    const after = await readSessionSummary(agentDir, 'named');
    expect(after.title).toBe('Login flake');
    expect(after.meta).toMatchObject({ pinned: true });
    expect(after.mtimeMs).toBe(before.mtimeMs); // the log itself was not touched
    expect((await listSessionIds(agentDir)).map((s) => s.id)).toEqual(['named']);
  });
});

describe('sessions logged in more than one state dir', () => {
  let current: string;
  let legacy: string;
  const say = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] });

  beforeEach(async () => {
    current = await realpath(await mkdtemp(join(tmpdir(), 'hc-session-home-')));
    legacy = await realpath(await mkdtemp(join(tmpdir(), 'hc-session-legacy-')));
  });

  afterEach(async () => {
    await Promise.all([current, legacy].map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('lists them all, each once, and finds the dir a session is logged in', async () => {
    await new SessionRecorder(current, 'new').recordMessage(say('logged where sessions go now'));
    await new SessionRecorder(legacy, 'old').recordMessage(say('logged by an earlier version'));
    await new SessionRecorder(legacy, 'new').recordMessage(say('a stale copy'));

    expect((await listSessionIds([current, legacy])).map((s) => s.id).sort()).toEqual(['new', 'old']);
    expect(await findSessionDir([current, legacy], 'new')).toBe(current);
    expect(await findSessionDir([current, legacy], 'old')).toBe(legacy);
    expect(await findSessionDir([current, legacy], 'nowhere')).toBeUndefined();
  });

  it('forks one logged elsewhere into the dir new sessions go to', async () => {
    await new SessionRecorder(legacy, 'old').recordMessage(say('before'));
    await forkSession(current, 'old', 'fork', undefined, legacy);
    expect(await findSessionDir([current, legacy], 'fork')).toBe(current);
    expect(await loadSession(current, 'fork')).toHaveLength(1);
  });
});
