import test from 'node:test';
import assert from 'node:assert/strict';

import { discount, subtotal, total } from '../src/cart.js';

const items = [
  { sku: 'mug', price: 12.5, qty: 2 },
  { sku: 'tee', price: 18, qty: 1 },
];
const bigOrder = [{ sku: 'lamp', price: 37.7, qty: 2 }];

test('subtotal adds up price × qty', () => {
  assert.equal(subtotal(items), 43);
  assert.equal(subtotal(bigOrder), 75.4);
});

test('percentage coupons', () => {
  assert.equal(discount(60, 'SAVE10'), 6);
  assert.equal(discount(75.4, 'SAVE10'), 7.54);
  assert.equal(discount(49.99, 'SAVE10'), 0, 'below the $50 minimum');
});

test('fixed-amount coupons', () => {
  assert.equal(discount(30, 'FIVEOFF'), 5);
  assert.equal(discount(25, 'FIVEOFF'), 5, 'the minimum itself qualifies');
  assert.equal(discount(24.99, 'FIVEOFF'), 0, 'below the $25 minimum');
});

test('no coupon, no discount; unknown codes throw', () => {
  assert.equal(discount(100), 0);
  assert.throws(() => discount(100, 'BOGUS'), /unknown coupon/);
});

test('total applies the coupon', () => {
  assert.equal(total(items), 43);
  assert.equal(total(items, { coupon: 'FIVEOFF' }), 38);
  assert.equal(total(items, { coupon: 'SAVE10' }), 43, 'below the minimum');
  assert.equal(total(bigOrder, { coupon: 'SAVE10' }), 67.86);
});
