import test from 'node:test';
import assert from 'node:assert/strict';

import { salesTax, total } from '../src/cart.js';

const items = [
  { sku: 'mug', price: 12.5, qty: 2 },
  { sku: 'tee', price: 18, qty: 1 },
];

test('salesTax is rounded to cents', () => {
  assert.equal(salesTax(100, 0.0825), 8.25);
  assert.equal(salesTax(43, 0.0825), 3.55);
  assert.equal(salesTax(19.99, 0.07), 1.4);
});

test('total adds sales tax', () => {
  assert.equal(total(items, { taxRate: 0.0825 }), 46.55);
  assert.equal(total(items, { taxRate: 0.1 }), 47.3);
});

test('no tax rate means no tax', () => {
  assert.equal(total(items), 43);
  assert.equal(total(items, { taxRate: 0 }), 43);
});
