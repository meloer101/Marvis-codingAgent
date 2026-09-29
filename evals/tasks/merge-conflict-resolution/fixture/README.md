# cart

Pricing helpers for the checkout service.

## Usage

```js
import { total } from './src/cart.js';

const items = [
  { sku: 'mug', price: 12.5, qty: 2 },
  { sku: 'tee', price: 18, qty: 1 },
];

total(items); // 43
```

<<<<<<< HEAD
### Sales tax

Pass `taxRate` (a fraction, so `0.0825` for 8.25%) to add sales tax:

```js
total(items, { taxRate: 0.0825 }); // 46.55
=======
### Coupons

Pass a `coupon` code to take a discount off the order. See
[docs/discounts.md](docs/discounts.md) for the codes and the rules.

```js
total(items, { coupon: 'FIVEOFF' }); // 38
>>>>>>> discounts
```

All amounts are in dollars; results are rounded to whole cents.

## Development

```
npm test
```
