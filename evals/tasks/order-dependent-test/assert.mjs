import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

// Derived from the "rabbit hole" failures: the symptom ('1.234,50' where
// '1,234.50' was expected) looks like a locale/Intl problem, but the cause is
// shared mutable state — buildReport merges each call's options into the
// module-level DEFAULTS, so an earlier de-DE call leaks into later ones. toTable
// has the same bug with DEFAULT_COLUMNS, which the visible tests don't expose;
// the prompt asks for the mistake to be fixed everywhere it appears.
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

// 1. The tests are the spec: unchanged, and the whole file passes in one process.
const TEST_SHA256 = '97dfa15c1a5425d0be53f627d1bb37dc0471f42cbebd7a2dc79aab5cbd21a9b4';
let testSource;
try {
  testSource = readFileSync('test/report.test.mjs');
} catch {
  fail('test/report.test.mjs is missing');
}
if (createHash('sha256').update(testSource).digest('hex') !== TEST_SHA256) fail('test/report.test.mjs was modified');
try {
  execFileSync('node', ['--test', 'test/report.test.mjs'], { stdio: 'pipe', timeout: 30_000 });
} catch (err) {
  const out = `${err.stdout ?? ''}`.split('\n').filter((l) => /^not ok|expected:|actual:/.test(l.trim()));
  fail(`node --test test/report.test.mjs still fails: ${out.join(' | ').slice(0, 300) || err.message}`);
}

// 2. No call's options leak into later calls, for either function.
let mod;
try {
  mod = await import(pathToFileURL(resolve('src/report.js')).href);
} catch (err) {
  fail(`importing src/report.js failed: ${err.message}`);
}
const { buildReport, toTable } = mod;

const rows = [
  { date: '2026-08-02', label: 'Rent', amount: 1500 },
  { date: '2026-08-09', label: 'Water', amount: 42.3 },
  { date: '2026-08-20', label: 'Phone', amount: 29.95 },
];
const expect = (label, got, want) => {
  if (!isDeepStrictEqual(got, want)) fail(`${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
};

const german = buildReport(rows, { locale: 'de-DE', currency: 'EUR', title: 'August close' });
expect('buildReport with de-DE/EUR/title: total', german.total, '1.572,25');
expect('buildReport with de-DE/EUR/title: heading', german.heading, 'August close (EUR)');
const plain = buildReport(rows);
expect('buildReport() after a de-DE/EUR/title call: total', plain.total, '1,572.25');
expect('buildReport() after a de-DE/EUR/title call: heading', plain.heading, 'Monthly report (USD)');
expect('buildReport() after a de-DE/EUR/title call: first line', plain.lines[0], '2026-08-02  Rent  1,500.00');
buildReport(rows, { currency: 'GBP' });
expect('buildReport({ title }) after a GBP call: heading', buildReport(rows, { title: 'Draft' }).heading, 'Draft (USD)');
expect('buildReport() after a GBP call and a title call: heading', buildReport(rows).heading, 'Monthly report (USD)');

expect('toTable with extraColumns: header', toTable(rows, { extraColumns: ['note'] })[0], ['date', 'label', 'amount', 'note']);
expect('toTable with the same extraColumns again: header', toTable(rows, { extraColumns: ['note'] })[0], ['date', 'label', 'amount', 'note']);
const table = toTable(rows);
expect('toTable() after extraColumns calls: header', table[0], ['date', 'label', 'amount']);
expect('toTable() after extraColumns calls: first row', table[1], ['2026-08-02', 'Rent', 1500]);
expect('toTable with its own columns', toTable(rows, { columns: ['label', 'amount'] })[1], ['Rent', 1500]);
expect('toTable() at the end: header', toTable(rows)[0], ['date', 'label', 'amount']);

console.log('report.js no longer leaks options between calls; the test file passes unchanged');
