import { describe, expect, it } from 'vitest';

import { UiStore } from './bridges.js';

describe('UiStore.pushNotice', () => {
  it('drops mode and effort switches — the status line already shows them', () => {
    const store = new UiStore(() => {});
    store.pushNotice({ kind: 'mode-changed', level: 'info', text: 'mode: ask → acceptEdits' });
    store.pushNotice({ kind: 'effort-changed', level: 'info', text: 'effort: none → high' });
    expect(store.drainNotices()).toEqual([]);
  });

  it('keeps every other notice, in order', () => {
    const store = new UiStore(() => {});
    store.pushNotice({ kind: 'mode-changed', level: 'info', text: 'mode: ask → plan' });
    store.pushNotice({ kind: 'auto-mode', level: 'warn', text: 'auto mode unavailable: no key' });
    store.pushNotice({ kind: 'skill-loaded', level: 'info', text: 'skill loaded: x' });
    expect(store.drainNotices().map((n) => n.kind)).toEqual(['auto-mode', 'skill-loaded']);
  });
});

describe('UiStore.answerAsk', () => {
  it('"always" adds the rules for the asked command, not the whole tool', async () => {
    const added: string[] = [];
    const store = new UiStore((rule) => added.push(rule));
    const decision = store.ask({ toolName: 'bash', input: { command: 'npm test | tail -5' }, reason: 'r' });
    expect(store.pendingAsk?.alwaysAllow).toBe('`npm test` commands');
    store.answerAsk('always');
    expect(await decision).toEqual({ decision: 'allow' });
    expect(added).toEqual(['Bash(npm test:*)']);
  });

  it('offers nothing to always-allow when no rule can safely cover the command', () => {
    const store = new UiStore(() => {});
    void store.ask({ toolName: 'bash', input: { command: 'sudo make install' }, reason: 'r' });
    expect(store.pendingAsk?.alwaysAllow).toBeUndefined();
  });
});
