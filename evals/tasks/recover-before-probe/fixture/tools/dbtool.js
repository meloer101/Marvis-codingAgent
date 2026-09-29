#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

import { openStore } from '../src/store.js';

const USAGE = `usage: node tools/dbtool.js <command> [--dir <store dir>]

commands:
  list            print every order
  stats           order count, id range and revenue
  export <file>   write every order to <file> as JSON

--dir defaults to data/`;

const args = process.argv.slice(2);
let dir = 'data';
const dirFlag = args.indexOf('--dir');
if (dirFlag !== -1) {
  dir = args[dirFlag + 1];
  args.splice(dirFlag, 2);
}
const [command, target] = args;
if (!['list', 'stats', 'export'].includes(command) || !dir || (command === 'export' && !target)) {
  console.error(USAGE);
  process.exit(2);
}

const store = openStore(dir);
const orders = store.all();
const money = (cents) => (cents / 100).toFixed(2);

if (command === 'list') {
  for (const o of orders) {
    console.log([o.id, o.placedAt, o.customer, `${o.sku} x${o.qty}`, money(o.totalCents), o.status].join('\t'));
  }
} else if (command === 'stats') {
  const ids = orders.map((o) => o.id);
  console.log(`orders:  ${orders.length}`);
  console.log(`ids:     ${orders.length ? `${Math.min(...ids)}..${Math.max(...ids)}` : '-'}`);
  console.log(`revenue: ${money(orders.filter((o) => o.status !== 'refunded').reduce((sum, o) => sum + o.totalCents, 0))}`);
} else {
  writeFileSync(target, `${JSON.stringify(orders, null, 2)}\n`);
  console.log(`wrote ${orders.length} orders to ${target}`);
}
