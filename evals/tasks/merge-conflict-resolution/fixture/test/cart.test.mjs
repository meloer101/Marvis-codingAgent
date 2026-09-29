import test from 'node:test';
import assert from 'node:assert/strict';

import { total } from '../src/cart.js';

const items = [
  { sku: 'mug', price: 12.5, qty: 2 },
  { sku: 'tee', price: 18, qty: 1 },
];

test('total adds up price × qty', () => {
  assert.equal(total(items), 43);
});

test('an empty cart costs nothing', () => {
  assert.equal(total([]), 0);
});

test('totals are rounded to cents', () => {
  assert.equal(total([{ sku: 'pen', price: 0.1, qty: 3 }]), 0.3);
});
