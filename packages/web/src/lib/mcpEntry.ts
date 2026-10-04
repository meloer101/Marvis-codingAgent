/**
 * The MCP server form's text: a command line split into a command and its
 * arguments (and back), and the JSON a server's docs give — for Claude Code,
 * Cursor or VS Code — read as entries `mcp.save` takes.
 */

import type { McpServerEntry } from '@harness-code/protocol';

/**
 * Split a command line as a shell would, for the common cases: words
 * separated by spaces, '…' taken as it is, "…" with `\"` and `\\` inside it,
 * and a backslash outside quotes escaping the next character.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) word += line[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote) throw new Error(`a ${quote} is never closed`);
  if (inWord) words.push(word);
  return words;
}

/** Words back into a line `splitCommandLine` reads as them: quoted where they need it. */
export function joinCommandLine(words: readonly string[]): string {
  return words.map((w) => (w !== '' && /^[\w@%+=:,./~-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' ');
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown, what: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || Object.values(value).some((v) => typeof v !== 'string')) throw new Error(`${what} must be an object of strings`);
  return value as Record<string, string>;
}

function looksLikeEntry(value: unknown): boolean {
  return isObject(value) && (typeof value.command === 'string' || typeof value.url === 'string');
}

/** One entry of a `.mcp.json`-shaped object as `mcp.save` takes it. */
export function entryFromJson(name: string, raw: Json): McpServerEntry {
  const type = typeof raw.type === 'string' ? raw.type : undefined;
  if (typeof raw.url === 'string') {
    const transport: McpServerEntry['transport'] =
      type === 'sse' || (type === undefined && /\/sse\/?(?:$|\?)/.test(raw.url)) ? 'sse' : 'http';
    const headers = stringRecord(raw.headers, `"${name}" headers`);
    return {
      name,
      transport,
      url: raw.url,
      ...(headers ? { headers } : {}),
      ...(raw.auth === 'oauth' || raw.auth === 'none' ? { auth: raw.auth } : {}),
    };
  }
  if (typeof raw.command !== 'string' || raw.command.trim() === '') throw new Error(`"${name}" has neither a "command" nor a "url"`);
  const args = raw.args === undefined ? [] : raw.args;
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new Error(`"${name}" args must be a list of strings`);
  const env = stringRecord(raw.env, `"${name}" env`);
  // A whole command line in "command" (some docs write it so) is split as a shell would.
  const words = args.length === 0 && /\s/.test(raw.command.trim()) ? splitCommandLine(raw.command) : [raw.command, ...(args as string[])];
  return {
    name,
    transport: 'stdio',
    command: words[0]!,
    ...(words.length > 1 ? { args: words.slice(1) } : {}),
    ...(env ? { env } : {}),
  };
}

/**
 * The servers in pasted JSON: `{"mcpServers": {…}}` (Claude Code, Cursor),
 * `{"servers": {…}}` (VS Code), the servers object itself, or one server
 * named as `{"name": {…}}`. A bare entry has no name — that's an error that
 * says how to give it one.
 */
export function parseMcpJson(text: string): McpServerEntry[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(doc)) throw new Error('not a JSON object');
  if (looksLikeEntry(doc)) throw new Error('name the server: paste it as {"name": { … }}');
  const servers = isObject(doc.mcpServers) ? doc.mcpServers : isObject(doc.servers) ? doc.servers : doc;
  const entries = Object.entries(servers).filter(([, v]) => isObject(v));
  if (entries.length === 0 || !entries.every(([, v]) => looksLikeEntry(v))) {
    throw new Error('no server in it: each needs a "command" or a "url"');
  }
  return entries.map(([name, raw]) => entryFromJson(name, raw as Json));
}
