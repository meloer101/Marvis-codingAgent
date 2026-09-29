/**
 * Coupon codes the checkout accepts.
 *
 * - `percent`: takes `value` percent off the order.
 * - `fixed`: takes `value` dollars off the order.
 *
 * A coupon only applies when the order is at least `minOrder` dollars.
 */
export const COUPONS = {
  SAVE10: { type: 'percent', value: 10, minOrder: 50 },
  FIVEOFF: { type: 'fixed', value: 5, minOrder: 25 },
};
