import http from 'node:http';

import { createLimiter } from './ratelimit.js';

const limiter = createLimiter({ capacity: 20, refillPerSec: 5 });

const routes = {
  '/health': () => ({ status: 200, headers: {}, body: 'ok' }),
  '/version': () => ({ status: 200, headers: {}, body: '1.4.2' }),
};

export function handle(req) {
  const { ok, retryAfterMs } = limiter.take(req.ip);
  if (!ok) {
    return {
      status: 429,
      headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
      body: 'Too Many Requests',
    };
  }
  const route = routes[req.path];
  return route ? route(req) : { status: 404, headers: {}, body: 'Not Found' };
}

export function createServer() {
  return http.createServer((req, res) => {
    const out = handle({ ip: req.socket.remoteAddress, path: req.url });
    res.writeHead(out.status, out.headers).end(out.body);
  });
}
