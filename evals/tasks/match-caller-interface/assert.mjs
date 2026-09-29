import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Derived from the failure where an implementation didn't match how its
// callers use it. The interface — createLimiter({ capacity, refillPerSec }) and
// take(key, cost = 1) -> { ok, remaining, retryAfterMs } — is only visible in
// src/server.js and src/jobs/sync.js; the stub's own doc comment describes an
// older fixed-window `limit(key)` design. The semantics come from the prompt.
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

async function load(path) {
  try {
    return await import(pathToFileURL(resolve(path)).href);
  } catch (err) {
    fail(`importing ${path} failed: ${err.message}`);
  }
}

const { createLimiter } = await load('src/ratelimit.js');
if (typeof createLimiter !== 'function') fail('src/ratelimit.js does not export createLimiter');

let t = 0;
const now = () => t;

function make(options) {
  try {
    const limiter = createLimiter(options);
    if (typeof limiter?.take !== 'function') fail('createLimiter(...) has no take() method');
    return limiter;
  } catch (err) {
    fail(`createLimiter(${JSON.stringify({ ...options, now: options.now && '<fn>' })}) threw: ${err.message}`);
  }
}

function take(limiter, label, args, want) {
  let r;
  try {
    r = limiter.take(...args);
  } catch (err) {
    fail(`${label}: take(${args.map((a) => JSON.stringify(a)).join(', ')}) threw: ${err.message}`);
  }
  if (typeof r !== 'object' || r === null) fail(`${label}: take() returned ${JSON.stringify(r)}, not an object`);
  if (r.ok !== want.ok) fail(`${label}: ok is ${JSON.stringify(r.ok)}, expected ${want.ok}`);
  if ('remaining' in want && !(typeof r.remaining === 'number' && Math.abs(r.remaining - want.remaining) < 1e-6)) {
    fail(`${label}: remaining is ${JSON.stringify(r.remaining)}, expected ${want.remaining}`);
  }
  if ('retryAfterMs' in want && r.retryAfterMs !== want.retryAfterMs) {
    fail(`${label}: retryAfterMs is ${r.retryAfterMs}, expected ${want.retryAfterMs}`);
  }
}

// Continuous refill, a failed take costs nothing, the wait is rounded up.
{
  const L = make({ capacity: 10, refillPerSec: 3, now });
  t = 0;
  take(L, 'draining a full bucket', ['a', 10], { ok: true, remaining: 0 });
  t = 100;
  take(L, '100 ms later (0.3 tokens)', ['a'], { ok: false, remaining: 0.3, retryAfterMs: 234 });
  t = 334;
  take(L, '334 ms after draining (1.002 tokens)', ['a'], { ok: true, remaining: 0.002 });
}
{
  const L = make({ capacity: 5, refillPerSec: 2, now });
  t = 1000;
  take(L, 'a key first used at t=1000 starts full', ['k', 5], { ok: true, remaining: 0 });
  t = 1750;
  take(L, '750 ms of refill at 2/s', ['k'], { ok: true, remaining: 0.5 });
  t = 2100;
  take(L, '350 ms more', ['k'], { ok: true, remaining: 0.2 });
}
{
  const L = make({ capacity: 6, refillPerSec: 3, now });
  t = 0;
  take(L, 'draining', ['e', 6], { ok: true, remaining: 0 });
  t = 500;
  take(L, 'cost 4 with 1.5 tokens', ['e', 4], { ok: false, remaining: 1.5, retryAfterMs: 834 });
  t = 1334;
  take(L, 'cost 4 once 834 ms have passed', ['e', 4], { ok: true, remaining: 0.002 });
}
// Never above capacity.
{
  const L = make({ capacity: 4, refillPerSec: 3, now });
  t = 0;
  take(L, 'draining', ['c', 4], { ok: true, remaining: 0 });
  t = 1_000_000;
  take(L, 'after a long idle period', ['c', 4], { ok: true, remaining: 0 });
  take(L, 'right after that', ['c'], { ok: false, remaining: 0, retryAfterMs: 334 });
  t = 2_000_000;
  take(L, 'after another idle period', ['c'], { ok: true, remaining: 3 });
}
// One bucket per key.
{
  const L = make({ capacity: 2, refillPerSec: 3, now });
  t = 5000;
  take(L, 'draining key p', ['p', 2], { ok: true, remaining: 0 });
  take(L, 'key p again', ['p'], { ok: false, retryAfterMs: 334 });
  take(L, 'key q is unaffected by p', ['q'], { ok: true, remaining: 1 });
  take(L, 'key p is unaffected by q', ['p'], { ok: false, remaining: 0 });
}
// A cost above capacity can never be paid.
{
  const L = make({ capacity: 3, refillPerSec: 3, now });
  t = 0;
  take(L, 'cost 4 with capacity 3', ['z', 4], { ok: false, remaining: 3, retryAfterMs: Infinity });
  take(L, 'cost 3 afterwards', ['z', 3], { ok: true, remaining: 0 });
  t = 10_000_000;
  take(L, 'cost 4 much later', ['z', 4], { ok: false, retryAfterMs: Infinity });
}
// Without `now` it runs on the real clock.
{
  const L = make({ capacity: 3, refillPerSec: 1 });
  const r = L.take('real');
  if (r?.ok !== true || !(Math.abs(r.remaining - 2) < 0.05)) fail(`with the default clock, take() gave ${JSON.stringify(r)}`);
}

// The callers, as written.
const { handle } = await load('src/server.js');
for (let i = 1; i <= 20; i++) {
  const res = handle({ ip: '203.0.113.9', path: '/health' });
  if (res.status !== 200) fail(`server: request ${i} of a burst of 20 got ${res.status}, expected 200`);
}
let limited;
for (let i = 0; i < 5 && !limited; i++) {
  const res = handle({ ip: '203.0.113.9', path: '/health' });
  if (res.status === 429) limited = res;
}
if (!limited) fail('server: requests beyond the burst of 20 were never answered 429');
if (limited.headers['Retry-After'] !== '1') fail(`server: Retry-After is ${JSON.stringify(limited.headers['Retry-After'])}, expected "1"`);
if (handle({ ip: '198.51.100.4', path: '/health' }).status !== 200) fail('server: another client was limited too');

const { syncBatches } = await load('src/jobs/sync.js');
const within = (p, ms, what) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms))]);
const logged = [];
try {
  await within(syncBatches([[1, 2, 3], [4, 5]], async () => {}, (m) => logged.push(m)), 3000, 'syncBatches');
} catch (err) {
  fail(`sync: ${err.message}`);
}
const wantLog = ['synced 3 records (47 left in budget)', 'synced 2 records (45 left in budget)'];
if (JSON.stringify(logged) !== JSON.stringify(wantLog)) fail(`sync: logged ${JSON.stringify(logged)}, expected ${JSON.stringify(wantLog)}`);
let oversized;
try {
  await within(syncBatches([new Array(60).fill(0)], async () => {}, () => {}), 3000, 'an oversized batch');
} catch (err) {
  oversized = err;
}
if (!/larger than the upload budget/.test(oversized?.message ?? '')) {
  fail(`sync: a 60-record batch should be rejected as larger than the budget, got ${oversized ? oversized.message : 'success'}`);
}

console.log('ratelimit.js matches its callers and the stated semantics');
process.exit(0);
