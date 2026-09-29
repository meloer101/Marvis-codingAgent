// Hidden check for concurrency-limit-bug.
//
// The fixture's mapLimit has two bugs: results are collected in completion
// order, and in settle mode a rejected item frees its slot twice, so after a
// few failures more than `limit` calls run at once. The visible test only
// covers the happy path with instantly-resolving calls.
//
// Every scenario below is driven by hand-resolved deferreds, not timers: the
// driver completes one pending call at a time (in a fixed FIFO/LIFO order) and
// lets the pool's microtasks drain between steps, so the outcome never depends
// on wall-clock timing. The scenarios run in a child process so a crash, an
// unhandled rejection, or a hang is reported instead of taking this script down.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

// The caller must not change.
const fixtureCrawl = readFileSync(new URL('./fixture/src/crawl.js', import.meta.url));
let crawl;
try {
  crawl = readFileSync('src/crawl.js');
} catch {
  fail('src/crawl.js is missing');
}
if (!crawl.equals(fixtureCrawl)) fail('src/crawl.js was changed (the caller must stay as it is)');

const CHILD = String.raw`
import { pathToFileURL } from 'node:url';

const problems = [];
process.on('unhandledRejection', (reason) => {
  problems.push('unhandled rejection: ' + (reason && reason.message ? reason.message : String(reason)));
});

const { mapLimit } = await import(pathToFileURL(process.argv[2]).href);
if (typeof mapLimit !== 'function') {
  console.log(JSON.stringify(['src/pool.js no longer exports mapLimit']));
  process.exit(0);
}

const tick = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setImmediate(r));
};

// Run mapLimit over n items with a fake async fn. Pending calls are completed
// one at a time, oldest first ('fifo') or newest first ('lifo').
async function drive({ n, limit, settle, fails = [], syncThrows = [], order }) {
  const items = Array.from({ length: n }, (_, i) => 'u' + i);
  const idx = (item) => Number(item.slice(1));
  const errors = new Map();
  const started = [];
  const pending = [];
  let active = 0;
  let max = 0;
  let startedAtFirstFailure = null;
  const fn = (item) => {
    started.push(idx(item));
    if (syncThrows.includes(idx(item))) {
      const e = new Error('sync failure ' + item);
      errors.set(idx(item), e);
      if (startedAtFirstFailure === null) startedAtFirstFailure = started.length;
      throw e;
    }
    active++;
    max = Math.max(max, active);
    return new Promise((resolve, reject) => pending.push({ i: idx(item), resolve, reject }));
  };
  let outcome = null;
  try {
    const p = settle ? mapLimit(items, limit, fn, { settle: true }) : mapLimit(items, limit, fn);
    // Copy the array when the promise resolves: what the caller sees is what
    // is in it at that moment, not what gets filled in later.
    Promise.resolve(p).then(
      (value) => { outcome = { ok: true, value: Array.isArray(value) ? Array.from(value) : value }; },
      (error) => { outcome = { ok: false, error }; },
    );
  } catch (error) {
    outcome = { threw: error };
  }
  const startedAfterFirstTick = [];
  for (let step = 0; step < 5000; step++) {
    await tick();
    if (step === 0) startedAfterFirstTick.push(...started);
    if (pending.length === 0) break;
    const call = order === 'lifo' ? pending.pop() : pending.shift();
    active--;
    if (fails.includes(call.i)) {
      const e = new Error('failure u' + call.i);
      errors.set(call.i, e);
      if (startedAtFirstFailure === null) startedAtFirstFailure = started.length;
      call.reject(e);
    } else {
      call.resolve('v' + call.i);
    }
  }
  await tick();
  return { outcome, max, started, errors, startedAtFirstFailure, startedAfterFirstTick };
}

function checkOrdered(name, r, n) {
  if (!r.outcome) return problems.push(name + ': the promise never settled');
  if (r.outcome.threw) return problems.push(name + ': mapLimit threw synchronously: ' + r.outcome.threw.message);
  if (!r.outcome.ok) return problems.push(name + ': rejected unexpectedly: ' + r.outcome.error?.message);
  const got = r.outcome.value;
  const want = Array.from({ length: n }, (_, i) => 'v' + i);
  if (!Array.isArray(got) || got.length !== n || got.some((v, i) => v !== want[i])) {
    problems.push(name + ': results not in input order: got ' + JSON.stringify(got));
  }
}

function checkSettled(name, r, n) {
  if (!r.outcome) return problems.push(name + ': the promise never settled');
  if (r.outcome.threw) return problems.push(name + ': mapLimit threw synchronously: ' + r.outcome.threw.message);
  if (!r.outcome.ok) return problems.push(name + ': settle mode rejected: ' + r.outcome.error?.message);
  const got = r.outcome.value;
  if (!Array.isArray(got) || got.length !== n) {
    return problems.push(name + ': expected ' + n + ' settled entries, got ' + JSON.stringify(got));
  }
  for (let i = 0; i < n; i++) {
    const e = got[i];
    const err = r.errors.get(i);
    const ok = err
      ? e && e.status === 'rejected' && e.reason === err
      : e && e.status === 'fulfilled' && e.value === 'v' + i;
    if (!ok) {
      const want = err ? '{ status: rejected, reason: <error of item ' + i + '> }' : '{ status: fulfilled, value: v' + i + ' }';
      return problems.push(name + ': entry ' + i + ' should be ' + want + ', got ' +
        JSON.stringify(e, (k, v) => (v instanceof Error ? 'Error(' + v.message + ')' : v)));
    }
  }
}

function checkMax(name, r, limit) {
  if (r.max > limit) problems.push(name + ': ' + r.max + ' calls were pending at once with limit ' + limit);
}

function checkFailFast(name, r, failedItem) {
  if (!r.outcome) return problems.push(name + ': the promise never settled');
  if (r.outcome.threw) return problems.push(name + ': mapLimit threw synchronously: ' + r.outcome.threw.message);
  if (r.outcome.ok) return problems.push(name + ': resolved although an item failed');
  if (r.outcome.error !== r.errors.get(failedItem)) {
    problems.push(name + ': should reject with the first error (item ' + failedItem + '), got ' + r.outcome.error?.message);
  }
  if (r.started.length !== r.startedAtFirstFailure) {
    problems.push(name + ': kept starting items after the first failure (started ' + r.started.join(',') +
      '; only the first ' + r.startedAtFirstFailure + ' had started when it failed)');
  }
}

// Default mode, everything succeeds, completions in reverse order.
{
  const r = await drive({ n: 12, limit: 3, order: 'lifo' });
  checkOrdered('default mode', r, 12);
  checkMax('default mode', r, 3);
  if (r.max < 3) problems.push('default mode: never ran 3 calls at once with limit 3 (max ' + r.max + ')');
}

// Settle mode with many failures, completions oldest first.
{
  const fails = [1, 2, 3, 5, 8, 9, 10, 13, 17, 18];
  const r = await drive({ n: 20, limit: 4, settle: true, fails, order: 'fifo' });
  checkMax('settle mode with failures', r, 4);
  checkSettled('settle mode with failures', r, 20);
}

// Settle mode with failures, completions newest first.
{
  const r = await drive({ n: 15, limit: 4, settle: true, fails: [0, 4, 7, 11, 14], order: 'lifo' });
  checkMax('settle mode (reverse completion)', r, 4);
  checkSettled('settle mode (reverse completion)', r, 15);
}

// Settle mode where everything fails.
{
  const all = Array.from({ length: 9 }, (_, i) => i);
  const r = await drive({ n: 9, limit: 2, settle: true, fails: all, order: 'fifo' });
  checkMax('settle mode, every item fails', r, 2);
  checkSettled('settle mode, every item fails', r, 9);
}

// Default mode: first failure rejects, nothing new starts afterwards.
{
  const r = await drive({ n: 10, limit: 3, fails: [4, 6], order: 'fifo' });
  checkMax('default mode with a failure', r, 3);
  checkFailFast('default mode with a failure', r, 4);
}
{
  const r = await drive({ n: 10, limit: 3, fails: [5], order: 'lifo' });
  checkFailFast('default mode with a failure (reverse completion)', r, 5);
}

// A synchronous throw from fn counts as a rejection.
{
  const r = await drive({ n: 6, limit: 2, settle: true, syncThrows: [2], order: 'lifo' });
  checkMax('settle mode, fn throws synchronously', r, 2);
  checkSettled('settle mode, fn throws synchronously', r, 6);
}
{
  const r = await drive({ n: 5, limit: 2, syncThrows: [1], order: 'fifo' });
  checkFailFast('default mode, fn throws synchronously', r, 1);
}

// limit >= items.length: everything starts right away.
{
  const r = await drive({ n: 3, limit: 10, order: 'lifo' });
  checkOrdered('limit larger than the input', r, 3);
  if (r.startedAfterFirstTick.length !== 3) {
    problems.push('limit larger than the input: expected all 3 calls to start at once, started ' + r.startedAfterFirstTick.length);
  }
  const s = await drive({ n: 3, limit: 10, settle: true, fails: [1], order: 'lifo' });
  checkSettled('limit larger than the input (settle)', s, 3);
}

// Empty input.
for (const settle of [false, true]) {
  let called = false;
  let value;
  try {
    value = await (settle ? mapLimit([], 3, () => { called = true; }, { settle: true }) : mapLimit([], 3, () => { called = true; }));
  } catch (e) {
    problems.push('empty input' + (settle ? ' (settle)' : '') + ': rejected/threw: ' + e?.message);
    continue;
  }
  if (!Array.isArray(value) || value.length !== 0) problems.push('empty input' + (settle ? ' (settle)' : '') + ': expected [], got ' + JSON.stringify(value));
  if (called) problems.push('empty input: fn was called');
}

await tick();
console.log(JSON.stringify(problems));
`;

const dir = mkdtempSync(join(tmpdir(), 'maplimit-check-'));
try {
  const script = join(dir, 'check.mjs');
  writeFileSync(script, CHILD);
  let out;
  try {
    out = execFileSync(process.execPath, [script, resolve('src/pool.js')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch (err) {
    const why = err.signal === 'SIGTERM' ? 'timed out' : `exited with ${err.status}`;
    fail(`mapLimit checks crashed (${why}): ${String(err.stderr || err.message).trim().split('\n').slice(0, 3).join(' | ')}`);
  }
  let problems;
  try {
    problems = JSON.parse(out.trim().split('\n').pop());
  } catch {
    fail(`mapLimit checks produced no result: ${out.slice(0, 300)}`);
  }
  if (problems.length) fail(problems[0] + (problems.length > 1 ? ` (+${problems.length - 1} more problem(s))` : ''));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('mapLimit keeps the limit, keeps input order, and fails fast / settles as documented');
