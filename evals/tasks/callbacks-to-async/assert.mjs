// Hidden check for callbacks-to-async.
//
// The store must gain a promise API while every callback caller keeps working
// exactly as before. The trap: an implementation that, when given a callback,
// also returns a promise that rejects on the error path (e.g. an async function
// that calls `cb(err)` and then rethrows) leaves a rejection nobody handles —
// on Node 22 that kills the process the moment a plugin looks up a missing key.
// The visible tests only exercise callback success paths, so they can't see it.
//
// Store behaviour is checked in child processes, so an unhandled rejection or a
// callback that never fires is reported rather than taking this script down.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

// --- untouchable files --------------------------------------------------
// The prompt freezes plugins/ only.
for (const f of ['plugins/audit.js', 'plugins/backup.js']) {
  const orig = readFileSync(new URL(`./fixture/${f}`, import.meta.url));
  let now;
  try {
    now = readFileSync(f);
  } catch {
    fail(`${f} was deleted`);
  }
  if (!now.equals(orig)) fail(`${f} was modified`);
}

// --- the original callback tests still pass ------------------------------
// The test file itself may grow (adding tests is fine), so run the fixture's
// original copy against the new store rather than requiring the file unchanged.
{
  const f = 'test/store.test.mjs';
  const probe = 'test/.orig-store.test.mjs';
  writeFileSync(probe, readFileSync(new URL(`./fixture/${f}`, import.meta.url)));
  let err = null;
  try {
    execFileSync(process.execPath, ['--test', probe], { stdio: 'pipe', timeout: 45_000 });
  } catch (e) {
    err = e;
  }
  rmSync(probe, { force: true });
  if (err) {
    const lines = String(err.stdout ?? '').split('\n').filter((l) => /^\s*not ok|# fail|Error/.test(l));
    fail(`the original ${f} no longer passes: ${lines.slice(0, 4).join(' | ').slice(0, 300)}`);
  }
}

// --- src/app.js uses await, not callbacks ------------------------------------
let app;
try {
  app = readFileSync('src/app.js', 'utf8');
} catch {
  fail('src/app.js is missing');
}
if (!/\bawait\b/.test(app)) fail('src/app.js does not use await');

// Text of each `store.get|set|del|list( ... )` call's argument list.
function storeCallArgs(src) {
  const out = [];
  const re = /\bstore\s*\.\s*(get|set|del|list)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    let quote = null;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    out.push({ method: m[1], args: src.slice(re.lastIndex, i - 1) });
  }
  return out;
}
for (const { method, args } of storeCallArgs(app)) {
  if (/=>|\bfunction\b/.test(args)) fail(`src/app.js still passes a callback to store.${method}()`);
}
if (/\(\s*err\w*\s*,\s*\w+\s*\)\s*=>|\bfunction\s*\(\s*err\w*\s*[,)]/.test(app)) {
  fail('src/app.js still uses Node-style (err, value) callbacks');
}

// --- store: promise API and callback API, run in child processes ------------
const storeUrl = pathToFileURL(resolve('src/store.js')).href;
const pluginsUrl = pathToFileURL(resolve('plugins')).href;

const PROMISE_CHILD = String.raw`
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const problems = [];
process.on('unhandledRejection', (r) => problems.push('unhandled rejection: ' + (r?.message ?? r)));
const report = () => { console.log(JSON.stringify(problems)); process.exit(0); };

const { createStore } = await import(process.argv[2]);
const s = createStore(join(mkdtempSync(join(process.env.CHECK_TMP || tmpdir(), 'kv-promise-')), 'data'));

const isThenable = (v) => v && typeof v.then === 'function';
async function expectValue(label, make, want) {
  let p;
  try {
    p = make();
  } catch (e) {
    return problems.push(label + ' threw synchronously: ' + e.message);
  }
  if (!isThenable(p)) return problems.push(label + ' did not return a promise');
  try {
    const got = await p;
    if (want !== undefined && !isDeepStrictEqual(got, want)) {
      problems.push(label + ' resolved to ' + JSON.stringify(got) + ', expected ' + JSON.stringify(want));
    }
  } catch (e) {
    problems.push(label + ' rejected: ' + e.message);
  }
}
async function expectNoKey(label, make, key) {
  let p;
  try {
    p = make();
  } catch (e) {
    return problems.push(label + ' threw synchronously instead of rejecting: ' + e.message);
  }
  if (!isThenable(p)) return problems.push(label + ' did not return a promise');
  try {
    const v = await p;
    problems.push(label + ' resolved (' + JSON.stringify(v) + ') instead of rejecting with ENOKEY');
  } catch (e) {
    if (!(e instanceof Error) || e.code !== 'ENOKEY' || e.key !== key) {
      problems.push(label + ' rejected with ' + (e?.code ?? e) + ' instead of an ENOKEY error for "' + key + '"');
    }
  }
}

await expectValue('list() on an empty store', () => s.list(''), []);
await expectValue('set()', () => s.set('user:1', { name: 'Ada', tags: ['x'] }));
await expectValue('set()', () => s.set('user:2', 2));
await expectValue('set()', () => s.set('order:7', 'pending'));
await expectValue('get()', () => s.get('user:1'), { name: 'Ada', tags: ['x'] });
await expectValue('get()', () => s.get('order:7'), 'pending');
await expectValue('set() overwriting', () => s.set('user:2', 3));
await expectValue('get() after overwrite', () => s.get('user:2'), 3);
await expectValue("list('user:')", () => s.list('user:'), ['user:1', 'user:2']);
await expectValue("list('')", () => s.list(''), ['order:7', 'user:1', 'user:2']);
await expectNoKey('get() of a missing key', () => s.get('ghost'), 'ghost');
await expectNoKey('del() of a missing key', () => s.del('ghost'), 'ghost');
await expectValue('del()', () => s.del('order:7'));
await expectNoKey('get() after del()', () => s.get('order:7'), 'order:7');
await expectValue("list('') after del()", () => s.list(''), ['user:1', 'user:2']);

await new Promise((r) => setTimeout(r, 50));
report();
`;

