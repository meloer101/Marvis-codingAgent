import http from 'node:http';

import { sendError } from './http.js';
import { Router } from './router.js';
import { registerTodoRoutes } from './routes/todos.js';
import { registerUserRoutes } from './routes/users.js';

export function createServer() {
  const router = new Router();
  registerUserRoutes(router);
  registerTodoRoutes(router);

  return http.createServer(async (req, res) => {
    const route = router.lookup(req.method, req.url);
    if (!route) {
      sendError(res, 404, 'not_found', `no route for ${req.method} ${req.url}`);
      return;
    }
    req.params = route.params;
    req.query = route.query;
    try {
      await route.handler(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendError(res, 500, 'internal', 'internal server error');
    }
  });
}
