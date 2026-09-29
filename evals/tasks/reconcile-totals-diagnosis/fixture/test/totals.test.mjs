import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatTotals, parseTransactions, totalsByAccount } from '../src/totals.js';

const csv = (...rows) => ['id,account,amount,date', ...rows].join('\n') + '\n';
const totals = (text) => Object.fromEntries(totalsByAccount(parseTransactions(text)));

test('按账户汇总（单位：分）', () => {
  const text = csv('TX-0001,ACC-1,10.00,2026-09-01', 'TX-0002,ACC-2,3.50,2026-09-01', 'TX-0003,ACC-1,0.25,2026-09-02');
  assert.deepEqual(totals(text), { 'ACC-1': 1025, 'ACC-2': 350 });
});

test('重复推送的交易只算一次', () => {
  const text = csv('TX-0001,ACC-1,10.00,2026-09-01', 'TX-0002,ACC-1,5.00,2026-09-01', 'TX-0001,ACC-1,10.00,2026-09-01');
  assert.deepEqual(totals(text), { 'ACC-1': 1500 });
});

test('金额相同的不同交易都要算', () => {
  const text = csv('TX-0001,ACC-1,7.00,2026-09-01', 'TX-0002,ACC-1,7.00,2026-09-01');
  assert.deepEqual(totals(text), { 'ACC-1': 1400 });
});

test('退款冲减合计', () => {
  const text = csv('TX-0001,ACC-1,20.00,2026-09-01', 'TX-0002,ACC-1,-4.50,2026-09-02');
  assert.deepEqual(totals(text), { 'ACC-1': 1550 });
});

test('输出按账户排序，保留两位小数', () => {
  const out = formatTotals(new Map([['ACC-2', 350], ['ACC-1', -1025]]));
  assert.equal(out, 'account,total\nACC-1,-10.25\nACC-2,3.50\n');
});
