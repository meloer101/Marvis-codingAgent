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

describe('users', () => {
  it('lists every user with a total', async () => {
    const { status, body } = await get('/users');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.total, 5);
    assert.deepEqual(
      body.data.map((u) => u.id),
      ['u01', 'u02', 'u03', 'u04', 'u05'],
    );
  });

  it('returns one user', async () => {
    const { status, body } = await get('/users/u03');
    assert.equal(status, 200);
    assert.equal(body.data.name, 'Carla Diaz');
  });

  it('404s for an unknown user', async () => {
    const { status, body } = await get('/users/u42');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'not_found');
  });

  it('404s for an unknown route', async () => {
    const { status, body } = await get('/projects');
    assert.equal(status, 404);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'not_found');
  });
});
