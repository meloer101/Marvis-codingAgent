import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileOAuthStore, projectEnv } from '@harness-code/core';

import { InvalidRequestError } from './host.js';
import {
  deleteMemory,
  mcpLogin,
  mcpLogout,
  mcpView,
  memoryView,
  providersView,
  readMemory,
  setAutoModeGroup,
  setBackgroundProcesses,
  setDefaultModel,
  setProviderKey,
  setRules,
  settingsView,
  writeMemory,
} from './settings.js';
import type { SettingsPlace } from './settings.js';

let home: string;
let place: SettingsPlace;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'hc-settings-')));
  const root = join(home, 'repo');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, '.agent'));
  place = { root, projectRoot: root, home, env: { LINEAR_TOKEN: 'secret-token' } };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

describe('permission rules', () => {
  it('reads and writes each layer, a list at a time, never the file around it', async () => {
    await mkdir(join(home, '.agent'));
    await writeFile(join(home, '.agent', 'settings.json'), JSON.stringify({ model: 'a/b', providers: { a: { apiKey: 'k' } } }));
    await setRules(place, 'user', 'allow', ['Bash(npm test:*)', ' Bash(npm test:*) ']);
    await setRules(place, 'project', 'deny', ['Write(dist/**)']);
    const view = await settingsView(place);
    expect(view.user.rules).toEqual({ allow: ['Bash(npm test:*)'], ask: [], deny: [] });
    expect(view.project.rules.deny).toEqual(['Write(dist/**)']);
    expect(view.project.path).toBe(join(place.root, '.agent', 'settings.json'));
    expect(view.builtinAllow.length).toBeGreaterThan(0);
    expect(JSON.stringify(view)).not.toContain('apiKey');
    expect(await json(join(home, '.agent', 'settings.json'))).toMatchObject({ model: 'a/b', permissions: { allow: ['Bash(npm test:*)'] } });
  });

  it("refuses a rule that doesn't parse, and a settings file that doesn't", async () => {
    await expect(setRules(place, 'project', 'allow', ['Bash(npm'])).rejects.toBeInstanceOf(InvalidRequestError);
    await mkdir(join(home, '.agent'));
    await writeFile(join(home, '.agent', 'settings.json'), '{ "model": ');
    const view = await settingsView(place);
    expect(view.problems).toHaveLength(1);
    await expect(setRules(place, 'user', 'deny', ['Write'])).rejects.toThrow(/not valid JSON/);
    expect(await readFile(join(home, '.agent', 'settings.json'), 'utf8')).toBe('{ "model": ');
  });

  it("turns background commands on in the user's settings, and off again", async () => {
    await mkdir(join(place.root, '.agent'), { recursive: true });
    await writeFile(join(place.root, '.agent', 'settings.json'), JSON.stringify({ backgroundProcesses: true }));
    expect((await settingsView(place)).backgroundProcesses).toEqual({ user: false, project: true });
    await setBackgroundProcesses(place, true);
    expect((await settingsView(place)).backgroundProcesses.user).toBe(true);
    await setBackgroundProcesses(place, false);
    expect(await json(join(home, '.agent', 'settings.json'))).toEqual({});
  });

  it("sets an auto-mode group in the user's settings, or drops it back to the built-ins", async () => {
    await setAutoModeGroup(place, 'environment', ['$defaults', 'Org: acme', '']);
    let view = await settingsView(place, 'no classifier');
    expect(view.autoMode.rules).toEqual({ environment: ['$defaults', 'Org: acme'] });
    expect(view.autoMode.unavailable).toBe('no classifier');
    expect(view.autoMode.builtin.hard_deny.length).toBeGreaterThan(0);
    await setAutoModeGroup(place, 'environment', null);
    view = await settingsView(place);
    expect(view.autoMode.rules).toEqual({});
  });
});

