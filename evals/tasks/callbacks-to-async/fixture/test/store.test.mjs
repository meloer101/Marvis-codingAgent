import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStore } from '../src/store.js';

const freshStore = () => createStore(join(mkdtempSync(join(tmpdir(), 'kv-test-')), 'data'));

test('set then get returns the value', (t, done) => {
  const store = freshStore();
  store.set('greeting', 'hello', (err) => {
    assert.ifError(err);
    store.get('greeting', (err, value) => {
      assert.ifError(err);
      assert.equal(value, 'hello');
      done();
    });
  });
});

test('values round-trip as JSON', (t, done) => {
  const store = freshStore();
  const value = { tags: ['a', 'b'], count: 3, nested: { ok: true } };
  store.set('doc', value, (err) => {
    assert.ifError(err);
    store.get('doc', (err, got) => {
      assert.ifError(err);
      assert.deepEqual(got, value);
      done();
    });
  });
});

test('keys may contain slashes and colons', (t, done) => {
  const store = freshStore();
  store.set('user:42/profile', { name: 'Ada' }, (err) => {
    assert.ifError(err);
    store.get('user:42/profile', (err, got) => {
      assert.ifError(err);
      assert.deepEqual(got, { name: 'Ada' });
      done();
    });
  });
});

test('list returns the keys with a prefix, sorted', (t, done) => {
  const store = freshStore();
  store.set('user:2', 2, () => {
    store.set('user:1', 1, () => {
      store.set('order:1', 'x', () => {
        store.list('user:', (err, keys) => {
          assert.ifError(err);
          assert.deepEqual(keys, ['user:1', 'user:2']);
          done();
        });
      });
    });
  });
});

test('an empty store lists no keys', (t, done) => {
  freshStore().list('', (err, keys) => {
    assert.ifError(err);
    assert.deepEqual(keys, []);
    done();
  });
});

test('del removes a key', (t, done) => {
  const store = freshStore();
  store.set('a', 1, () => {
    store.set('b', 2, () => {
      store.del('a', (err) => {
        assert.ifError(err);
        store.list('', (err, keys) => {
          assert.ifError(err);
          assert.deepEqual(keys, ['b']);
          done();
        });
      });
    });
  });
});
