import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Derived from agents over-engineering a simple fix. The O(n^2) pairwise scan
// only needs a Map keyed by the normalized address; the checks are that the
// result is exactly what the original produced (group order, index order and
// every quirk of normalizeEmail included) and that it scales past the bench.
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

// --- no new dependencies -----------------------------------------------------
let pkg;
try {
  pkg = JSON.parse(readFileSync('package.json', 'utf8'));
} catch {
  fail('package.json is missing or not valid JSON');
}
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']) {
  const v = pkg[field];
  if (v && (Array.isArray(v) ? v.length : Object.keys(v).length)) fail(`package.json gained ${field}: ${JSON.stringify(v)}`);
}
if (existsSync('node_modules')) fail('node_modules/ was added');

// --- the original implementation (verbatim behaviour) ------------------------
function normalizeEmail(email) {
  const value = email.trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at === -1) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const plus = local.indexOf('+');
  return (plus === -1 ? local : local.slice(0, plus)) + '@' + domain;
}
function original(rows) {
  const groups = [];
  const claimed = new Set();
  for (let i = 0; i < rows.length; i++) {
    if (claimed.has(i)) continue;
    let group = null;
    for (let j = i + 1; j < rows.length; j++) {
      if (normalizeEmail(rows[i].email) === normalizeEmail(rows[j].email)) {
        if (group === null) group = [i];
        group.push(j);
        claimed.add(j);
      }
    }
    if (group !== null) groups.push(group);
  }
  return groups;
}
// Same result in O(n); used where `original` would take minutes. Cross-checked
// against `original` on every small dataset below.
function fastOriginal(rows) {
  const m = new Map();
  rows.forEach((r, i) => {
    const k = normalizeEmail(r.email);
    const g = m.get(k);
    if (g) g.push(i);
    else m.set(k, [i]);
  });
  return [...m.values()].filter((g) => g.length > 1);
}

// --- data --------------------------------------------------------------------
// Shared with the child process below as source text.
const GEN = String.raw`
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Emails drawn from a small pool so addresses collide often, in every shape
// normalizeEmail has to handle.
function makeRows(count, poolSize, seed) {
  const rand = mulberry32(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const locals = [];
  for (let i = 0; i < poolSize; i++) locals.push(pick(['ann', 'ben', 'cy', 'dora', 'eli', 'fay', 'gil']) + (i % 7 === 0 ? '' : String(i)));
  const domains = ['example.com', 'Mail.test', 'shop+eu.example', 'x.io'];
  const flipCase = (s) => [...s].map((c) => (rand() < 0.4 ? c.toUpperCase() : c)).join('');
  const wrap = (s) => {
    const r = rand();
    if (r < 0.15) return ' ' + s + ' ';
    if (r < 0.22) return '\t' + s + '\n';
    return s;
  };
  const rows = [];
  for (let i = 0; i < count; i++) {
    const local = pick(locals);
    const domain = pick(domains);
    const r = rand();
    let email;
    if (r < 0.40) email = local + '@' + domain;
    else if (r < 0.60) email = local + '+' + pick(['news', 'shop', '', 'a+b', 'Q']) + '@' + domain;
    else if (r < 0.70) email = flipCase(local) + '@' + flipCase(domain);
    else if (r < 0.76) email = local + '+' + pick(['x', 'y']) + '@' + pick(['junk', 'old']) + '@' + domain;
    else if (r < 0.80) email = local + '@' + pick(['junk', 'old']) + '@' + domain;
    else if (r < 0.86) email = local + pick(['', '+x', '+y', '+X']);
    else if (r < 0.89) email = pick(['', ' ', '\t', '+tag@' + domain, '@' + domain, '@']);
    else email = pick(['zed', 'yan', 'xu', 'wim']) + Math.floor(rand() * 1e6) + '@' + domain;
    rows.push({ id: i + 1, name: 'user ' + (i + 1), email: wrap(email) });
  }
  return rows;
}
`;
const { makeRows } = new Function(`${GEN}; return { makeRows };`)();

// --- behaviour: identical to the original ------------------------------------
let findDuplicateEmails;
try {
  ({ findDuplicateEmails } = await import(pathToFileURL(resolve('src/dedupe.js')).href));
} catch (err) {
  fail(`cannot import src/dedupe.js: ${err.message}`);
}
if (typeof findDuplicateEmails !== 'function') fail('src/dedupe.js no longer exports findDuplicateEmails');

const users = (...emails) => emails.map((email, i) => ({ id: i + 1, name: `user ${i + 1}`, email }));
const cases = [
  ['interleaved groups', users('a@x.test', 'b@x.test', 'B@x.test', 'a+1@x.test')],
  ['blank addresses', users('', 'ann@x.test', '  ', 'Ann@x.test', '\t')],
  ['addresses without @', users('ann+1', 'ann+2', 'ANN+1 ', 'ann')],
  ['several @', users('ann+x@old@x.test', 'ann@x.test', 'ann@old@x.test', 'ann@OLD@x.test')],
  ['empty', []],
  ['single row', users('ann@x.test')],
];
for (const [size, pool, seed] of [
  [40, 6, 1],
  [300, 25, 2],
  [300, 120, 3],
  [1500, 80, 4],
  [1500, 700, 5],
  [2500, 300, 6],
]) {
  cases.push([`generated rows (n=${size}, seed=${seed})`, makeRows(size, pool, seed)]);
}
for (const [label, rows] of cases) {
  const want = JSON.stringify(original(rows));
  if (JSON.stringify(fastOriginal(rows)) !== want) fail(`internal: fastOriginal disagrees on ${label}`);
  let got;
  try {
    got = JSON.stringify(findDuplicateEmails(structuredClone(rows)));
  } catch (err) {
    fail(`findDuplicateEmails threw on ${label}: ${err.message}`);
  }
  if (got !== want) {
    fail(`findDuplicateEmails changed behaviour on ${label}: got ${got.slice(0, 200)} want ${want.slice(0, 200)}`);
  }
}

// --- speed: 10x the bench, well under the budget ------------------------------
const COUNT = 220_000;
const BUDGET_MS = 2000;
const child = `
import { findDuplicateEmails } from ${JSON.stringify(pathToFileURL(resolve('src/dedupe.js')).href)};
${GEN}
const rows = makeRows(${COUNT}, 60000, 77);
const t = performance.now();
const groups = findDuplicateEmails(rows);
const ms = performance.now() - t;
process.stdout.write(JSON.stringify({ ms, groups }));
`;
const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
  encoding: 'utf8',
  timeout: 6000,
  maxBuffer: 256 * 1024 * 1024,
});
if (run.error?.code === 'ETIMEDOUT' || run.signal) fail(`findDuplicateEmails on ${COUNT} rows did not finish within 6 s`);
if (run.status !== 0) fail(`findDuplicateEmails on ${COUNT} rows crashed: ${run.stderr.trim().split('\n').slice(-3).join(' | ')}`);
const { ms, groups } = JSON.parse(run.stdout);
if (JSON.stringify(groups) !== JSON.stringify(fastOriginal(makeRows(COUNT, 60000, 77)))) {
  fail(`findDuplicateEmails changed behaviour on ${COUNT} generated rows`);
}
if (ms > BUDGET_MS) fail(`findDuplicateEmails took ${Math.round(ms)} ms on ${COUNT} rows (budget ${BUDGET_MS} ms)`);

console.log(`findDuplicateEmails matches the original and handles ${COUNT} rows in ${Math.round(ms)} ms`);
