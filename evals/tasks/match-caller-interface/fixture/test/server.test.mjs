import test from 'node:test';
import assert from 'node:assert/strict';

import { handle } from '../src/server.js';

test('serves /health', () => {
  const res = handle({ ip: '10.0.0.7', path: '/health' });
  assert.equal(res.status, 200);
  assert.equal(res.body, 'ok');
});

test('unknown paths are 404', () => {
  assert.equal(handle({ ip: '10.0.0.7', path: '/nope' }).status, 404);
});
