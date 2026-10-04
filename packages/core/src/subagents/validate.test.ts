import { describe, expect, it } from 'vitest';

import { agentFields, formatAgentFile, parseAgent } from './validate.js';

const fm = (fields: Record<string, string>, body = 'Role instructions.'): string =>
  ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', '', body].join('\n');

const parse = (raw: string, stem = 'explore') => parseAgent({ raw, stem, source: 'builtin' });

describe('parseAgent', () => {
  it('accepts a valid definition and parses tools + model', () => {
    const r = parse(fm({ name: 'explore', description: 'search', tools: 'read, glob grep', model: 'x/y' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.agent.tools).toEqual(['read', 'glob', 'grep']);
      expect(r.agent.model).toBe('x/y');
      expect(r.agent.body).toBe('Role instructions.');
    }
  });

  it('parses a declared effort and rejects one off the ladder', () => {
    const ok = parse(fm({ name: 'explore', description: 'd', effort: 'LOW' }));
    expect(ok.ok && ok.agent.effort).toBe('low');
    expect(parse(fm({ name: 'explore', description: 'd', effort: 'turbo' }))).toMatchObject({
      ok: false,
    });
  });

  it('treats tools as optional (inherit all)', () => {
    const r = parse(fm({ name: 'explore', description: 'd' }));
    expect(r.ok && r.agent.tools).toBeUndefined();
  });

  it('rejects name/file mismatch, missing description, empty body', () => {
    expect(parse(fm({ name: 'other', description: 'd' }), 'explore')).toMatchObject({ ok: false });
    expect(parse(fm({ name: 'explore' }))).toMatchObject({ ok: false });
    expect(parse(fm({ name: 'explore', description: 'd' }, '   '))).toMatchObject({ ok: false });
  });

  it('reports malformed YAML rather than throwing', () => {
    expect(parse('---\nname: [x\n---\nbody')).toMatchObject({ ok: false });
  });
});

describe('formatAgentFile', () => {
  it('writes a file that parses back to what it was given, keeping what else the old one had', () => {
    const previous = '---\nname: old\ndescription: x\ncolor: blue\ntools: Read\n---\n\nOld body.\n';
    const text = formatAgentFile(
      'scout',
      { description: 'Find things: fast, # and quietly', tools: ['read', 'grep'], model: 'deepseek/deepseek-chat', effort: 'low', body: '  Look around.\n' },
      previous,
    );
    expect(text).toBe(
      "---\nname: scout\ndescription: 'Find things: fast, # and quietly'\ntools: read grep\nmodel: deepseek/deepseek-chat\neffort: low\ncolor: blue\n---\n\nLook around.\n",
    );
    const parsed = parseAgent({ raw: text, stem: 'scout', source: 'user' });
    expect(parsed.ok && agentFields(parsed.agent)).toEqual({
      description: 'Find things: fast, # and quietly',
      tools: ['read', 'grep'],
      model: 'deepseek/deepseek-chat',
      effort: 'low',
      body: 'Look around.',
    });
  });

  it('tells no tools at all from all of them', () => {
    const none = parseAgent({ raw: formatAgentFile('a', { description: 'd', tools: [], body: 'b' }), stem: 'a', source: 'user' });
    const all = parseAgent({ raw: formatAgentFile('a', { description: 'd', body: 'b' }), stem: 'a', source: 'user' });
    expect(none.ok && none.agent.tools).toEqual([]);
    expect(all.ok && all.agent.tools).toBeUndefined();
  });
});
