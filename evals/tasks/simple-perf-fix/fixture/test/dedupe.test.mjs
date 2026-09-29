import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findDuplicateEmails, normalizeEmail } from '../src/dedupe.js';

const users = (...emails) => emails.map((email, i) => ({ id: i + 1, name: `user ${i + 1}`, email }));

test('normalizeEmail trims, lower-cases and drops the +tag', () => {
  assert.equal(normalizeEmail('  Ann.Lee+news@Example.COM '), 'ann.lee@example.com');
  assert.equal(normalizeEmail('ben@example.com'), 'ben@example.com');
  assert.equal(normalizeEmail('carla@shop+eu.example'), 'carla@shop+eu.example');
});

test('no shared addresses means no groups', () => {
  assert.deepEqual(findDuplicateEmails([]), []);
  assert.deepEqual(findDuplicateEmails(users('ann@example.com', 'ben@example.com')), []);
});

test('groups rows whose addresses normalize to the same value', () => {
  const rows = users('ann@example.com', 'ben@example.com', ' ANN+shop@example.com');
  assert.deepEqual(findDuplicateEmails(rows), [[0, 2]]);
});

test('a group lists every matching row, in index order', () => {
  const rows = users('dev@mail.test', 'eun@mail.test', 'Dev@mail.test', 'dev+1@mail.test');
  assert.deepEqual(findDuplicateEmails(rows), [[0, 2, 3]]);
});

test('reports each shared address once', () => {
  const rows = users('a@x.test', 'b@x.test', 'a@x.test', 'c@x.test', 'b@x.test', 'c@x.test');
  assert.deepEqual(findDuplicateEmails(rows), [[0, 2], [1, 4], [3, 5]]);
});
