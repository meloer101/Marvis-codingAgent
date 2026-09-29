import { getUser, listUsers } from '../db.js';
import { sendError, sendOk } from '../http.js';

export function registerUserRoutes(router) {
  router.get('/users/:id', (req, res) => {
    const user = getUser(req.params.id);
    if (!user) return sendError(res, 404, 'not_found', `user ${req.params.id} not found`);
    sendOk(res, user);
  });

  router.get('/users', (req, res) => {
    const users = listUsers();
    sendOk(res, users, { total: users.length });
  });
}
