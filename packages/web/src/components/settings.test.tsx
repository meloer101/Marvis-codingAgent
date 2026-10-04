import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { McpView, MemoryView, ProvidersView, SessionDenials, SettingsView } from '@harness-code/protocol';

import { AutoModeSection } from './settings/AutoModeSection';
import { McpSection } from './settings/McpSection';
import { MemorySection } from './settings/MemorySection';
import { ModelsSection } from './settings/ModelsSection';
import { PermissionsSection } from './settings/PermissionsSection';
import { ToolsSection } from './settings/ToolsSection';
import { platform } from '@/platform';
import { useAppStore } from '@/lib/store';
import type { McpLoginPush, SessionSync } from '@/lib/sync';
import { SyncProvider } from '@/lib/syncContext';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAppStore.setState({ sessions: [] });
});

const view = (over: Partial<SettingsView> = {}): SettingsView => ({
  user: { path: '/home/me/.agent/settings.json', rules: { allow: ['Bash(npm test:*)'], ask: [], deny: [] } },
  project: { path: '/p/.agent/settings.json', rules: { allow: [], ask: [], deny: ['Write(dist/**)'] } },
  builtinAllow: ['Read', 'Grep'],
  backgroundProcesses: { user: false, project: false },
  autoMode: {
    rules: {},
    builtin: { environment: ['Org: who'], allow: ['A: a'], soft_deny: ['S: s'], hard_deny: ['H: h'] },
  },
  problems: [],
  ...over,
});

