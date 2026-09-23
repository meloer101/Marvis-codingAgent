import { describe, expect, it } from 'vitest';

import { DsmlSalvager, salvageBareToolCall } from './dsml-salvage.js';

const TOOLS = new Set(['bash', 'read', 'edit', 'terminal']);

/** Feed `text` in chunks of `size`, collecting what would have been shown. */
function run(text: string, opts: { size?: number; nativeCalls?: boolean } = {}) {
  const s = new DsmlSalvager(TOOLS);
  const size = opts.size ?? 3;
  let shown = '';
  for (let i = 0; i < text.length; i += size) shown += s.push(text.slice(i, i + size));
  return { shown, ...s.end(opts.nativeCalls ?? false) };
}

// vllm-project/vllm#48931: V4-Flash at ~95K context, opening wrapper missing.
const VLLM_48931 =
  '<｜DSML｜invoke name="terminal"><｜DSML｜parameter name="command" string="true">echo hi</｜DSML｜parameter>' +
  '</｜DSML｜invoke></｜DSML｜tool_calls>';

// smg-project/smg#2525: V4.1 puts a space after ｜DSML｜ in every tag.
const V41 = [
  '<｜DSML｜ calls>',
  '<｜DSML｜ invoke name="edit">',
  '<｜DSML｜ parameter name="path" string="true">src/a.ts</｜DSML｜ parameter>',
  '<｜DSML｜ parameter name="oldString" string="true">  x = 1\n</｜DSML｜ parameter>',
  '<｜DSML｜ parameter name="replaceAll" string="false">false</｜DSML｜ parameter>',
  '</｜DSML｜ invoke>',
  '</｜DSML｜ calls>',
].join('\n');

describe('DsmlSalvager', () => {
  it('recovers the V4 form with the opening wrapper missing', () => {
    const out = run(VLLM_48931);
    expect(out.shown).toBe('');
    expect(out.text).toBe('');
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]).toMatchObject({ name: 'terminal', input: { command: 'echo hi' } });
    expect(out.calls[0]!.parseError).toBeUndefined();
  });

  it('recovers the V4.1 spaced form, keeping string values verbatim and parsing the rest', () => {
    const out = run(V41);
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]!.input).toEqual({ path: 'src/a.ts', oldString: '  x = 1\n', replaceAll: false });
  });

  it('keeps an unparsable string="false" value as the raw string', () => {
    const out = run(
      '<｜DSML｜invoke name="bash"><｜DSML｜parameter name="timeout" string="false">soon</｜DSML｜parameter></｜DSML｜invoke>',
    );
    expect(out.calls[0]!.input).toEqual({ timeout: 'soon' });
  });

  it('recovers several invokes in one batch, each with its own id', () => {
    const one = (cmd: string) =>
      `<｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">${cmd}</｜DSML｜parameter></｜DSML｜invoke>`;
    const out = run(`<｜DSML｜tool_calls>\n${one('ls')}\n${one('pwd')}\n</｜DSML｜tool_calls>`);
    expect(out.calls.map((c) => c.input)).toEqual([{ command: 'ls' }, { command: 'pwd' }]);
    expect(new Set(out.calls.map((c) => c.id)).size).toBe(2);
  });

  it('streams the prose before the markup and holds back only the markup', () => {
    const out = run(`Let me check.\n\n${VLLM_48931}`, { size: 1 });
    expect(out.shown).toBe('Let me check.\n\n');
    expect(out.text).toBe('');
    expect(out.calls).toHaveLength(1);
  });

  it('never shows a tag split across chunks', () => {
    const out = run(`ok <｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">a</｜DSML｜parameter></｜DSML｜invoke>`, { size: 2 });
    expect(out.shown).toBe('ok ');
    expect(out.shown).not.toContain('<');
  });

  it('releases the held text when the endpoint also returned real tool calls', () => {
    const out = run(VLLM_48931, { nativeCalls: true });
    expect(out.calls).toEqual([]);
    expect(out.text).toBe(VLLM_48931);
  });

  it('leaves markup naming an unregistered tool as text', () => {
    const text = 'The format is <｜DSML｜invoke name="get_weather"></｜DSML｜invoke>.';
    const out = run(text);
    expect(out.calls).toEqual([]);
    expect(out.shown + out.text).toBe(text);
  });

  it('turns an invoke the stream cut off into a call carrying a parse error', () => {
    const out = run('<｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>');
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]!.parseError).toMatch(/cut off/);
    expect(out.calls[0]!.input).toEqual({ command: 'ls' });
  });

  it('passes ordinary text straight through, including a trailing "<"', () => {
    const out = run('a < b and c <');
    expect(out.shown + out.text).toBe('a < b and c <');
    expect(out.calls).toEqual([]);
  });
});

describe('salvageBareToolCall', () => {
  it('recovers a trailing toolname{json}', () => {
    const out = salvageBareToolCall('I will list the files.\nbash{"command": "ls -la"}', TOOLS);
    expect(out?.text).toBe('I will list the files.');
    expect(out?.calls[0]).toMatchObject({ name: 'bash', input: { command: 'ls -la' } });
  });

  it('accepts whitespace before the brace', () => {
    expect(salvageBareToolCall('read {"path": "a.ts"}', TOOLS)?.calls[0]?.name).toBe('read');
  });

  it('ignores an unregistered name, a name inside a word, and loose JSON', () => {
    expect(salvageBareToolCall('get_weather{"city": "x"}', TOOLS)).toBeUndefined();
    expect(salvageBareToolCall('thread{"path": "a"}', TOOLS)).toBeUndefined();
    expect(salvageBareToolCall("bash{command: 'ls'}", TOOLS)).toBeUndefined();
  });

  it('ignores a call that is not at the very end', () => {
    expect(salvageBareToolCall('bash{"command": "ls"} and then I stopped.', TOOLS)).toBeUndefined();
  });
});
