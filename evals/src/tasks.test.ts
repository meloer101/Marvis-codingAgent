import { describe, expect, it } from 'vitest';

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