/** A sync whose settings calls go to `answer`, by method. */
function syncFor(answer: (method: string, params: Record<string, unknown>) => unknown) {
  const listeners = new Set<(e: McpLoginPush) => void>();
  const settingsCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
    const result = answer(method, params);
    if (result instanceof Error) throw result;
    return result;
  });
  const sync = {
    settingsCall,
    loadModels: vi.fn(async () => {}),
    onMcpLogin: (fn: (e: McpLoginPush) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as SessionSync;
  return { sync, settingsCall, push: (e: McpLoginPush) => listeners.forEach((fn) => fn(e)) };
}

const typeRule = (field: HTMLElement, text: string) => {
  fireEvent.change(field, { target: { value: text } });
  fireEvent.keyDown(field, { key: 'Enter' });
};

describe('PermissionsSection', () => {
  it("shows each layer's lists and writes a whole list when a rule is added or removed", async () => {
    const { sync, settingsCall } = syncFor((method, params) => {
      if (method === 'settings.setRules' && (params.rules as string[]).includes('Bash(rm')) {
        return new Error('Invalid permission rule "Bash(rm": missing closing parenthesis');
      }
      return view();
    });
    render(
      <SyncProvider sync={sync}>
        <PermissionsSection workspaceId="w1" projectName="proj" />
      </SyncProvider>,
    );
    const yours = await screen.findByRole('region', { name: 'Yours' });
    expect(within(yours).getByRole('list', { name: 'Yours: Allow' }).textContent).toBe('Bash(npm test:*)');

    typeRule(within(yours).getByRole('textbox', { name: 'Add to Yours: Deny' }), 'Bash(git push:*)');
    expect(settingsCall).toHaveBeenLastCalledWith('settings.setRules', {
      workspaceId: 'w1',
      scope: 'user',
      list: 'deny',
      rules: ['Bash(git push:*)'],
    });

    const project = screen.getByRole('region', { name: 'This project' });
    fireEvent.click(within(project).getByRole('button', { name: 'Remove Write(dist/**)' }));
    expect(settingsCall).toHaveBeenLastCalledWith('settings.setRules', { workspaceId: 'w1', scope: 'project', list: 'deny', rules: [] });

    typeRule(within(project).getByRole('textbox', { name: 'Add to This project: Allow' }), 'Bash(rm');
    expect(await within(project).findByText(/missing closing parenthesis/)).toBeTruthy();
    expect((within(project).getByRole('textbox', { name: 'Add to This project: Allow' }) as HTMLInputElement).value).toBe('Bash(rm');
  });
});

describe('AutoModeSection', () => {
  const denials: SessionDenials[] = [
    {
      sessionId: 's1',
      workspaceId: 'w1',
      paused: true,
      denials: [{ id: 'd1', toolName: 'bash', summary: 'git push --force', reason: 'rewrites history', at: Date.now() }],
    },
  ];

  it('keeps the built-in rules in a group a custom one is added to, and goes back to them', async () => {
    const { sync, settingsCall } = syncFor((method) =>
      method === 'autoMode.denials' ? [] : view({ autoMode: { ...view().autoMode, rules: { hard_deny: ['$defaults', 'Prod: no'] } } }),
    );
    render(
      <SyncProvider sync={sync}>
        <AutoModeSection workspaceId="w1" />
      </SyncProvider>,
    );
    const environment = await screen.findByRole('group', { name: 'Environment' });
    expect(within(environment).getByText('The built-in rules (1)')).toBeTruthy();
    expect(within(environment).queryByRole('button', { name: /Built-ins only/ })).toBeNull();
    typeRule(within(environment).getByRole('textbox'), 'Trusted repo: github.com/acme/app');
    expect(settingsCall).toHaveBeenLastCalledWith('settings.setAutoMode', {
      workspaceId: 'w1',
      group: 'environment',
      rules: ['$defaults', 'Trusted repo: github.com/acme/app'],
    });

    const hard = screen.getByRole('group', { name: 'Hard deny' });
    expect(within(hard).getByText('Prod:')).toBeTruthy();
    fireEvent.click(within(hard).getByRole('button', { name: /Built-ins only/ }));
    expect(settingsCall).toHaveBeenLastCalledWith('settings.setAutoMode', { workspaceId: 'w1', group: 'hard_deny', rules: null });
  });

  it("lists what was refused in the open sessions, and allows a retry", async () => {
    useAppStore.setState({
      sessions: [{ id: 's1', workspaceId: 'w1', title: 'ship it', mtimeMs: 0, live: true, running: false, pending: false, pinned: false, archived: false, rev: 1 }],
    });
    const { sync, settingsCall } = syncFor((method) =>
      method === 'autoMode.denials' ? denials : method === 'session.retryDenied' ? undefined : view({ autoMode: { ...view().autoMode, unavailable: 'no classifier' } }),
    );
    render(
      <SyncProvider sync={sync}>
        <AutoModeSection workspaceId="w1" />
      </SyncProvider>,
    );
    const refused = await screen.findByRole('region', { name: 'Refused' });
    expect(await within(refused).findByText('ship it')).toBeTruthy();
    expect(within(refused).getByText('paused')).toBeTruthy();
    expect(screen.getByText(/isn’t available in this project: no classifier/)).toBeTruthy();
    await act(async () => fireEvent.click(within(refused).getByRole('button', { name: 'Allow a retry' })));
    expect(settingsCall).toHaveBeenCalledWith('session.retryDenied', { id: 's1', denialId: 'd1' });
    expect(within(refused).getByText('Retry allowed')).toBeTruthy();
  });
});

describe('MemorySection', () => {
  const memory: MemoryView = {
    instructions: [
      { scope: 'user', name: 'AGENTS.md', path: '/home/me/.agent/AGENTS.md' },
      { scope: 'project', name: 'CLAUDE.md', path: '/p/CLAUDE.md', bytes: 120 },
    ],
    memories: [
      { scope: 'project', path: 'feedback/no-mocks.md', name: 'no mocks', description: 'real database in tests', type: 'feedback', bytes: 90 },
      { scope: 'global', path: 'reference/broken.md', name: 'broken', description: '', type: 'reference', bytes: 9, problem: 'missing description' },
    ],
    dirs: { global: '/home/me/.agent/memory', project: '/p/.agent/memory' },
  };

  it('opens a file to edit in place, and deletes a memory on the second click', async () => {
    const { sync, settingsCall } = syncFor((method) => (method === 'memory.read' ? { text: '# rules\n' } : memory));
    render(
      <SyncProvider sync={sync}>
        <MemorySection workspaceId="w1" projectName="proj" />
      </SyncProvider>,
    );
    const instructions = await screen.findByRole('region', { name: 'Instructions' });
    expect(within(instructions).getByText('not written yet')).toBeTruthy();
    fireEvent.click(within(instructions).getByRole('button', { name: /Edit/ }));
    const field = (await screen.findByDisplayValue('# rules')) as HTMLTextAreaElement;
    expect(settingsCall).toHaveBeenCalledWith('memory.read', {
      workspaceId: 'w1',
      target: { kind: 'instructions', scope: 'project', name: 'CLAUDE.md' },
    });
    fireEvent.change(field, { target: { value: '# rules\nBe brief.\n' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(settingsCall).toHaveBeenCalledWith('memory.write', {
      workspaceId: 'w1',
      target: { kind: 'instructions', scope: 'project', name: 'CLAUDE.md' },
      text: '# rules\nBe brief.\n',
    });
    expect(screen.queryByRole('textbox', { name: 'File text' })).toBeNull();

    expect(screen.getByText(/Sessions skip it: missing description/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete no mocks' }));
    expect(settingsCall).not.toHaveBeenCalledWith('memory.delete', expect.anything());
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Confirm deleting no mocks' })));
    expect(settingsCall).toHaveBeenCalledWith('memory.delete', {
      workspaceId: 'w1',
      target: { kind: 'memory', scope: 'project', path: 'feedback/no-mocks.md' },
    });
  });
});

describe('McpSection', () => {
  const mcp = (signedIn: boolean): McpView => ({
    servers: [
      { name: 'linear', scope: 'user', transport: 'http', target: 'https://mcp.linear.app/mcp', auth: 'oauth', signedIn },
      { name: 'files', scope: 'project', transport: 'stdio', target: 'npx mcp-files', auth: 'none' },
    ],
    userPath: '/home/me/.agent/.mcp.json',
    projectPath: '/p/.mcp.json',
    problems: [],
  });

  it('signs in in a new tab, waits, and reads the list again when the sign-in ends', async () => {
    let signedIn = false;
    const open = vi.spyOn(platform, 'openExternal').mockImplementation(() => {});
    const { sync, settingsCall, push } = syncFor((method) =>
      method === 'mcp.login' ? { url: 'https://mcp.linear.app/authorize?x=1' } : mcp(signedIn),
    );
    render(
      <SyncProvider sync={sync}>
        <McpSection workspaceId="w1" />
      </SyncProvider>,
    );
    const signIn = await screen.findByRole('button', { name: 'Sign in' });
    await act(async () => fireEvent.click(signIn));
    expect(settingsCall).toHaveBeenCalledWith('mcp.login', { workspaceId: 'w1', name: 'linear' });
    expect(open).toHaveBeenCalledWith('https://mcp.linear.app/authorize?x=1');
    expect(screen.getByText('waiting for the browser')).toBeTruthy();

    signedIn = true;
    await act(async () => push({ type: 'mcp_login', workspaceId: 'w1', name: 'linear' }));
    expect(await screen.findByText('signed in')).toBeTruthy();
    expect(screen.queryByText('waiting for the browser')).toBeNull();
  });

  it('says why a sign-in failed', async () => {
    vi.spyOn(platform, 'openExternal').mockImplementation(() => {});
    const { sync, push } = syncFor((method) => (method === 'mcp.login' ? { url: 'https://a/authorize' } : mcp(false)));
    render(
      <SyncProvider sync={sync}>
        <McpSection workspaceId="w1" />
      </SyncProvider>,
    );
    const signIn = await screen.findByRole('button', { name: 'Sign in' });
    await act(async () => fireEvent.click(signIn));
    await act(async () => push({ type: 'mcp_login', workspaceId: 'w1', name: 'linear', error: 'timed out waiting for the OAuth redirect' }));
    expect(await screen.findByText('timed out waiting for the OAuth redirect')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});

describe('ToolsSection', () => {
  it('turns background commands on in your settings', async () => {
    const { sync, settingsCall } = syncFor((method, params) =>
      method === 'settings.setBackgroundProcesses'
        ? view({ backgroundProcesses: { user: params.enabled as boolean, project: false } })
        : view(),
    );
    render(
      <SyncProvider sync={sync}>
        <ToolsSection workspaceId="w1" />
      </SyncProvider>,
    );
    const toggle = await screen.findByRole('switch', { name: 'Background commands' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => fireEvent.click(toggle));
    expect(settingsCall).toHaveBeenLastCalledWith('settings.setBackgroundProcesses', { workspaceId: 'w1', enabled: true });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });
});

describe('ModelsSection', () => {
  const providers = (over: Partial<ProvidersView> = {}): ProvidersView => ({
    providers: [
      { id: 'dashscope', label: 'Alibaba DashScope (Qwen)', baseUrl: 'https://dashscope.aliyuncs.com/v1', requiresKey: true, keyVar: 'DASHSCOPE_API_KEY' },
      { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', requiresKey: true, keyVar: 'DEEPSEEK_API_KEY' },
      { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', requiresKey: false },
      {
        id: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        requiresKey: true,
        keyVar: 'OPENAI_API_KEY',
        keySource: 'environment',
        keySourceVar: 'OPENAI_API_KEY',
      },
    ],
    envPath: '/home/me/.agent/.env',
    model: 'deepseek/deepseek-flash',
    settingsPath: '/home/me/.agent/settings.json',
    problems: [],
    ...over,
  });
  const withKey = (id: string): ProvidersView => {
    const view = providers();
    return { ...view, providers: view.providers.map((p) => (p.id === id ? { ...p, keySource: 'user', keySourceVar: p.keyVar! } : p)) };
  };
  const row = (label: string): HTMLElement => screen.getByText(label).closest('li') as HTMLElement;

  it("lists the providers — the default model's first — with where each key comes from, and saves, replaces and removes one", async () => {
    let current = providers();
    const { sync, settingsCall } = syncFor((method, params) => {
      if (method === 'providers.setKey') current = params.key === null ? providers() : withKey(params.provider as string);
      return current;
    });
    render(
      <SyncProvider sync={sync}>
        <ModelsSection workspaceId="w1" />
      </SyncProvider>,
    );
    await screen.findByText('DeepSeek');
    const labels = within(screen.getByLabelText('Providers')).getAllByRole('listitem').map((li) => li.querySelector('span')?.textContent);
    expect(labels).toEqual(['DeepSeek', 'OpenAI', 'Alibaba DashScope (Qwen)', 'Ollama']);
    expect(within(row('DeepSeek')).getByText('no key')).toBeTruthy();
    expect(within(row('Ollama')).getByText('needs no key')).toBeTruthy();
    expect(within(row('Ollama')).queryByRole('button')).toBeNull();
    // One from the environment is used before any saved here: nothing to add.
    expect(within(row('OpenAI')).getByText('key from the environment · OPENAI_API_KEY')).toBeTruthy();
    expect(within(row('OpenAI')).queryByRole('button')).toBeNull();
    expect(screen.getByText('DeepSeek has no key yet: give it one below.')).toBeTruthy();

    fireEvent.click(within(row('DeepSeek')).getByText('Add key'));
    const field = within(row('DeepSeek')).getByLabelText('DeepSeek API key') as HTMLInputElement;
    expect(field.type).toBe('password');
    fireEvent.change(field, { target: { value: 'sk-test-key' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(settingsCall).toHaveBeenCalledWith('providers.setKey', { workspaceId: 'w1', provider: 'deepseek', key: 'sk-test-key' });
    expect(within(row('DeepSeek')).getByText('key saved')).toBeTruthy();
    expect(within(row('DeepSeek')).queryByLabelText('DeepSeek API key')).toBeNull();
    expect(document.body.textContent).not.toContain('sk-test-key');
    expect(screen.queryByText('DeepSeek has no key yet: give it one below.')).toBeNull();
    expect(sync.loadModels).toHaveBeenCalledWith('w1'); // the pickers read what they offer again

    expect(within(row('DeepSeek')).getByText('Replace')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(row('DeepSeek')).getByText('Remove'));
    });
    expect(settingsCall).toHaveBeenCalledWith('providers.setKey', { workspaceId: 'w1', provider: 'deepseek', key: null });
    expect(within(row('DeepSeek')).getByText('no key')).toBeTruthy();
  });

  it('sets the model new sessions start on, says where it is set, and shows a refusal', async () => {
    let current = providers();
    const { sync, settingsCall } = syncFor((method, params) => {
      if (method === 'providers.setModel') {
        if (params.model === 'nowhere/m') return new Error('Unknown provider "nowhere".');
        current = params.model === '' ? providers() : providers({ model: params.model as string, modelSource: 'user' });
      }
      return current;
    });
    render(
      <SyncProvider sync={sync}>
        <ModelsSection workspaceId="w1" />
      </SyncProvider>,
    );
    const field = (await screen.findByLabelText('Model for new sessions')) as HTMLInputElement;
    expect(field.value).toBe('deepseek/deepseek-flash');
    expect(screen.getByText(/The built-in default\./)).toBeTruthy();

    fireEvent.change(field, { target: { value: 'nowhere/m' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(screen.getByText('Unknown provider "nowhere".')).toBeTruthy();

    fireEvent.change(field, { target: { value: 'openai/gpt-test' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    expect(settingsCall).toHaveBeenCalledWith('providers.setModel', { workspaceId: 'w1', model: 'openai/gpt-test' });
    expect(field.value).toBe('openai/gpt-test');
    expect(screen.getByText(/From your settings, for every project\./)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText('Reset'));
    });
    expect(settingsCall).toHaveBeenCalledWith('providers.setModel', { workspaceId: 'w1', model: '' });
    expect(field.value).toBe('deepseek/deepseek-flash');
  });
});
