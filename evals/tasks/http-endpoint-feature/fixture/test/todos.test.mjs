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

async function request(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('GET /todos/:id', () => {
  it('returns the todo', async () => {
    const { status, body } = await request('GET', '/todos/t012');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.id, 't012');
    assert.equal(body.data.title, 'Write release notes for 0.3');
    assert.equal(body.data.status, 'open');
  });

  it('404s for an unknown id', async () => {
    const { status, body } = await request('GET', '/todos/t404');
    assert.equal(status, 404);
    assert.deepEqual(body, { ok: false, error: { code: 'not_found', message: 'todo t404 not found' } });
  });
});

describe('POST /todos', () => {
  it('creates a todo', async () => {
    const created = await request('POST', '/todos', { title: '  Buy printer paper ', userId: 'u02' });
    assert.equal(created.status, 201);
    assert.equal(created.body.ok, true);
    assert.equal(created.body.data.title, 'Buy printer paper');
    assert.equal(created.body.data.status, 'open');
    assert.equal(created.body.data.userId, 'u02');

    const fetched = await request('GET', `/todos/${created.body.data.id}`);
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.body.data, created.body.data);
  });

  it('rejects a missing title', async () => {
    const { status, body } = await request('POST', '/todos', { status: 'open' });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'invalid_param');
  });

  it('rejects an unknown status', async () => {
    const { status, body } = await request('POST', '/todos', { title: 'x', status: 'archived' });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_param');
  });

  it('rejects an unknown user', async () => {
    const { status, body } = await request('POST', '/todos', { title: 'x', userId: 'u99' });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_param');
  });
});
