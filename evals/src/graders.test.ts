import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { TraceEvent } from '@harness-code/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { diffWorkspace, globToRegExp, lineDelta } from './graders/fs.js';
import { runGraders } from './graders/index.js';

let root: string;
let fixture: string;
let work: string;

async function put(dir: string, rel: string, body: string): Promise<void> {
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await writeFile(join(dir, rel), body);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hc-graders-'));
  fixture = join(root, 'fixture');
  work = join(root, 'work');
  for (const dir of [fixture, work]) {
    await put(dir, 'src/a.js', 'one\ntwo\nthree\n');
    await put(dir, 'test/a.test.mjs', 'test\n');
  }
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx = (events: TraceEvent[] = []) => ({ fixtureDir: fixture, workDir: work, events });

describe('fs helpers', () => {
  it('globs: * stays in a segment, ** spans directories', () => {
    expect(globToRegExp('src/*.js').test('src/a.js')).toBe(true);
    expect(globToRegExp('src/*.js').test('src/x/a.js')).toBe(false);
    expect(globToRegExp('**/*.test.*').test('a.test.mjs')).toBe(true);
    expect(globToRegExp('**/*.test.*').test('deep/er/a.test.mjs')).toBe(true);
    expect(globToRegExp('test/**').test('test/x/y.mjs')).toBe(true);
  });

  it('lineDelta counts an edit as one removed + one added line', () => {
    expect(lineDelta(['a', 'b', 'c'], ['a', 'B', 'c'])).toEqual({ added: 1, removed: 1 });
    expect(lineDelta([], ['x'])).toEqual({ added: 1, removed: 0 });
  });

  it('diffWorkspace lists added, removed and modified files, skipping node_modules', async () => {
    await put(work, 'src/a.js', 'one\nTWO\nthree\n');
    await put(work, 'src/new.js', 'x\ny\n');
    await put(work, 'node_modules/dep/index.js', 'ignored\n');
    await rm(join(work, 'test/a.test.mjs'));
    const changes = await diffWorkspace(fixture, work);
    expect(changes).toEqual([
      { path: 'src/a.js', status: 'modified', added: 1, removed: 1 },
      { path: 'src/new.js', status: 'added', added: 2, removed: 0 },
      { path: 'test/a.test.mjs', status: 'removed', added: 0, removed: 1 },
    ]);
  });
});

describe('graders', () => {
  it('diff-size fails past its caps', async () => {
    await put(work, 'src/helper.js', 'a\nb\nc\nd\n');
    const r = await runGraders(
      [
        { name: 'diff-size', maxChangedLines: 10, maxNewFiles: 1 },
        { name: 'diff-size-strict', maxChangedLines: 2 },
      ],
      ctx(),
    );
    expect(r['diff-size']?.passed).toBe(true);
    expect(r['diff-size-strict']).toMatchObject({ passed: false, detail: expect.stringContaining('unknown grader') });
    const strict = await runGraders([{ name: 'diff-size', maxChangedLines: 2 }], ctx());
    expect(strict['diff-size']).toMatchObject({ passed: false, detail: expect.stringContaining('4 changed lines > 2') });
  });

  it('scratch-sprawl allows declared files only', async () => {
    await put(work, 'src/slug.js', 'x\n');
    await put(work, 'debug_output.txt', 'x\n');
    const r = await runGraders([{ name: 'scratch-sprawl', allow: ['src/**'] }], ctx());
    expect(r['scratch-sprawl']).toMatchObject({ passed: false, detail: expect.stringContaining('debug_output.txt') });
  });

  it('tests-untouched catches an edited test', async () => {
    const clean = await runGraders([{ name: 'tests-untouched' }], ctx());
    expect(clean['tests-untouched']?.passed).toBe(true);
    await put(work, 'test/a.test.mjs', 'test.skip\n');
    const r = await runGraders([{ name: 'tests-untouched' }], ctx());
    expect(r['tests-untouched']).toMatchObject({ passed: false, detail: expect.stringContaining('test/a.test.mjs') });
  });

  describe('first-touch', () => {
    const modelCall = (turn: number): TraceEvent => ({
      type: 'model_call',
      ts: turn,
      turn,
      model: 'm',
      stopReason: 'tool_use',
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
    });
    const toolCall = (turn: number, name: string, path: string, isError = false): TraceEvent => ({
      type: 'tool_call',
      ts: turn,
      turn,
      id: `c${turn}`,
      name,
      inputSummary: JSON.stringify({ path, content: 'x'.repeat(10) }),
      durationMs: 1,
      isError,
      outputBytes: 1,
    });
    const run = (touchTurn: number, total: number, path = 'src/a.js'): TraceEvent[] => {
      const out: TraceEvent[] = [{ type: 'run_start', ts: 0, sessionId: 's', model: 'm', cwd: work }];
      for (let t = 1; t <= total; t++) {
        out.push(modelCall(t));
        if (t === touchTurn) out.push(toolCall(t, 'edit', join(work, path)));
        else out.push(toolCall(t, 'read', path));
      }
      return out;
    };
    const spec = { name: 'first-touch', deliverable: ['src/*.js'] };

    it('passes an early write (absolute path, relativized against cwd)', async () => {
      const r = await runGraders([spec], ctx(run(4, 12)));
      expect(r['first-touch']).toMatchObject({ passed: true, detail: 'first write at turn 4/12 (33%)' });
    });

    it('allows the grace turns on short runs', async () => {
      const r = await runGraders([spec], ctx(run(5, 6)));
      expect(r['first-touch']?.passed).toBe(true);
    });

    it('fails a late first write, and a deliverable never written', async () => {
      expect((await runGraders([spec], ctx(run(9, 12))))['first-touch']?.passed).toBe(false);
      expect((await runGraders([spec], ctx(run(6, 12))))['first-touch']?.passed).toBe(false);
      const never = await runGraders([spec], ctx(run(5, 12, 'notes.md')));
      expect(never['first-touch']).toMatchObject({ passed: false, detail: expect.stringContaining('never written') });
    });

    it('ignores failed writes', async () => {
      const events = run(9, 12);
      events.splice(3, 0, toolCall(1, 'write', 'src/a.js', true));
      expect((await runGraders([spec], ctx(events)))['first-touch']?.passed).toBe(false);
    });
  });
});
