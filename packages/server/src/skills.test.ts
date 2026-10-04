import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConflictError, InvalidRequestError } from './host.js';
import { deleteSkill, gitSource, importSkills, readSkill, skillsView, writeSkill } from './skills.js';

let home: string;
let place: { projectRoot: string; home: string };
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'hc-skills-')));
  place = { projectRoot: join(home, 'repo'), home };
  await mkdir(place.projectRoot);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const skill = (name: string, description = `What ${name} does`): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSteps.\n`;

async function put(dir: string, text: string, files: Record<string, string> = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), text);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), content);
  }
}

const mine = async (scope: 'user' | 'project') =>
  (await skillsView(place)).skills.filter((s) => s.scope === scope).map((s) => s.name);

describe('skills', () => {
  it("lists the project's, yours and the built-in ones in that order — the first of a name used — and those skipped", async () => {
    await put(join(place.projectRoot, '.agent', 'skills', 'code-review'), skill('code-review', 'Ours'));
    await put(join(place.projectRoot, '.agent', 'skills', 'Bad_Name'), skill('Bad_Name'));
    await put(join(home, '.agent', 'skills', 'notes'), skill('notes'));
    await mkdir(join(home, '.agent', 'skills', 'empty'), { recursive: true });
    const view = await skillsView(place);
    expect(view.dirs.project).toBe(join(place.projectRoot, '.agent', 'skills'));
    expect(view.skills.filter((s) => s.scope !== 'builtin')).toEqual([
      { name: 'Bad_Name', description: '', scope: 'project', dir: join(view.dirs.project, 'Bad_Name'), problem: expect.stringMatching(/lowercase/) },
      { name: 'code-review', description: 'Ours', scope: 'project', dir: join(view.dirs.project, 'code-review') },
      { name: 'notes', description: 'What notes does', scope: 'user', dir: join(view.dirs.user, 'notes') },
    ]);
    // Marvis's own `code-review` is shadowed by the project's.
    expect(view.skills.find((s) => s.scope === 'builtin' && s.name === 'code-review')?.shadowed).toBe(true);
  });

  it('writes a new one, refuses a second, and an edit that no longer parses', async () => {
    await writeSkill(place, 'user', 'notes', skill('notes'), { create: true });
    expect(await readSkill(place, 'user', 'notes')).toBe(skill('notes'));
    await expect(writeSkill(place, 'user', 'notes', skill('notes'), { create: true })).rejects.toBeInstanceOf(ConflictError);
    await expect(writeSkill(place, 'user', 'notes', skill('other'))).rejects.toThrow(/does not match its directory/);
    await expect(writeSkill(place, 'user', 'notes', '---\nname: notes\n---\n')).rejects.toBeInstanceOf(InvalidRequestError);
    await writeSkill(place, 'user', 'notes', skill('notes', 'Better'));
    expect((await skillsView(place)).skills.find((s) => s.name === 'notes')?.description).toBe('Better');
  });

  it('deletes one, folder and all', async () => {
    await put(join(home, '.agent', 'skills', 'notes'), skill('notes'), { 'scripts/run.sh': 'echo' });
    await deleteSkill(place, 'user', 'notes');
    expect(await mine('user')).toEqual([]);
    await expect(deleteSkill(place, 'user', 'notes')).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(readSkill(place, 'user', '..')).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it('imports a folder that is one skill, under the name it gives itself, with what is beside it', async () => {
    const src = join(home, 'downloads', 'pdf-skill-main');
    await put(src, skill('pdf'), { 'scripts/fill.py': 'print(1)', '.git/HEAD': 'ref', 'node_modules/x/index.js': '' });
    const result = await importSkills(place, 'project', src);
    expect(result).toEqual({ imported: ['pdf'], skipped: [] });
    const dest = join(place.projectRoot, '.agent', 'skills', 'pdf');
    expect((await readdir(dest)).sort()).toEqual(['SKILL.md', 'scripts']);
    expect(await readFile(join(dest, 'scripts', 'fill.py'), 'utf8')).toBe('print(1)');
  });

  it('imports every skill below a folder, skipping those that do not parse, and asks before replacing', async () => {
    const src = join(home, 'collection');
    await put(join(src, 'skills', 'alpha'), skill('alpha'));
    await put(join(src, 'skills', 'beta'), skill('beta'));
    await put(join(src, 'skills', 'broken'), '---\nname: broken\n---\n');
    await put(join(src, 'skills', 'alpha', 'nested'), skill('nested')); // inside a skill: its own business
    const result = await importSkills(place, 'user', src);
    expect(result.imported).toEqual(['alpha', 'beta']);
    expect(result.skipped).toEqual([expect.stringMatching(/^broken: /)]);
    await expect(importSkills(place, 'user', join(src, 'skills', 'beta'))).rejects.toBeInstanceOf(ConflictError);
    await writeFile(join(src, 'skills', 'beta', 'SKILL.md'), skill('beta', 'Newer'));
    await importSkills(place, 'user', join(src, 'skills', 'beta'), { replace: true });
    expect((await skillsView(place)).skills.find((s) => s.name === 'beta')?.description).toBe('Newer');
  });

  it('says why when there is nothing to import', async () => {
    await expect(importSkills(place, 'user', 'relative/path')).rejects.toThrow(/full path/);
    await expect(importSkills(place, 'user', join(home, 'nowhere'))).rejects.toThrow(/no folder/);
    await mkdir(join(home, 'plain'));
    await expect(importSkills(place, 'user', join(home, 'plain'))).rejects.toThrow(/no SKILL\.md/);
    await expect(importSkills(place, 'user', 'file:///tmp/x')).rejects.toThrow(/https/);
    await put(join(home, '.agent', 'skills', 'self'), skill('self'));
    await expect(importSkills(place, 'user', join(home, '.agent', 'skills', 'self'))).rejects.toThrow(/over itself/);
  });

  it('reads what a GitHub URL names', () => {
    expect(gitSource('https://github.com/anthropics/skills')).toEqual({ url: 'https://github.com/anthropics/skills.git', repo: 'skills' });
    expect(gitSource('https://github.com/anthropics/skills/tree/main/skills/pdf')).toEqual({
      url: 'https://github.com/anthropics/skills.git',
      repo: 'skills',
      ref: 'main',
      path: 'skills/pdf',
    });
    expect(gitSource('https://github.com/a/b/blob/dev/x/SKILL.md')).toMatchObject({ ref: 'dev', path: 'x' });
    expect(gitSource('https://gitlab.com/group/thing.git')).toEqual({ url: 'https://gitlab.com/group/thing.git', repo: 'thing' });
    expect(() => gitSource('http://github.com/a/b')).toThrow(/https/);
  });
});
