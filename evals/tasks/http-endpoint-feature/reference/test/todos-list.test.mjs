import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createServer } from '../src/server.js';

let server;
let baseUrl;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

async function walk(query) {
  const ids = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const sep = query ? '&' : '';
    const { status, body } = await get(`/todos?${query}${cursor ? `${sep}cursor=${cursor}` : ''}`);
    assert.equal(status, 200);
    ids.push(...body.data.map((t) => t.id));
    if (body.nextCursor === null) return ids;
    assert.equal(body.nextCursor, body.data.at(-1).id);
    cursor = body.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

describe('GET /todos', () => {
  it('returns the first 20 todos by id with a cursor', async () => {
    const { status, body } = await get('/todos');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.length, 20);
    assert.equal(body.data[0].id, 't001');
    assert.equal(body.data[19].id, 't020');
    assert.equal(body.nextCursor, 't020');
  });

  it('walks every todo in id order', async () => {
    const ids = await walk('limit=7');
    assert.equal(ids.length, 57);
    assert.deepEqual(ids, [...ids].sort());
  });

  it('filters by status across pages', async () => {
    const open = await walk('status=open');
    assert.equal(open.length, 40);
    const done = await walk('status=done&limit=5');
    assert.equal(done.length, 17);
    const { body } = await get('/todos?status=done&limit=3');
    assert.ok(body.data.every((t) => t.status === 'done'));
  });

  it('has no next page when the last page is exactly full', async () => {
    const first = await get('/todos?status=open');
    const second = await get(`/todos?status=open&cursor=${first.body.nextCursor}`);
    assert.equal(second.body.data.length, 20);
    assert.equal(second.body.nextCursor, null);
  });

  it('accepts limit=100', async () => {
    const { status, body } = await get('/todos?limit=100');
    assert.equal(status, 200);
    assert.equal(body.data.length, 57);
    assert.equal(body.nextCursor, null);
  });

  for (const query of ['limit=0', 'limit=101', 'limit=-1', 'limit=abc', 'limit=2.5', 'status=closed', 'cursor=t999']) {
    it(`rejects ${query}`, async () => {
      const { status, body } = await get(`/todos?${query}`);
      assert.equal(status, 400);
      assert.equal(body.ok, false);
      assert.equal(body.error.code, 'invalid_param');
    });
  }
});
