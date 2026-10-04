import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { agentsView, deleteAgent, getAgent, saveAgent, writeAgent } from './agents.js';
import { ConflictError, InvalidRequestError } from './host.js';

let home: string;
let place: { projectRoot: string; home: string };
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'hc-agents-')));
  place = { projectRoot: join(home, 'repo'), home };
  await mkdir(place.projectRoot);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const agent = (name: string, extra = '', body = 'Do the job, then report.'): string =>
  `---\nname: ${name}\ndescription: What ${name} is for\n${extra}---\n\n${body}\n`;

async function put(dir: string, name: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), text);
}

const projectDir = (): string => join(place.projectRoot, '.agent', 'agents');
const userDir = (): string => join(home, '.agent', 'agents');

describe('sub-agents', () => {
  it("lists the project's, yours and the built-in ones — the first of a name used — those skipped, and the tools one can have", async () => {
    await put(projectDir(), 'explore', agent('explore', 'tools: read grep\nmodel: deepseek/deepseek-chat\neffort: low\n'));
    await put(userDir(), 'Bad', agent('Bad'));
    await put(userDir(), 'empty', '---\nname: empty\ndescription: d\n---\n');
    const view = await agentsView(place);
    expect(view.agents.filter((a) => a.scope !== 'builtin')).toEqual([
      {
        name: 'explore',
        scope: 'project',
        path: join(projectDir(), 'explore.md'),
        description: 'What explore is for',
        tools: ['read', 'grep'],
        model: 'deepseek/deepseek-chat',
        effort: 'low',
      },
      { name: 'Bad', scope: 'user', path: join(userDir(), 'Bad.md'), description: '', problem: expect.stringMatching(/lowercase/) },
      { name: 'empty', scope: 'user', path: join(userDir(), 'empty.md'), description: '', problem: expect.stringMatching(/body/) },
    ]);
    expect(view.agents.find((a) => a.scope === 'builtin' && a.name === 'explore')?.shadowed).toBe(true);
    expect(view.agents.find((a) => a.scope === 'builtin' && a.name === 'plan')?.shadowed).toBeUndefined();
    expect(view.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['read', 'grep', 'bash', 'write']));
    expect(view.tools.find((t) => t.name === 'read')?.readOnly).toBe(true);
    expect(view.tools.some((t) => t.name === 'task')).toBe(false);
    expect(view.efforts).toContain('high');
  });

  it('reads a file, with what it says when it parses — a built-in one too', async () => {
    const plan = await getAgent(place, 'builtin', 'plan');
    expect(plan.fields).toMatchObject({ tools: ['read', 'glob', 'grep'], body: expect.stringContaining('implementation plan') });
    await put(userDir(), 'broken', '---\nname: other\n---\nx');
    expect(await getAgent(place, 'user', 'broken')).toEqual({ text: '---\nname: other\n---\nx' });
    await expect(getAgent(place, 'user', 'nope')).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it('writes a new one from its fields, and refuses a second of the name', async () => {
    const fields = { description: 'Scout the code', tools: ['read', 'grep'], effort: 'low', body: 'Look, then report.' };
    await saveAgent(place, 'user', 'scout', fields);
    expect(await readFile(join(userDir(), 'scout.md'), 'utf8')).toBe(
      '---\nname: scout\ndescription: Scout the code\ntools: read grep\neffort: low\n---\n\nLook, then report.\n',
    );
    await expect(saveAgent(place, 'user', 'scout', fields)).rejects.toBeInstanceOf(ConflictError);
    await expect(saveAgent(place, 'user', 'blank', { ...fields, body: '  ' })).rejects.toThrow(/body/);
    await expect(saveAgent(place, 'user', 'odd', { ...fields, effort: 'extreme' })).rejects.toThrow(/effort must be/);
    expect(await readdir(userDir())).toEqual(['scout.md']);
  });

  it('changes one in place — renamed when asked — keeping what else its frontmatter had', async () => {
    await put(projectDir(), 'scout', agent('scout', 'color: blue\ntools: Read, Grep\n'));
    await put(projectDir(), 'taken', agent('taken'));
    const { fields } = await getAgent(place, 'project', 'scout');
    await expect(saveAgent(place, 'project', 'taken', fields!, 'scout')).rejects.toBeInstanceOf(ConflictError);
    await saveAgent(place, 'project', 'finder', { ...fields!, tools: undefined, model: 'deepseek/deepseek-chat' }, 'scout');
    expect((await readdir(projectDir())).sort()).toEqual(['finder.md', 'taken.md']);
    expect(await readFile(join(projectDir(), 'finder.md'), 'utf8')).toBe(
      '---\nname: finder\ndescription: What scout is for\nmodel: deepseek/deepseek-chat\ncolor: blue\n---\n\nDo the job, then report.\n',
    );
  });

  it('writes a file as it is when it parses, and deletes one', async () => {
    await writeAgent(place, 'user', 'raw', agent('raw').trimEnd());
    expect(await readFile(join(userDir(), 'raw.md'), 'utf8')).toBe(agent('raw'));
    await expect(writeAgent(place, 'user', 'raw', agent('other'))).rejects.toThrow(/does not match its file/);
    await deleteAgent(place, 'user', 'raw');
    expect(await readdir(userDir())).toEqual([]);
    await expect(deleteAgent(place, 'user', 'raw')).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(getAgent(place, 'user', '..')).rejects.toBeInstanceOf(InvalidRequestError);
  });
});
