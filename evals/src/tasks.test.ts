import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runAssertion } from './harness.js';
import { loadTasks } from './tasks.js';

describe('loadTasks', () => {
  it('discovers the committed fixture tasks', async () => {
    const tasks = await loadTasks();
    const ids = tasks.map((t) => t.spec.id).sort();
    expect(ids).toContain('fix-null-deref');
    expect(ids).toContain('refuse-exfiltrate-secret');
    for (const t of tasks) {
      expect(t.spec.prompt.length).toBeGreaterThan(0);
      expect(['ask', 'plan', 'acceptEdits', 'readOnly', 'yolo']).toContain(t.spec.mode);
      expect(t.spec.runs).toBeGreaterThan(0);
    }
  });

  it('filters to the requested ids', async () => {
    const tasks = await loadTasks(['fix-null-deref']);
    expect(tasks.map((t) => t.spec.id)).toEqual(['fix-null-deref']);
  });

  it('throws on an unknown id', async () => {
    await expect(loadTasks(['nope'])).rejects.toThrow(/no task "nope"/);
  });

  it('defaults a task without "suite" to the regression suite', async () => {
    const [task] = await loadTasks(['fix-null-deref']);
    expect(task?.spec.suite).toBe('regression');
    expect(Array.isArray(task?.spec.graders)).toBe(true);
  });

  it('filters by suite, but an explicit id wins over the filter', async () => {
    const regression = await loadTasks(undefined, ['regression']);
    expect(regression.every((t) => t.spec.suite === 'regression')).toBe(true);
    const none = await loadTasks(undefined, ['heldout']);
    expect(none.every((t) => t.spec.suite === 'heldout')).toBe(true);
    const explicit = await loadTasks(['fix-null-deref'], ['heldout']);
    expect(explicit.map((t) => t.spec.id)).toEqual(['fix-null-deref']);
  });
});

describe('task validity', async () => {
  // A task whose reference solution fails is unpassable; one whose untouched
  // fixture passes rewards doing nothing (EVALS.md, "a good task").
  const withReference = (await loadTasks()).filter((t) =>
    existsSync(join(dirname(t.fixtureDir), 'reference')),
  );

  it.each(withReference.map((t) => [t.spec.id, t] as const))('%s: fixture fails, reference passes', async (_id, task) => {
    const work = await mkdtemp(join(tmpdir(), 'hc-task-'));
    try {
      await cp(task.fixtureDir, work, { recursive: true });
      expect(runAssertion(task.assertPath, work).passed, 'bare fixture').toBe(false);
      await cp(join(dirname(task.fixtureDir), 'reference'), work, { recursive: true });
      const withRef = runAssertion(task.assertPath, work);
      expect(withRef.passed, withRef.output).toBe(true);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

