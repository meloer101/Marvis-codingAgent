import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

// Hidden end-state check for GET /todos: default page, id order, cursor walks,
// the exactly-full last page, strict parameter validation, the old endpoints,
// and that the agent's own tests exercise GET /todos and pass.

// The fixture's test suite has this many tests; the agent was asked to add some.
const FIXTURE_TEST_COUNT = 10;

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

let createServer;
try {
  ({ createServer } = await import(pathToFileURL(resolve('src/server.js')).href));
} catch (err) {
  fail(`cannot import src/server.js: ${err?.message ?? err}`);
}
if (typeof createServer !== 'function') fail('src/server.js no longer exports createServer');

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, body: json, text };
}
const get = (path) => call('GET', path);

const pad = (n) => `t${String(n).padStart(3, '0')}`;
const ALL = Array.from({ length: 57 }, (_, i) => pad(i + 1));

async function checks() {
  // Ground truth from the existing single-todo endpoint.
  const statusOf = new Map();
  for (const id of ALL) {
    const r = await get(`/todos/${id}`);
    if (r.status !== 200 || r.body?.data?.id !== id) {
      return `GET /todos/${id} no longer returns that todo (status ${r.status}: ${r.text.slice(0, 120)})`;
    }
    statusOf.set(id, r.body.data.status);
  }
  const OPEN = ALL.filter((id) => statusOf.get(id) === 'open');
  const DONE = ALL.filter((id) => statusOf.get(id) === 'done');
  if (OPEN.length !== 40 || DONE.length !== 17) return 'seed data changed (expected 40 open / 17 done todos)';

  // One page: shape, order, statuses, nextCursor.
  const page = async (query, wantIds, wantNext) => {
    const r = await get(`/todos${query}`);
    if (r.status !== 200) return `GET /todos${query}: status ${r.status}, want 200 (${r.text.slice(0, 160)})`;
    const b = r.body;
    if (!b || b.ok !== true || !Array.isArray(b.data)) return `GET /todos${query}: body is not {ok:true, data:[...]}: ${r.text.slice(0, 160)}`;
    if (!Object.hasOwn(b, 'nextCursor')) return `GET /todos${query}: no top-level nextCursor`;
    const ids = b.data.map((t) => t?.id);
    if (!isDeepStrictEqual(ids, wantIds)) {
      return `GET /todos${query}: ids ${JSON.stringify(ids)}, want ${JSON.stringify(wantIds)}`;
    }
    for (const t of b.data) {
      if (t.status !== statusOf.get(t.id)) return `GET /todos${query}: ${t.id} has status ${t.status}`;
    }
    if (b.nextCursor !== wantNext) {
      return `GET /todos${query}: nextCursor ${JSON.stringify(b.nextCursor)}, want ${JSON.stringify(wantNext)}`;
    }
    return null;
  };

  // Walk a filter at a page size, checking each page against the expected slice.
  const walk = async (filter, limit, expected) => {
    let cursor = null;
    let i = 0;
    for (let n = 0; n < 80; n++) {
      const params = [];
      if (filter) params.push(filter);
      if (limit !== undefined) params.push(`limit=${limit}`);
      if (cursor) params.push(`cursor=${cursor}`);
      const size = limit ?? 20;
      const want = expected.slice(i, i + size);
      const more = i + size < expected.length;
      const err = await page(`?${params.join('&')}`, want, more ? want.at(-1) : null);
      if (err) return err;
      if (!more) return null;
      cursor = want.at(-1);
      i += size;
    }
    return `walking ${filter || 'all'} with limit ${limit} did not terminate`;
  };

  let err;
  // Default page size 20, id ascending.
  if ((err = await page('', ALL.slice(0, 20), 't020'))) return err;
  // Cursor walks over everything and over each status, including exactly-full last pages
  // (57 = 3 x 19, 40 open = 2 x 20, 17 done = 1 x 17).
  if ((err = await walk('', undefined, ALL))) return err;
  if ((err = await walk('', 7, ALL))) return err;
  if ((err = await walk('', 19, ALL))) return err;
  if ((err = await walk('status=open', undefined, OPEN))) return err;
  if ((err = await walk('status=open', 8, OPEN))) return err;
  if ((err = await walk('status=done', 5, DONE))) return err;
  if ((err = await walk('status=done', 17, DONE))) return err;
  if ((err = await page('?limit=100', ALL, null))) return err;
  if ((err = await page('?limit=1', ['t001'], 't001'))) return err;
  if ((err = await page('?status=done&limit=100', DONE, null))) return err;
  if ((err = await page('?cursor=t057', [], null))) return err;
  if ((err = await page(`?cursor=${OPEN[5]}&status=open&limit=3`, OPEN.slice(6, 9), OPEN[8]))) return err;

  // Invalid parameters: 400 with the existing error shape and code.
  const bad = [
    'limit=0',
    'limit=-1',
    'limit=101',
    'limit=500',
    'limit=abc',
    'limit=1.5',
    'status=closed',
    'status=pending&limit=5',
    'cursor=t999',
    'cursor=nope',
    'status=open&cursor=t999',
  ];
  for (const q of bad) {
    const r = await get(`/todos?${q}`);
    const e = r.body?.error;
    if (r.status !== 400 || r.body?.ok !== false || e?.code !== 'invalid_param' || typeof e?.message !== 'string') {
      return `GET /todos?${q}: want 400 {ok:false,error:{code:'invalid_param',message}}, got ${r.status} ${r.text.slice(0, 160)}`;
    }
  }

  // Existing endpoints still behave.
  const missing = await get('/todos/t404');
  if (missing.status !== 404 || missing.body?.error?.code !== 'not_found') return 'GET /todos/t404 no longer 404s with not_found';
  const users = await get('/users/u02');
  if (users.status !== 200 || users.body?.data?.id !== 'u02') return 'GET /users/u02 broke';
  const badPost = await call('POST', '/todos', { status: 'open' });
  if (badPost.status !== 400 || badPost.body?.error?.code !== 'invalid_param') return 'POST /todos without a title no longer 400s';
  const created = await call('POST', '/todos', { title: 'Hidden check todo', userId: 'u04' });
  if (created.status !== 201 || typeof created.body?.data?.id !== 'string') return `POST /todos broke: ${created.status} ${created.text.slice(0, 160)}`;
  const newId = created.body.data.id;
  statusOf.set(newId, 'open');
  // New todos show up in the list (live data, not a snapshot).
  if ((err = await page('?limit=100', [...ALL, newId], null))) return `after POST /todos: ${err}`;
  if ((err = await walk('status=open', 20, [...OPEN, newId]))) return `after POST /todos: ${err}`;
  return null;
}