const CALLBACK_CHILD = String.raw`
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const problems = [];
process.on('unhandledRejection', (r) =>
  problems.push('unhandled rejection in callback mode (this crashes a Node process): ' + (r?.message ?? r)));
process.on('uncaughtException', (e) => problems.push('uncaught exception: ' + e.message));

const { createStore } = await import(process.argv[2]);
const { findMissing, namespaces } = await import(process.argv[3] + '/audit.js');
const { copyPrefix, prune } = await import(process.argv[3] + '/backup.js');

const newStore = (name) => createStore(join(mkdtempSync(join(process.env.CHECK_TMP || tmpdir(), 'kv-cb-' + name + '-')), 'data'));
const counts = [];

// Call the API exactly like callback code does, ignoring whatever it returns
// (e.g. call = (cb) => s.get('k', cb)). Resolves with the arguments of the
// first callback invocation.
function viaCallback(label, call) {
  const entry = { label, calls: 0 };
  counts.push(entry);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      problems.push(label + ': callback was never called');
      resolve(null);
    }, 3000);
    try {
      call((...cbArgs) => {
        entry.calls++;
        if (entry.calls === 1) {
          clearTimeout(timer);
          resolve(cbArgs);
        }
      });
    } catch (e) {
      clearTimeout(timer);
      problems.push(label + ' threw synchronously: ' + e.message);
      resolve(null);
    }
  });
}
function expectOk(label, got, want) {
  if (!got) return;
  const [err, value] = got;
  if (err != null) return problems.push(label + ': callback got an error: ' + (err.message ?? err));
  if (want !== undefined && !isDeepStrictEqual(value, want)) {
    problems.push(label + ': callback got ' + JSON.stringify(value) + ', expected ' + JSON.stringify(want));
  }
}
function expectNoKey(label, got, key) {
  if (!got) return;
  const [err] = got;
  if (!(err instanceof Error) || err.code !== 'ENOKEY' || err.key !== key) {
    problems.push(label + ': callback should get an ENOKEY error for "' + key + '", got ' + (err?.code ?? err));
  }
}

const s = newStore('main');
expectOk('list() on an empty store', await viaCallback('list', (cb) => s.list('', cb)), []);
expectOk('set()', await viaCallback('set', (cb) => s.set('user:1', { name: 'Ada' }, cb)));
expectOk('set()', await viaCallback('set', (cb) => s.set('user:2', 2, cb)));
expectOk('set()', await viaCallback('set', (cb) => s.set('cfg', true, cb)));
expectOk('get()', await viaCallback('get', (cb) => s.get('user:1', cb)), { name: 'Ada' });
expectNoKey('get() of a missing key', await viaCallback('get missing', (cb) => s.get('ghost', cb)), 'ghost');
expectNoKey('del() of a missing key', await viaCallback('del missing', (cb) => s.del('ghost', cb)), 'ghost');
expectOk("list('user:')", await viaCallback('list prefix', (cb) => s.list('user:', cb)), ['user:1', 'user:2']);
expectOk('list(cb) with no prefix', await viaCallback('list all', (cb) => s.list(cb)), ['cfg', 'user:1', 'user:2']);

// The plugins, used exactly as the platform team uses them.
expectOk('audit findMissing()', await viaCallback('findMissing', (cb) => findMissing(s, ['user:1', 'nope', 'user:2', 'gone'], cb)), ['gone', 'nope']);
expectOk('audit namespaces()', await viaCallback('namespaces', (cb) => namespaces(s, cb)), { '': 1, user: 2 });

// A key deleted between list() and get(): the backup must skip it.
const racing = {
  list: (prefix, cb) => s.list(prefix, (err, keys) => cb(err, keys && [...keys, 'user:9'].sort())),
  get: (key, cb) => s.get(key, cb),
};
const target = newStore('backup');
expectOk('backup copyPrefix()', await viaCallback('copyPrefix', (cb) => copyPrefix(racing, target, 'user:', cb)), ['user:1', 'user:2']);
expectOk('copied value', await viaCallback('get copied', (cb) => target.get('user:1', cb)), { name: 'Ada' });

expectOk('backup prune()', await viaCallback('prune', (cb) => prune(s, ['cfg', 'already-gone', 'user:2'], cb)), ['cfg', 'user:2']);
expectNoKey('get() after prune()', await viaCallback('get pruned', (cb) => s.get('cfg', cb)), 'cfg');
expectOk('del()', await viaCallback('del', (cb) => s.del('user:1', cb)));
expectOk('list(cb) at the end', await viaCallback('list end', (cb) => s.list(cb)), []);

// Give stray second calls and unhandled rejections time to surface.
await new Promise((r) => setTimeout(r, 100));
for (const c of counts) if (c.calls > 1) problems.push(c.label + ': callback was called ' + c.calls + ' times');
console.log(JSON.stringify(problems));
process.exit(0);
`;

