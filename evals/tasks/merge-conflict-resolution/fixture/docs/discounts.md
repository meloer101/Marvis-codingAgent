# Discounts

Checkout accepts one coupon code per order. The codes live in
`src/coupons.js`:

| code      | discount          | minimum order |
|-----------|-------------------|---------------|
| `SAVE10`  | 10% off           | $50           |
| `FIVEOFF` | $5 off            | $25           |

## Rules

- Coupons apply to the merchandise subtotal — the sum of price × quantity,
  before tax. The minimum-order check uses that same pre-tax subtotal.
- Sales tax is charged on what the customer actually pays for the goods, i.e.
  on the subtotal after the discount.
- An order below a coupon's minimum is charged in full; the coupon is simply
  not applied.
- An unknown code is an error, so the checkout can tell the customer.
- The discount is rounded to cents, and never exceeds the subtotal.
