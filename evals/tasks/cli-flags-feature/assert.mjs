import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

// Hidden end-state check for `logq --since` / `--json`, run on an unseen log in a
// non-UTC timezone: date-only means UTC midnight, the boundary event is kept,
// relative spans count back from LOGQ_NOW (or the real clock), bad values exit 2
// with nothing on stdout, --json echoes the original events in order, and both
// flags combine with --level / --svc in any order.

const FIXTURE_TEST_COUNT = 8;

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const bin = resolve('bin/logq.js');
if (!existsSync(bin)) fail('bin/logq.js is missing');

const dir = mkdtempSync(join(tmpdir(), 'logq-assert-'));
const baseEnv = { ...process.env, TZ: 'Asia/Shanghai' };
delete baseEnv.LOGQ_NOW;
delete baseEnv.NODE_TEST_CONTEXT;

const show = (args) => args.map((a) => (a.startsWith(dir) ? a.slice(dir.length + 1) : a)).join(' ');

function logq(args, now) {
  const env = now ? { ...baseEnv, LOGQ_NOW: now } : baseEnv;
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env, timeout: 10_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Mixed timestamp precision on purpose: --json must echo `ts` as written.
const E = (ts, level, svc, msg, extra = {}) => ({ ts, level, svc, msg, ...extra });
const events = [
  E('2026-08-25T11:59:59.999Z', 'info', 'api', 'weekly report requested', { reqId: 'r-100' }),
  E('2026-08-25T12:00:00Z', 'warn', 'worker', 'weekly report slow', { durationMs: 8123 }),
  E('2026-08-31T00:00:00.000Z', 'info', 'billing', 'daily rollup started'),
  E('2026-08-31T15:59:59.999Z', 'debug', 'api', 'cache warmed'),
  E('2026-08-31T16:00:00.000Z', 'warn', 'api', 'slow query on orders', { durationMs: 2210 }),
  E('2026-08-31T20:30:00Z', 'error', 'worker', 'job sync-44 crashed', { jobId: 'sync-44' }),
  E('2026-08-31T23:59:59.999Z', 'info', 'billing', 'invoice batch queued', { batch: 17 }),
  E('2026-09-01T00:00:00.000Z', 'info', 'billing', 'invoice batch sent', { batch: 17 }),
  E('2026-09-01T00:00:00.001Z', 'warn', 'api', 'retrying webhook delivery', { attempt: 2 }),
  E('2026-09-01T08:00:00Z', 'info', 'worker', 'queue drained'),
  E('2026-09-01T09:59:59.999Z', 'error', 'api', 'payment provider 503', { reqId: 'r-311' }),
  E('2026-09-01T10:00:00Z', 'warn', 'billing', 'refund needs review', { refundId: 'rf-9' }),
  E('2026-09-01T10:00:00.001Z', 'info', 'api', 'GET /orders 200', { durationMs: 12 }),
  E('2026-09-01T09:30:00Z', 'info', 'worker', 'late flush from worker-3', { host: 'worker-3' }),
  E('2026-09-01T11:30:00.000Z', 'error', 'billing', 'ledger mismatch', { delta: -4.5 }),
  E('2026-09-01T11:59:59Z', 'debug', 'worker', 'heartbeat'),
  E('2026-09-01T12:00:00.000Z', 'info', 'api', 'deploy finished', { version: '2026.09.1', tags: ['canary', 'eu'] }),
];
const logFile = join(dir, 'app.jsonl');
writeFileSync(logFile, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);

const since = (iso) => (e) => Date.parse(e.ts) >= Date.parse(iso);
const level = (min) => {
  const rank = { debug: 0, info: 1, warn: 2, error: 3 };
  return (e) => rank[e.level] >= rank[min];
};
const svc = (name) => (e) => e.svc === name;
const pick = (...preds) => events.filter((e) => preds.every((p) => p(e)));

function jsonLines(label, stdout) {
  const lines = stdout.split('\n').filter((l) => l.trim() !== '');
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      fail(`${label}: stdout line is not JSON: ${JSON.stringify(line.slice(0, 120))}`);
    }
  }
  return out;
}

function expectJson(args, want, now) {
  const label = `${now ? `LOGQ_NOW=${now} ` : ''}logq ${show(args)}`;
  const r = logq(args, now);
  if (r.code !== 0) fail(`${label}: exit ${r.code}, stderr: ${r.stderr.trim().split('\n')[0]}`);
  const got = jsonLines(label, r.stdout);
  if (!isDeepStrictEqual(got, want)) {
    const ts = (xs) => JSON.stringify(xs.map((e) => e?.ts));
    fail(`${label}: printed ${got.length} events ${ts(got)}, want ${want.length} ${ts(want)}${isDeepStrictEqual(got.map((e) => e?.ts), want.map((e) => e.ts)) ? ' (same events, but fields differ from the original)' : ''}`);
  }
}

