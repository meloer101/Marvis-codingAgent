import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { alwaysAllowFor } from './always-allow.js';
import { createPermissionEngine } from './engine.js';

const bash = (command: string) => alwaysAllowFor('bash', { command });

describe('alwaysAllowFor: bash', () => {
  it.each([
    ['pytest -x tests/', 'Bash(pytest:*)', '`pytest` commands'],
    ['npm test 2>&1 | tail -5', 'Bash(npm test:*)', '`npm test` commands'],
    ['git push origin main', 'Bash(git push:*)', '`git push` commands'],
    ['pnpm run build --watch', 'Bash(pnpm run build:*)', '`pnpm run build` commands'],
    ['npx vitest run src/a.test.ts', 'Bash(npx vitest:*)', '`npx vitest` commands'],
    ['python scripts/gen.py --fast', 'Bash(python scripts/gen.py:*)', '`python scripts/gen.py` commands'],
    ['python3 -m pytest -q', 'Bash(python3 -m pytest:*)', '`python3 -m pytest` commands'],
    ['./scripts/build.sh release', 'Bash(./scripts/build.sh:*)', '`./scripts/build.sh` commands'],
    ['NODE_ENV=test npm test', 'Bash(NODE_ENV=test npm test:*)', '`NODE_ENV=test npm test` commands'],
  ])('%s → a prefix rule', (command, rule, label) => {
    expect(bash(command)).toEqual({ rules: [rule], label });
  });

  it.each([
    // A prefix would reach any target, host, or command; only the exact one.
    ['rm -rf build', 'Bash(rm -rf build)'],
    ['curl -s https://api.github.com/repos/x/y', 'Bash(curl -s https://api.github.com/repos/x/y)'],
    ['time npm test', 'Bash(time npm test)'],
    // `git -C dir …` and `docker exec -it …`: no plain subcommand to key on.
    ['git -C packages/web status', 'Bash(git -C packages/web status)'],
    ['docker exec -it web sh', 'Bash(docker exec -it web sh)'],
    ['node --test', 'Bash(node --test)'],
  ])('%s → only the exact command', (command, rule) => {
    expect(bash(command)?.rules).toEqual([rule]);
  });

  it('names each segment that needed approval, and not the read-only ones riding along', () => {
    expect(bash('cd packages/web && pnpm build | tail -3')).toEqual({
      rules: ['Bash(cd packages/web)', 'Bash(pnpm build:*)'],
      label: '`cd packages/web` and `pnpm build` commands',
    });
  });

  it('covers a read-only command too when an ask rule forced the prompt', () => {
    expect(bash('git log --oneline')?.rules).toEqual(['Bash(git log:*)']);
  });

  it.each([
    ['find . -name "*.tmp" | xargs rm', 'xargs takes its commands from stdin'],
    ['sudo apt-get install jq', 'sudo'],
    ['bash scripts/run.sh', 'a shell runs anything it is handed'],
    ['python -c "print(1)"', 'inline code is unreviewable, so no allow rule would apply'],
    ['cat <<EOF > a.txt\nhi\nEOF', 'a heredoc is unreviewable'],
    ['for f in *.ts; do wc -l $f; done', 'a loop'],
    ['rm -f *.log', 'an exact rule cannot say a literal `*`'],
    ['a && b && c && d', 'more rules than fit in the option'],
  ])('%s → none (%s)', (command) => {
    expect(bash(command)).toBeUndefined();
  });
});

describe('alwaysAllowFor: other tools', () => {
  it('allows a fetch host, not every URL', () => {
    expect(alwaysAllowFor('webfetch', { url: 'https://Docs.Example.com/a?b=1' })).toEqual({
      rules: ['WebFetch(domain:docs.example.com)'],
      label: 'fetches from docs.example.com',
    });
    expect(alwaysAllowFor('webfetch', { url: 'not a url' })).toBeUndefined();
  });

  it('keeps the whole tool for edits and MCP tools', () => {
    expect(alwaysAllowFor('edit', { path: 'a.ts' })).toEqual({ rules: ['Edit'], label: 'Edit' });
    expect(alwaysAllowFor('mcp__linear__create_issue', {})?.rules).toEqual(['mcp__linear__create_issue']);
  });
});

describe('alwaysAllowFor: the rules it adds, in the engine', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hc-always-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const decide = async (rules: string[], command: string) => {
    const engine = createPermissionEngine({ workspaceRoot: root, mode: 'ask', allow: [], ask: [], deny: [] });
    for (const rule of rules) engine.addAllowRule(rule);
    return (await engine.evaluate({ toolName: 'bash', input: { command }, readOnly: false })).decision;
  };

  it('stops asking for the approved kind of command, and only that kind', async () => {
    const { rules } = bash('npm test 2>&1 | tail -5')!;
    expect(await decide([], 'npm test')).toBe('ask');
    expect(await decide(rules, 'npm test -- --watch=false')).toBe('allow');
    expect(await decide(rules, 'npm test | tail -20')).toBe('allow');
    expect(await decide(rules, 'npm publish')).toBe('ask');
    expect(await decide(rules, 'python scripts/x.py')).toBe('ask');
  });

  it('an exact rule covers that command again and nothing more', async () => {
    const { rules } = bash('cd packages/web && pnpm build')!;
    expect(await decide(rules, 'cd packages/web && pnpm build --mode dev')).toBe('allow');
    expect(await decide(rules, 'cd .git && pnpm build')).toBe('ask');
  });
});
