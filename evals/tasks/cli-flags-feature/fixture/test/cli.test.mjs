import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/logq.js', import.meta.url));
const sample = fileURLToPath(new URL('../examples/events.jsonl', import.meta.url));

function logq(...args) {
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const rows = (stdout) => stdout.trimEnd().split('\n').slice(1);

describe('logq', () => {
  it('prints every event as a table', () => {
    const { code, stdout } = logq(sample);
    assert.equal(code, 0);
    assert.match(stdout.split('\n')[0], /^TIME \(UTC\)\s+LEVEL\s+SERVICE\s+MESSAGE$/);
    assert.equal(rows(stdout).length, 22);
    assert.equal(rows(stdout)[0], '2026-09-01 07:58:12  INFO   api       server listening on :8080');
  });

  it('--level keeps that level and above', () => {
    const { code, stdout } = logq(sample, '--level', 'warn');
    assert.equal(code, 0);
    assert.equal(rows(stdout).length, 8);
    assert.ok(rows(stdout).every((row) => /\s(WARN|ERROR)\s/.test(row)));
  });

  it('--svc keeps one service', () => {
    const { stdout } = logq('--svc', 'billing', sample);
    assert.equal(rows(stdout).length, 5);
    assert.ok(rows(stdout).every((row) => row.includes(' billing ')));
  });

  it('--level and --svc combine in any order', () => {
    const a = logq(sample, '--level', 'warn', '--svc', 'worker');
    const b = logq('--svc', 'worker', sample, '--level', 'warn');
    assert.equal(rows(a.stdout).length, 4);
    assert.equal(a.stdout, b.stdout);
  });

  it('rejects an unknown level with exit code 2', () => {
    const { code, stdout, stderr } = logq(sample, '--level', 'fatal');
    assert.equal(code, 2);
    assert.equal(stdout, '');
    assert.match(stderr, /unknown level "fatal"/);
  });

  it('rejects an option without its value', () => {
    const { code, stderr } = logq(sample, '--svc');
    assert.equal(code, 2);
    assert.match(stderr, /--svc needs a value/);
  });

  it('rejects an unknown option', () => {
    const { code } = logq(sample, '--color');
    assert.equal(code, 2);
  });

  it('exits 1 when the file cannot be read', () => {
    const { code, stderr } = logq('does-not-exist.jsonl');
    assert.equal(code, 1);
    assert.match(stderr, /cannot read does-not-exist\.jsonl/);
  });
});
