import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReport, toTable } from '../src/report.js';

const rows = [
  { date: '2026-09-01', label: 'Rent', amount: 1000 },
  { date: '2026-09-03', label: 'Power', amount: 184.25 },
  { date: '2026-09-12', label: 'Internet', amount: 50.25 },
];

test('lists every row', () => {
  const report = buildReport(rows);
  assert.equal(report.lines.length, 3);
  assert.equal(report.lines[0], '2026-09-01  Rent  1,000.00');
});

test('uses the title it is given', () => {
  assert.equal(buildReport(rows, { title: 'Q3 close' }).heading, 'Q3 close (USD)');
});

test('formats totals for a German audience', () => {
  const report = buildReport(rows, { locale: 'de-DE', currency: 'EUR' });
  assert.equal(report.total, '1.234,50');
  assert.ok(report.heading.endsWith('(EUR)'));
});

test('formats totals with the default locale', () => {
  assert.equal(buildReport(rows).total, '1,234.50');
});

test('tables start with a header row', () => {
  const table = toTable(rows);
  assert.deepEqual(table[0], ['date', 'label', 'amount']);
  assert.equal(table.length, 4);
});

test('tables can carry extra columns', () => {
  const table = toTable([{ ...rows[0], category: 'housing' }], { extraColumns: ['category'] });
  assert.deepEqual(table[1], ['2026-09-01', 'Rent', 1000, 'housing']);
});
