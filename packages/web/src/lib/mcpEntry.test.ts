import { describe, expect, it } from 'vitest';

import { joinCommandLine, parseMcpJson, splitCommandLine } from './mcpEntry';

describe('command lines', () => {
  it('splits as a shell would, and joins back to what splits the same', () => {
    expect(splitCommandLine('npx -y @modelcontextprotocol/server-filesystem .')).toEqual(['npx', '-y', '@modelcontextprotocol/server-filesystem', '.']);
    expect(splitCommandLine(`uvx  mcp-x --root "/Users/me/My Docs" 'it''s' a\\ b ""`)).toEqual(['uvx', 'mcp-x', '--root', '/Users/me/My Docs', 'its', 'a b', '']);
    expect(splitCommandLine('echo "say \\"hi\\""')).toEqual(['echo', 'say "hi"']);
    expect(() => splitCommandLine('echo "open')).toThrow(/never closed/);
    const words = ['node', '/a b/server.js', "it's", '', '--flag=1'];
    expect(joinCommandLine(words)).toBe(`node '/a b/server.js' 'it'\\''s' '' --flag=1`);
    expect(splitCommandLine(joinCommandLine(words))).toEqual(words);
  });
});

describe('pasted JSON', () => {
  it('reads the shapes the docs give', () => {
    const fs = { command: 'npx', args: ['-y', 'server-fs', '.'], env: { ROOT: '/tmp' } };
    const expected = { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'server-fs', '.'], env: { ROOT: '/tmp' } };
    expect(parseMcpJson(JSON.stringify({ mcpServers: { fs } }))).toEqual([expected]);
    expect(parseMcpJson(JSON.stringify({ servers: { fs } }))).toEqual([expected]);
    expect(parseMcpJson(JSON.stringify({ fs }))).toEqual([expected]);
    expect(
      parseMcpJson(
        JSON.stringify({
          mcpServers: {
            linear: { url: 'https://mcp.linear.app/sse' },
            api: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${T}' }, auth: 'none' },
            one: { command: 'uvx mcp-server-time --tz UTC' },
          },
        }),
      ),
    ).toEqual([
      { name: 'linear', transport: 'sse', url: 'https://mcp.linear.app/sse' },
      { name: 'api', transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${T}' }, auth: 'none' },
      { name: 'one', transport: 'stdio', command: 'uvx', args: ['mcp-server-time', '--tz', 'UTC'] },
    ]);
  });

  it('says what is wrong with what is not', () => {
    expect(() => parseMcpJson('{ "a": ')).toThrow(/not JSON/);
    expect(() => parseMcpJson('{"command": "npx"}')).toThrow(/name the server/);
    expect(() => parseMcpJson('{"mcpServers": {}}')).toThrow(/no server/);
    expect(() => parseMcpJson('{"a": {"args": []}}')).toThrow(/no server/);
    expect(() => parseMcpJson('{"a": {"command": "x", "env": {"N": 1}}}')).toThrow(/env must be/);
  });
});
