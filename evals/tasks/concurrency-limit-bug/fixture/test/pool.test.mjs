import test from 'node:test';
import assert from 'node:assert/strict';

import { mapLimit } from '../src/pool.js';

test('maps every item', async () => {
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => n * 10);
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
});
