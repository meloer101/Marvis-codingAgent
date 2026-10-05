import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DoctorCheck, DoctorReport } from '@harness-code/protocol';

import { doctorReport } from './doctor.js';
import type { SettingsPlace } from './settings.js';

const ECHO_SERVER = fileURLToPath(new URL('../../core/src/mcp/__fixtures__/echo-server.mjs', import.meta.url));

let home: string;
let place: SettingsPlace;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'hc-doctor-')));
  const root = join(home, 'repo');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, '.agent'));
  place = { root, projectRoot: root, home, env: {} };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const find = (report: DoctorReport, id: string): DoctorCheck | undefined => report.groups.flatMap((g) => g.checks).find((c) => c.id === id);
const answering = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('doctorReport', () => {
  it('says the default model has no key, pointing at where to add one — without the network', async () => {
    const report = await doctorReport(place);
    expect(report.connected).toBe(false);
    expect(report.groups.map((g) => g.id)).toEqual(['model', 'settings', 'permissions', 'mcp', 'extensions', 'environment']);
    expect(find(report, 'model.default')).toMatchObject({ status: 'ok', detail: expect.stringContaining('the built-in default') });
    expect(find(report, 'model.key')).toMatchObject({ status: 'error', section: 'models', fix: expect.stringContaining('Settings › Models') });
    expect(find(report, 'model.connection')).toBeUndefined();
  });

  it("asks the provider for its models when connecting: the key taken, refused, or the model's name unknown", async () => {
    const keyed: SettingsPlace = { ...place, env: { DEEPSEEK_API_KEY: 'sk-test' } };
    const taken = await doctorReport(keyed, { fetchImpl: answering(200, { data: [{ id: 'deepseek-flash' }] }) }, { connect: true });
    expect(find(taken, 'model.key')).toMatchObject({ status: 'ok', detail: expect.stringContaining('DEEPSEEK_API_KEY') });
    expect(find(taken, 'model.connection')).toMatchObject({ status: 'ok', detail: expect.stringContaining('took the key') });
    expect(JSON.stringify(taken)).not.toContain('sk-test');

    const unknown = await doctorReport(keyed, { fetchImpl: answering(200, { data: [{ id: 'deepseek-chat' }] }) }, { connect: true });
    expect(find(unknown, 'model.connection')).toMatchObject({ status: 'warn', detail: expect.stringContaining('doesn’t list'.replace('’', "'")) });

    const refused = await doctorReport(keyed, { fetchImpl: answering(401, {}) }, { connect: true });
    expect(find(refused, 'model.connection')).toMatchObject({ status: 'error', detail: expect.stringContaining('refused the key') });
  });

  it('names a settings file that does not parse', async () => {
    await mkdir(join(home, '.agent'), { recursive: true });
    await writeFile(join(home, '.agent', 'settings.json'), '{ "model": ');
    await writeFile(join(place.root, '.agent', 'settings.json'), JSON.stringify({ permissions: { mode: 'yolo' } }));
    const report = await doctorReport(place);
    expect(find(report, 'settings.user')).toMatchObject({ status: 'error', detail: expect.stringContaining("doesn't parse") });
    expect(find(report, 'settings.project')).toMatchObject({ status: 'ok' });
  });

  it("finds an MCP server's unset variable and missing command before starting anything, and starts the rest when asked", async () => {
    await writeFile(
      join(place.root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          gh: { command: process.execPath, args: [ECHO_SERVER], env: { TOKEN: '${GITHUB_TOKEN}' } },
          gone: { command: 'no-such-command-anywhere' },
          echo: { command: process.execPath, args: [ECHO_SERVER] },
          // Nothing listens there: a test mustn't reach out.
          remote: { url: 'http://127.0.0.1:9/mcp' },
        },
      }),
    );
    const quick = await doctorReport(place);
    expect(find(quick, 'mcp.project.gh')).toMatchObject({ status: 'warn', detail: expect.stringContaining('${GITHUB_TOKEN}') });
    expect(find(quick, 'mcp.project.gone')).toMatchObject({ status: 'error', detail: expect.stringContaining('on the PATH') });
    expect(find(quick, 'mcp.project.echo')).toMatchObject({ status: 'info', detail: expect.stringContaining('not started') });
    // Whether a URL wants a sign-in only connecting tells (DeepWiki's wants none).
    expect(find(quick, 'mcp.project.remote')).toMatchObject({ status: 'info', detail: expect.stringContaining('not started') });

    const connected = await doctorReport(place, { fetchImpl: answering(401, {}) }, { connect: true });
    expect(find(connected, 'mcp.project.echo')).toMatchObject({ status: 'ok', detail: 'Connected · 1 tool' });
    expect(find(connected, 'mcp.project.remote')).toMatchObject({ status: 'error', fix: 'Edit it in the project’s .mcp.json.' });
  });

  it('says which skills, sub-agents and memories are skipped, and an instruction file too big to give whole', async () => {
    await mkdir(join(place.root, '.agent', 'skills', 'Bad'), { recursive: true });
    await writeFile(join(place.root, '.agent', 'skills', 'Bad', 'SKILL.md'), '---\nname: Bad\ndescription: d\n---\nx');
    await mkdir(join(home, '.agent', 'agents'), { recursive: true });
    await writeFile(join(home, '.agent', 'agents', 'scout.md'), '---\nname: scout\ndescription: d\nmodel: nowhere/x\n---\n\nLook.\n');
    await writeFile(join(place.root, 'AGENTS.md'), 'x'.repeat(50 * 1024));
    const report = await doctorReport(place);
    // The project's own: fixed in its file, not in Settings (which keeps to yours).
    expect(find(report, 'skills.project.Bad')).toMatchObject({ status: 'warn', fix: expect.stringMatching(/Bad\/SKILL\.md/) });
    expect(find(report, 'skills.project.Bad')?.section).toBeUndefined();
    expect(find(report, 'agents.model.scout')).toMatchObject({ status: 'error', detail: expect.stringContaining('no provider') });
    expect(find(report, 'memory.large.project.AGENTS.md')).toMatchObject({ status: 'warn', detail: expect.stringContaining('50 KB') });
  });

  it('looks at the machine: Node, git, whether the project is a repository, and what the server says it has', async () => {
    const report = await doctorReport(place, { terminals: async () => false, folderPicker: async () => true, editors: async () => ['VS Code'], stateDir: join(home, '.agent', 'projects', 'x') });
    expect(find(report, 'env.node')?.status).toBe('ok');
    expect(find(report, 'env.git')?.status).toBe('ok');
    expect(find(report, 'env.terminal')).toMatchObject({ status: 'warn' });
    expect(find(report, 'env.editors')).toMatchObject({ detail: 'Files open in VS Code' });
    expect(find(report, 'env.state')).toMatchObject({ detail: '~/.agent/projects/x' });
  });
});
