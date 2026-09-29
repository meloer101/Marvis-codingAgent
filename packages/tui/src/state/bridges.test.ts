import { describe, expect, it } from 'vitest';

import { UiStore } from './bridges.js';

describe('UiStore.pushNotice', () => {
  it('drops mode-changed notices — the status line already shows the mode', () => {
    const store = new UiStore(() => {});
    store.pushNotice({ kind: 'mode-changed', level: 'info', text: 'mode: ask → acceptEdits' });
    expect(store.drainNotices()).toEqual([]);
  });

  it('keeps every other notice, in order', () => {
    const store = new UiStore(() => {});
    store.pushNotice({ kind: 'mode-changed', level: 'info', text: 'mode: ask → plan' });
    store.pushNotice({ kind: 'auto-mode', level: 'warn', text: 'auto mode unavailable: no key' });
    store.pushNotice({ kind: 'effort-changed', level: 'info', text: 'effort: none → high' });
    expect(store.drainNotices().map((n) => n.kind)).toEqual(['auto-mode', 'effort-changed']);
  });
});