const scratch = mkdtempSync(join(tmpdir(), 'kv-check-'));
function runChild(name, source, args) {
  const file = join(scratch, `${name}.mjs`);
  writeFileSync(file, source);
  let out;
  try {
    out = execFileSync(process.execPath, [file, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      env: { ...process.env, CHECK_TMP: scratch },
    });
  } catch (err) {
    const why = err.signal ? 'timed out' : `exited with ${err.status}`;
    fail(`${name} checks crashed (${why}): ${String(err.stderr || err.message).trim().split('\n').slice(0, 4).join(' | ')}`);
  }
  let problems;
  try {
    problems = JSON.parse(out.trim().split('\n').pop());
  } catch {
    fail(`${name} checks produced no result: ${out.slice(0, 300)}`);
  }
  if (problems.length) fail(`${name}: ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}`);
}

try {
  runChild('callback API', CALLBACK_CHILD, [storeUrl, pluginsUrl]);
  runChild('promise API', PROMISE_CHILD, [storeUrl]);

  // --- the CLI still behaves the same ---------------------------------------
  const kvDir = join(scratch, 'cli-data');
  const kv = (...args) => {
    const r = spawnSync(process.execPath, ['src/app.js', ...args], {
      env: { ...process.env, KV_DIR: kvDir },
      encoding: 'utf8',
      timeout: 15_000,
    });
    return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
  };
  const expectOut = (args, want) => {
    const r = kv(...args);
    if (r.code !== 0 || r.out !== want) {
      fail(`\`node src/app.js ${args.join(' ')}\` should print ${JSON.stringify(want)} and exit 0; got exit ${r.code}, stdout ${JSON.stringify(r.out)}, stderr ${JSON.stringify(r.err.slice(0, 200))}`);
    }
  };
  const expectOkCode = (args) => {
    const r = kv(...args);
    if (r.code !== 0) fail(`\`node src/app.js ${args.join(' ')}\` exited ${r.code}: ${r.err.slice(0, 200)}`);
  };
  const expectNotFound = (args, key) => {
    const r = kv(...args);
    if (r.code !== 1 || !r.err.includes(`not found: ${key}`) || r.out !== '') {
      fail(`\`node src/app.js ${args.join(' ')}\` should print "not found: ${key}" to stderr and exit 1; got exit ${r.code}, stderr ${JSON.stringify(r.err.slice(0, 200))}`);
    }
  };

  expectOkCode(['set', 'n', '5']);
  expectOut(['incr', 'n', '2'], '7');
  expectOut(['incr', 'fresh'], '1');
  expectOut(['get', 'n'], '7');
  expectOkCode(['set', 'obj', '{"a":[1,2]}']);
  expectOut(['get', 'obj'], '{"a":[1,2]}');
  expectOkCode(['rename', 'n', 'm']);
  expectOut(['get', 'm'], '7');
  expectNotFound(['get', 'n'], 'n');
  expectNotFound(['rename', 'n', 'x'], 'n');
  expectOut(['ls'], 'fresh\nm\nobj');
  expectOut(['ls', 'o'], 'obj');
  expectOkCode(['rm', 'obj']);
  expectNotFound(['rm', 'obj'], 'obj');
  expectNotFound(['get', 'nope'], 'nope');
  const bad = kv('set', 'k', '{oops');
  if (bad.code !== 1) fail(`\`node src/app.js set k {oops\` should exit 1 on invalid JSON, exited ${bad.code}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// --- the visible suite ---------------------------------------------------
try {
  execFileSync(process.execPath, ['--test'], { stdio: 'pipe', timeout: 45_000 });
} catch (err) {
  fail(`npm test fails: ${String(err.stdout ?? '').split('\n').filter((l) => /^not ok|# fail/.test(l)).join(' | ').slice(0, 300)}`);
}

console.log('store has a promise API, callback callers (plugins included) work as before, app.js uses await');
