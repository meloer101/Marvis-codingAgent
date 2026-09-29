# order-store

The small append-only store behind the order intake service.

## Layout

```
data/orders.db          the store: a `STORE v1` header, then one JSON order per line
data/orders.db-journal  the batch currently being written, if any
```

The intake service writes each batch of orders to `orders.db-journal` first.
The journal is folded into `orders.db` (and removed) the next time the store
is opened — see `openStore` in `src/store.js`.

## Tools

```
node tools/dbtool.js list              # every order
node tools/dbtool.js stats             # count, id range, revenue
node tools/dbtool.js export <file>     # all orders as a JSON array
```

All commands take `--dir <path>` to point at a store other than `data/`.
`npm run db -- <command>` works too.

## Tests

`npm test`