const NOW = '2026-09-01T12:00:00Z';
const F = logFile;

// --json alone: every event, unchanged, in file order.
expectJson([F, '--json'], events);
// Absolute: date-only is UTC midnight (TZ is Asia/Shanghai here), boundary included.
expectJson(['--since', '2026-09-01', F, '--json'], pick(since('2026-09-01T00:00:00Z')));
expectJson(['--json', '--since', '2026-08-31', F], pick(since('2026-08-31T00:00:00Z')));
expectJson([F, '--since', '2026-09-01T10:00:00Z', '--json'], pick(since('2026-09-01T10:00:00Z')));
// Relative spans count back from LOGQ_NOW; boundaries included.
expectJson([F, '--json', '--since', '30m'], pick(since('2026-09-01T11:30:00Z')), NOW);
expectJson(['--since', '2h', '--json', F], pick(since('2026-09-01T10:00:00Z')), NOW);
expectJson([F, '--since', '36h', '--json'], pick(since('2026-08-31T00:00:00Z')), NOW);
expectJson([F, '--since', '7d', '--json'], pick(since('2026-08-25T12:00:00Z')), NOW);
// Combined with the existing filters, in any order.
expectJson(['--level', 'warn', '--since', '2026-09-01', '--json', F], pick(since('2026-09-01T00:00:00Z'), level('warn')));
expectJson(['--json', '--svc', 'api', F, '--since', '2h'], pick(since('2026-09-01T10:00:00Z'), svc('api')), NOW);
expectJson([F, '--svc', 'worker', '--json', '--level', 'info'], pick(svc('worker'), level('info')));

// Without LOGQ_NOW a relative span counts back from the real clock.
const clockFile = join(dir, 'clock.jsonl');
const past = E('2001-01-01T00:00:00Z', 'info', 'api', 'long ago');
const future = E('2999-01-01T00:00:00Z', 'info', 'api', 'far future');
writeFileSync(clockFile, `${JSON.stringify(past)}\n${JSON.stringify(future)}\n`);
expectJson([clockFile, '--since', '1d', '--json'], [future]);

// Table output with --since is the normal table of just the matching events.
function expectTable(args, want, now) {
  const subset = join(dir, `subset-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(subset, `${want.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const base = logq([subset]);
  const r = logq(args, now);
  const label = `logq ${show(args)}`;
  if (r.code !== 0) fail(`${label}: exit ${r.code}, stderr: ${r.stderr.trim().split('\n')[0]}`);
  if (base.code !== 0 || r.stdout !== base.stdout) {
    fail(`${label}: table output differs from the table of the ${want.length} matching events:\n${r.stdout.slice(0, 600)}`);
  }
}
expectTable([F, '--since', '2026-09-01'], pick(since('2026-09-01T00:00:00Z')));
expectTable(['--since', '30m', '--level', 'info', F], pick(since('2026-09-01T11:30:00Z'), level('info')), NOW);

// Invalid --since: exit 2, an error on stderr, nothing on stdout.
const bad = [
  [F, '--since', 'yesterday'],
  [F, '--since', '5x'],
  ['--since', '5x', '--json', F],
  [F, '--since'],
  ['--since', '--json', F],
  [F, '--json', '--since', 'yesterday'],
];
for (const args of bad) {
  const r = logq(args, NOW);
  const label = `logq ${show(args)}`;
  if (r.code !== 2) fail(`${label}: exit ${r.code}, want 2`);
  if (r.stderr.trim() === '') fail(`${label}: no error message on stderr`);
  if (r.stdout !== '') fail(`${label}: printed to stdout: ${JSON.stringify(r.stdout.slice(0, 120))}`);
}

// README documents both flags.
const readme = existsSync('README.md') ? readFileSync('README.md', 'utf8') : '';
for (const flag of ['--since', '--json']) {
  if (!readme.includes(flag)) fail(`README.md does not mention ${flag}`);
}

// The existing test suite still passes.
const testEnv = { ...process.env };
delete testEnv.NODE_TEST_CONTEXT;
const t = spawnSync('node', ['--test', '--test-reporter=tap'], { encoding: 'utf8', env: testEnv, timeout: 40_000 });
const count = Number(/^# tests (\d+)$/m.exec(t.stdout ?? '')?.[1] ?? NaN);
if (t.status !== 0) fail(`node --test fails: ${(t.stdout ?? '').split('\n').filter((l) => l.startsWith('not ok')).slice(0, 3).join(' | ')}`);
if (!(count >= FIXTURE_TEST_COUNT)) fail(`only ${count} tests ran; the project had ${FIXTURE_TEST_COUNT}`);

console.log('--since and --json behave as specified');
