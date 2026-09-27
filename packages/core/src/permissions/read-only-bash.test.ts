import { describe, expect, it } from 'vitest';

import { inspectBash } from './bash-ast.js';
import { isReadOnlyBashCommand } from './read-only-bash.js';

function check(command: string): boolean {
  const inspected = inspectBash(command);
  if (inspected.hardDenyReason) return false;
  return isReadOnlyBashCommand(inspected.segments, { hasWriteRedirect: inspected.hasWriteRedirect });
}

describe('isReadOnlyBashCommand', () => {
  it('allows the byte-inspection and comparison tools agents verify with', () => {
    for (const cmd of [
      'od -c out.csv',
      'xxd out.csv',
      'xxd -l 64 -s 16 a.bin',
      'hexdump -C a.bin',
      'cmp a b',
      'diff -u a b',
      'sort -n data.txt',
      'uniq -c sorted.txt',
      'cut -d, -f1 a.csv',
      'jq .name package.json',
      'sha256sum a.tar',
      'date +%s',
      '[ -f a.txt ]',
      'tail -c 20 out.csv | od -c',
    ]) {
      expect(check(cmd), cmd).toBe(true);
    }
  });

  it('refuses the argument forms of those tools that write or change state', () => {
    for (const cmd of [
      'sort -o sorted.txt data.txt',
      'sort --output=sorted.txt data.txt',
      'xxd -r dump.hex out.bin',
      'xxd in.bin out.hex',
      'uniq in.txt out.txt',
      'date -s "2020-01-01"',
      'env rm -rf x',
      'cd .git && cat config',
    ]) {
      expect(check(cmd), cmd).toBe(false);
    }
  });


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

  it('rejects flags that make a listed binary write files or run programs', () => {
    expect(check('rg --pre=sh foo .')).toBe(false);
    expect(check('rg --pre sh foo .')).toBe(false);
    expect(check('rg --pretty foo')).toBe(true);
    expect(check('find . -fprint out.txt')).toBe(false);
    expect(check('find . -fprintf out.txt %p')).toBe(false);
    expect(check('find . -fls out.txt')).toBe(false);
    expect(check('git diff --output=src/x.ts')).toBe(false);
    expect(check('git log --output out.txt')).toBe(false);
    expect(check('git diff --ext-diff')).toBe(false);
    expect(check('tree -o out.txt')).toBe(false);
    expect(check('tree -aR -H . -L 1')).toBe(false);
    expect(check('tree -a -L 2')).toBe(true);
    expect(check('file -C -m magic')).toBe(false);
    expect(check('file --compile')).toBe(false);
  });

  it('rejects write redirects and mixed pipelines', () => {
    expect(check('echo hi > out.txt')).toBe(false);
    expect(check('echo hi >& .git/hooks/pre-commit')).toBe(false);
    expect(check('ls 2>&1')).toBe(true);
    expect(check('ls | wc -l')).toBe(true);
    expect(check('ls | rm -rf ./tmp')).toBe(false);
  });
});
