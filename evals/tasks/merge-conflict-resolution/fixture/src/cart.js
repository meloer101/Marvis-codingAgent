import { COUPONS } from './coupons.js';

/**
 * @typedef {object} LineItem
 * @property {string} sku
 * @property {number} price unit price in dollars
 * @property {number} qty
 */

/** Round a dollar amount to whole cents. */
export function roundCents(amount) {
  return Math.round(amount * 100) / 100;
}

/**
<<<<<<< HEAD
 * Sales tax on `amount`, rounded to cents.
=======
 * Sum of price × qty over the items, rounded to cents.
>>>>>>> discounts
 *
 * @param {number} amount dollars
 * @param {number} taxRate a fraction: 0.0825 for 8.25%
 * @returns {number}
 */
<<<<<<< HEAD
export function salesTax(amount, taxRate) {
  return roundCents(amount * taxRate);
}

/**
 * Order total including sales tax, rounded to cents.
 *
 * @param {LineItem[]} items
 * @param {{ taxRate?: number }} [options] taxRate is a fraction: 0.0825 for 8.25%
 * @returns {number}
 */
export function total(items, { taxRate = 0 } = {}) {
  let sum = 0;
  for (const item of items) sum += item.price * item.qty;
  const tax = salesTax(sum, taxRate);
  return roundCents(sum + tax);
=======
export function subtotal(items) {
  return roundCents(items.reduce((sum, item) => sum + item.price * item.qty, 0));
}

/**
 * How much `coupon` takes off an order of `amount` dollars, rounded to cents.
 * No coupon, or an order below the coupon's minimum, gets nothing off; an
 * unknown code throws.
 *
 * @param {number} amount
 * @param {string} [coupon]
 * @returns {number}
 */
export function discount(amount, coupon) {
  if (!coupon) return 0;
  const rule = COUPONS[coupon];
  if (!rule) throw new Error(`unknown coupon: ${coupon}`);
  if (amount < rule.minOrder) return 0;
  const off = rule.type === 'percent' ? (amount * rule.value) / 100 : rule.value;
  return roundCents(Math.min(off, amount));
}

/**
 * Order total after any coupon, rounded to cents.
 *
 * @param {LineItem[]} items
 * @param {{ coupon?: string }} [options]
 * @returns {number}
 */
export function total(items, { coupon } = {}) {
  const sum = subtotal(items);
  return roundCents(sum - discount(sum, coupon));
>>>>>>> discounts
}
