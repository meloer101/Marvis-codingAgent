import { describe, expect, it } from 'vitest';

import { askOptions, planOptions, toolDisplayName } from './prompt-options.js';

describe('toolDisplayName', () => {
  it('capitalizes builtins and leaves namespaced MCP names alone', () => {
    expect(toolDisplayName('bash')).toBe('Bash');
    expect(toolDisplayName('webfetch')).toBe('Webfetch');
    expect(toolDisplayName('mcp__linear__list_issues')).toBe('mcp__linear__list_issues');
  });
});

describe('askOptions', () => {
  it('offers yes / yes for the session / no-with-reason, in that order', () => {
    const opts = askOptions({ always: '`npm test` commands' });
    expect(opts.map((o) => o.value)).toEqual(['once', 'always', 'deny']);
    expect(opts[1]!.label).toBe("Yes, and don't ask again for `npm test` commands this session");
    expect(opts[2]).toMatchObject({ input: true, hint: '(esc)' });
  });

  it('leaves out "don\'t ask again" when there is nothing safe to allow', () => {
    expect(askOptions({}).map((o) => o.value)).toEqual(['once', 'deny']);
  });

  it('slots the auto-mode switch in before the No when offered', () => {
    const opts = askOptions({ always: 'Bash', offerAuto: true });
    expect(opts.map((o) => o.value)).toEqual(['once', 'always', 'auto', 'deny']);
    expect(opts[2]!.label).toBe('Yes, and switch to auto mode');
  });

  it('only the last row takes typed input', () => {
    expect(askOptions({ always: 'x', offerAuto: true }).filter((o) => o.input)).toHaveLength(1);
  });
});

describe('planOptions', () => {
  it('labels approval with the mode it really lands in', () => {
    expect(planOptions('acceptEdits')[0]!.label).toBe('Yes, auto-accept edits');
    expect(planOptions('auto')[0]!.label).toBe('Yes, and use auto mode');
    expect(planOptions('yolo')[0]!.label).toContain('yolo');
  });

  it('adds a manual-approval row unless approving already means manual', () => {
    expect(planOptions('acceptEdits').map((o) => o.value)).toEqual(['yes', 'manual', 'no']);
    expect(planOptions('ask').map((o) => o.value)).toEqual(['yes', 'no']);
  });
});
