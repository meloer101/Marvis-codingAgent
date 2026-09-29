import { describe, expect, it } from 'vitest';

import { allCommands, clientCommand, filterCommands, slashQuery } from './slash';

describe('slashQuery', () => {
  it('opens on a bare /token and closes once arguments start', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/comp')).toBe('comp');
    expect(slashQuery('/compact ')).toBeNull();
    expect(slashQuery('/mcp foo')).toBeNull();
  });

  it('stays closed for ordinary text', () => {
    expect(slashQuery('')).toBeNull();
    expect(slashQuery('hello /compact')).toBeNull();
    expect(slashQuery('a/b')).toBeNull();
  });
});

describe('allCommands / filterCommands', () => {
  it('merges client, server, MCP prompts and skills', () => {
    const cmds = allCommands(
      [{ command: 'review', server: 'gh', name: 'review' }],
      [
        { name: 'review', description: 'hidden by the prompt' },
        { name: 'pdf', description: 'Work with PDFs' },
      ],
    );
    expect(cmds.map((c) => c.name)).toEqual([
      'help',
      'clear',
      'model',
      'effort',
      'mode',
      'cost',
      'skills',
      'compact',
      'plan',
      'review',
      'pdf',
    ]);
    expect(cmds.find((c) => c.name === 'review')).toMatchObject({ source: 'mcp', hint: 'gh prompt' });
    expect(cmds.at(-1)).toMatchObject({ source: 'skill', hint: 'Work with PDFs' });
  });

  it('ranks prefix matches above substring matches', () => {
    const cmds = allCommands([{ command: 'recompact', server: 'x', name: 'recompact' }]);
    expect(filterCommands(cmds, 'comp').map((c) => c.name)).toEqual(['compact', 'recompact']);
    expect(filterCommands(cmds, '')).toHaveLength(cmds.length);
    expect(filterCommands(cmds, 'zzz')).toEqual([]);
  });
});

describe('clientCommand', () => {
  const offer = { effortLevels: ['low', 'high'] as const, modes: ['ask', 'acceptEdits', 'plan'] as const };

  it('opens the picker for a command without its argument', () => {
    expect(clientCommand('/model', offer)).toEqual({ kind: 'open', surface: 'model' });
    expect(clientCommand('/effort ', offer)).toEqual({ kind: 'open', surface: 'effort' });
    expect(clientCommand('/cost', offer)).toEqual({ kind: 'open', surface: 'usage' });
    expect(clientCommand('/skills', offer)).toEqual({ kind: 'open', surface: 'skills' });
  });

  it('sets what it is given, and says what is on offer when it is not', () => {
    expect(clientCommand('/model openai/gpt-5', offer)).toEqual({ kind: 'model', ref: 'openai/gpt-5' });
    expect(clientCommand('/effort HIGH', offer)).toEqual({ kind: 'effort', effort: 'high' });
    expect(clientCommand('/effort max', offer)).toMatchObject({ kind: 'error', message: expect.stringContaining('low, high') });
    expect(clientCommand('/mode accept-edits', offer)).toEqual({ kind: 'mode', mode: 'acceptEdits' });
    expect(clientCommand('/mode yolo', offer)).toMatchObject({ kind: 'error' });
    expect(clientCommand('/effort low', { effortLevels: [], modes: ['ask'] })).toMatchObject({ kind: 'error' });
  });

  it('leaves messages, server commands, prompts and skills to the server', () => {
    expect(clientCommand('hello', offer)).toBeNull();
    expect(clientCommand('/compact', offer)).toBeNull();
    expect(clientCommand('/pdf split this', offer)).toBeNull();
  });
});
