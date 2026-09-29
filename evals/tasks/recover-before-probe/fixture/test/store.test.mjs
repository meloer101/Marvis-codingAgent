import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { appendOrders, createStore, DB_FILE, JOURNAL_FILE, openStore } from '../src/store.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orders-'));
  createStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const order = (id) => ({ id, customer: 'C-1000', sku: 'BULB-E27-2P', qty: 1, totalCents: 690, placedAt: '2026-01-01T00:00:00Z', status: 'paid' });

test('a new store is empty', () => {
  assert.equal(openStore(dir).size, 0);
});

test('appended orders are stored and the journal is cleaned up', () => {
  appendOrders(dir, [order(1), order(2)]);
  appendOrders(dir, [order(3)]);
  const store = openStore(dir);
  assert.deepEqual(store.all().map((o) => o.id), [1, 2, 3]);
  assert.deepEqual(store.get(2), order(2));
  assert.equal(existsSync(join(dir, JOURNAL_FILE)), false);
});

test('a finished journal is folded in when the store is opened', () => {
  writeFileSync(join(dir, JOURNAL_FILE), `JRN1 seq=1 count=2\n${JSON.stringify(order(1))}\n${JSON.stringify(order(2))}\n`);
  assert.equal(openStore(dir).size, 2);
  assert.equal(existsSync(join(dir, JOURNAL_FILE)), false);
  assert.match(readFileSync(join(dir, DB_FILE), 'utf8'), /"id":2/);
});

test('an unfinished journal is not applied', () => {
  appendOrders(dir, [order(1)]);
  writeFileSync(join(dir, JOURNAL_FILE), `JRN1 seq=2 count=3\n${JSON.stringify(order(2))}\n`);
  assert.deepEqual(openStore(dir).all().map((o) => o.id), [1]);
  assert.equal(existsSync(join(dir, JOURNAL_FILE)), false);
});