describe('memory', () => {
  const entry = (description: string, type = 'feedback') =>
    `---\nname: no mocks\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\nUse the real database in tests.\n`;

  it('lists the instruction files there are, or the one to write', async () => {
    await writeFile(join(place.root, 'CLAUDE.md'), '# rules\n');
    const view = await memoryView(place);
    expect(view.instructions).toEqual([
      { scope: 'user', name: 'AGENTS.md', path: join(home, '.agent', 'AGENTS.md') },
      { scope: 'project', name: 'CLAUDE.md', path: join(place.root, 'CLAUDE.md'), bytes: 8 },
    ]);
    await writeMemory(place, { kind: 'instructions', scope: 'user', name: 'AGENTS.md' }, 'Be brief.');
    expect(await readMemory(place, { kind: 'instructions', scope: 'user', name: 'AGENTS.md' })).toBe('Be brief.\n');
  });

  it('writes a memory that parses, keeps the index, and deletes it', async () => {
    const target = { kind: 'memory', scope: 'project', path: 'feedback/no-mocks.md' } as const;
    await writeMemory(place, target, entry('tests hit the real database'));
    const view = await memoryView(place);
    expect(view.memories).toEqual([
      expect.objectContaining({ scope: 'project', path: 'feedback/no-mocks.md', name: 'no mocks', type: 'feedback' }),
    ]);
    const index = await readFile(join(view.dirs.project, 'MEMORY.md'), 'utf8');
    expect(index).toContain('[no mocks](feedback/no-mocks.md)');
    expect(await readMemory(place, target)).toContain('Use the real database');

    await deleteMemory(place, target);
    expect((await memoryView(place)).memories).toEqual([]);
    expect(await readFile(join(view.dirs.project, 'MEMORY.md'), 'utf8')).toBe('');
  });

  it("refuses a memory that doesn't parse, or isn't one the scope keeps", async () => {
    await expect(
      writeMemory(place, { kind: 'memory', scope: 'project', path: 'feedback/x.md' }, '---\nname: x\n---\nbody'),
    ).rejects.toThrow(/description/);
    await expect(
      writeMemory(place, { kind: 'memory', scope: 'project', path: 'user/x.md' }, entry('about me', 'user')),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(deleteMemory(place, { kind: 'instructions', scope: 'project', name: 'AGENTS.md' })).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });

  it('lists a broken memory with what is wrong with it', async () => {
    const dir = join(home, '.agent', 'memory', 'reference');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'broken.md'), 'no frontmatter at all');
    const [broken] = (await memoryView(place)).memories;
    expect(broken).toMatchObject({ scope: 'global', path: 'reference/broken.md', name: 'broken', type: 'reference' });
    expect(broken?.problem).toBeTruthy();
  });
});

describe('MCP servers', () => {
  beforeEach(async () => {
    await mkdir(join(home, '.agent'), { recursive: true });
    await writeFile(
      join(home, '.agent', '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          files: { command: 'npx', args: ['-y', 'mcp-files'], env: { TOKEN: '${LINEAR_TOKEN}' } },
          linear: { url: 'https://mcp.linear.app/sse' },
        },
      }),
    );
    await writeFile(
      join(place.root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
          api: { url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' } },
        },
      }),
    );
  });

  it('lists them as their files have them, which one is used, and how each signs in', async () => {
    const view = await mcpView(place);
    expect(view.servers).toEqual([
      { name: 'files', scope: 'user', transport: 'stdio', target: 'npx -y mcp-files', auth: 'none' },
      { name: 'linear', scope: 'user', transport: 'sse', target: 'https://mcp.linear.app/sse', auth: 'oauth', signedIn: false, shadowed: true },
      { name: 'linear', scope: 'project', transport: 'http', target: 'https://mcp.linear.app/mcp', auth: 'oauth', signedIn: false },
      { name: 'api', scope: 'project', transport: 'http', target: 'https://api.example.com/mcp', auth: 'header' },
    ]);
    expect(JSON.stringify(view)).not.toContain('secret-token');
  });

  it('knows a stored sign-in, and forgets it', async () => {
    const store = new FileOAuthStore('https://mcp.linear.app/mcp', join(home, '.agent', 'mcp-auth'));
    await store.saveTokens({ access_token: 't', token_type: 'Bearer' });
    expect((await mcpView(place)).servers.find((s) => s.scope === 'project' && s.name === 'linear')?.signedIn).toBe(true);
    await mcpLogout(place, 'linear');
    expect(await store.tokens()).toBeUndefined();
  });

  it("won't sign in to a server that doesn't use OAuth", async () => {
    await expect(mcpLogin(place, 'files', () => {})).rejects.toThrow(/doesn't sign in with OAuth/);
    await expect(mcpLogin(place, 'api', () => {})).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(mcpLogin(place, 'nope', () => {})).rejects.toThrow(/no usable MCP server/);
  });
});