let problem;
try {
  problem = await checks();
} catch (e) {
  problem = `hidden check crashed: ${e?.stack ?? e}`;
}
server.closeAllConnections?.();
server.close();
if (problem) fail(problem);

// The agent's tests: `npm test` passes, the suite grew, and some test sends GET /todos.
const dir = mkdtempSync(join(tmpdir(), 'todos-assert-'));
const hook = join(dir, 'hook.mjs');
const reqLog = join(dir, 'requests.txt');
writeFileSync(
  hook,
  `import http from 'node:http';
import { appendFileSync } from 'node:fs';
const out = process.env.TODOS_ASSERT_REQ_LOG;
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req, ...rest) {
  if (event === 'request' && out) {
    try { appendFileSync(out, req.method + ' ' + req.url + '\\n'); } catch {}
  }
  return emit.call(this, event, req, ...rest);
};
`,
);
const baseEnv = { ...process.env };
delete baseEnv.NODE_TEST_CONTEXT;
const env = {
  ...baseEnv,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(hook).href}`.trim(),
  TODOS_ASSERT_REQ_LOG: reqLog,
};

const npm = spawnSync('npm', ['test'], { env, encoding: 'utf8', timeout: 40_000 });
if (npm.status !== 0) {
  fail(`npm test failed (exit ${npm.status}): ${`${npm.stdout}${npm.stderr}`.trim().split('\n').slice(-8).join(' | ')}`);
}
const requests = existsSync(reqLog) ? readFileSync(reqLog, 'utf8').split('\n').filter(Boolean) : [];
const listed = requests.some((line) => {
  const [method, url] = line.split(' ');
  return method === 'GET' && new URL(url, 'http://x').pathname === '/todos';
});
if (!listed) fail('no test sends a GET /todos request');

const tap = spawnSync('node', ['--test', '--test-reporter=tap'], {
  env: baseEnv,
  encoding: 'utf8',
  timeout: 40_000,
});
const count = Number(/^# tests (\d+)$/m.exec(tap.stdout ?? '')?.[1] ?? NaN);
if (!(count > FIXTURE_TEST_COUNT)) fail(`test count is ${count}, the fixture already had ${FIXTURE_TEST_COUNT} — no tests were added`);

console.log(`GET /todos behaves as specified; ${count} tests pass`);
process.exit(0);
