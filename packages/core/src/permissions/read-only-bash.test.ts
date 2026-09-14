import { describe, expect, it } from 'vitest';

import { inspectBash } from './bash-ast.js';
import { isReadOnlyBashCommand } from './read-only-bash.js';

function check(command: string): boolean {
  const inspected = inspectBash(command);
  if (inspected.hardDenyReason) return false;
  return isReadOnlyBashCommand(inspected.segments, { hasWriteRedirect: inspected.hasWriteRedirect });
}

describe('isReadOnlyBashCommand', () => {
  it('allows the listed read-only utilities', () => {
    for (const cmd of [
      'ls',
      'cat README.md',
      'head -n 20 a.ts',
      'tail -n 5 a.ts',
      'wc -l a.ts',
      'pwd',
      'echo hi',
      'which node',
      'file a.ts',
      'stat a.ts',
      'du -sh .',
      'df -h',
      'tree -L 2',
      'rg TODO',
      'grep foo a.ts',
    ]) {
      expect(check(cmd), cmd).toBe(true);
    }
  });

  it('allows find without -exec or -delete, and git read-only subcommands', () => {
    expect(check('find . -name "*.ts"')).toBe(true);
    expect(check('find . -delete')).toBe(false);
    expect(check('find . -exec rm {} ;')).toBe(false);
    expect(check('git status')).toBe(true);
    expect(check('git log --oneline')).toBe(true);
    expect(check('git diff')).toBe(true);
    expect(check('git show HEAD')).toBe(true);
    expect(check('git branch')).toBe(true);
    expect(check('git rev-parse HEAD')).toBe(true);
    expect(check('git remote -v')).toBe(true);
    expect(check('git push')).toBe(false);
    expect(check('git branch new-feature')).toBe(false);
    expect(check('git remote add origin git@x')).toBe(false);
  });

  it('rejects write redirects and mixed pipelines', () => {
    expect(check('echo hi > out.txt')).toBe(false);
    expect(check('ls | wc -l')).toBe(true);
    expect(check('ls | rm -rf ./tmp')).toBe(false);
  });
});
