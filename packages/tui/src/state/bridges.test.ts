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