describe('model providers and their keys', () => {
  /** The environment sessions there run with, read again as the server reads it at each use. */
  const fresh = (base: NodeJS.ProcessEnv = {}): SettingsPlace => ({ ...place, env: projectEnv(place.root, { base, home }) });
  const provider = async (id: string, at: SettingsPlace = fresh()) =>
    (await providersView(at)).providers.find((p) => p.id === id);

  it('lists every provider with where its key comes from — never the key', async () => {
    await writeFile(join(place.root, '.env'), 'MOONSHOT_API_KEY=sk-project-key\n');
    await mkdir(join(home, '.agent'));
    await writeFile(join(home, '.agent', '.env'), 'GROQ_API_KEY=gsk-user-key\n');
    await writeFile(join(home, '.agent', 'settings.json'), JSON.stringify({ providers: { openai: { apiKey: 'sk-literal-key' } } }));
    const view = await providersView(fresh({ XAI_API_KEY: 'sk-shell-key', MOONSHOT_API_KEY: 'sk-project-key' }));

    const by = (id: string) => view.providers.find((p) => p.id === id);
    expect(by('deepseek')).toEqual({
      id: 'deepseek',
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      requiresKey: true,
      keyVar: 'DEEPSEEK_API_KEY',
    });
    expect(by('moonshot')).toMatchObject({ keySource: 'project', keySourceVar: 'MOONSHOT_API_KEY' });
    expect(by('groq')).toMatchObject({ keySource: 'user', keySourceVar: 'GROQ_API_KEY' });
    expect(by('xai')).toMatchObject({ keySource: 'environment', keySourceVar: 'XAI_API_KEY' });
    expect(by('openai')).toMatchObject({ keySource: 'settings' });
    expect(by('ollama')).toMatchObject({ requiresKey: false });
    expect(by('ollama')).not.toHaveProperty('keyVar'); // takes none
    expect(view.envPath).toBe(join(home, '.agent', '.env'));
    expect(view.model).toBe('deepseek/deepseek-flash');
    expect(view).not.toHaveProperty('modelSource'); // the built-in default
    expect(JSON.stringify(view)).not.toMatch(/sk-|gsk-/);
  });

  it("saves a key in the user's ~/.agent/.env, replaces it, and removes it", async () => {
    expect(await provider('deepseek')).not.toHaveProperty('keySource');
    await setProviderKey(fresh(), 'deepseek', 'sk-first');
    expect(await readFile(join(home, '.agent', '.env'), 'utf8')).toBe('DEEPSEEK_API_KEY=sk-first\n');
    expect(await provider('deepseek')).toMatchObject({ keySource: 'user', keySourceVar: 'DEEPSEEK_API_KEY' });

    await setProviderKey(fresh(), 'deepseek', 'sk-second');
    expect(await readFile(join(home, '.agent', '.env'), 'utf8')).toBe('DEEPSEEK_API_KEY=sk-second\n');

    await setProviderKey(fresh(), 'deepseek', null);
    expect(await provider('deepseek')).not.toHaveProperty('keySource');
  });

  it('refuses a provider that is not one, or takes no key', async () => {
    await expect(setProviderKey(fresh(), 'nope', 'k')).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(setProviderKey(fresh(), 'ollama', 'k')).rejects.toThrow(/takes no API key/);
  });

  it("sets the model new sessions start on in the user's settings, and resets it", async () => {
    await setDefaultModel(fresh(), 'openrouter/anthropic/claude-sonnet-4');
    expect(await json(join(home, '.agent', 'settings.json'))).toEqual({ model: 'openrouter/anthropic/claude-sonnet-4' });
    expect(await providersView(fresh())).toMatchObject({ model: 'openrouter/anthropic/claude-sonnet-4', modelSource: 'user' });

    await expect(setDefaultModel(fresh(), 'nowhere/some-model')).rejects.toBeInstanceOf(InvalidRequestError);

    // The project's settings win over the user's: the view says so.
    await writeFile(join(place.root, '.agent', 'settings.json'), JSON.stringify({ model: 'deepseek/deepseek-v4-pro' }));
    expect(await providersView(fresh())).toMatchObject({ model: 'deepseek/deepseek-v4-pro', modelSource: 'project' });

    await setDefaultModel(fresh(), '');
    expect(await json(join(home, '.agent', 'settings.json'))).toEqual({});
  });
});
