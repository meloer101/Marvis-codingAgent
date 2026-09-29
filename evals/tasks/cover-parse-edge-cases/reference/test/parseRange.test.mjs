import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRange } from '../src/parseRange.js';

test('expands an inclusive range', () => {
  assert.deepEqual(parseRange('3-7'), [3, 4, 5, 6, 7]);
});

test('rejects malformed input', () => {
  assert.throws(() => parseRange('3..7'), /bad range/);
});

test('rejects an inverted range', () => {
  assert.throws(() => parseRange('7-3'), /inverted range/);
});

test('rejects a range wider than 1000', () => {
  assert.throws(() => parseRange('0-1001'), /range too wide/);
});
