import { getTodo, getUser, insertTodo } from '../db.js';
import { BadJsonError, readJson, sendCreated, sendError, sendOk } from '../http.js';

export const STATUSES = ['open', 'done'];

export function registerTodoRoutes(router) {
  router.get('/todos/:id', (req, res) => {
    const todo = getTodo(req.params.id);
    if (!todo) return sendError(res, 404, 'not_found', `todo ${req.params.id} not found`);
    sendOk(res, todo);
  });

  router.post('/todos', async (req, res) => {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      if (err instanceof BadJsonError) return sendError(res, 400, 'invalid_param', err.message);
      throw err;
    }

    const { title, status = 'open', userId = null } = body;
    if (typeof title !== 'string' || title.trim() === '' || title.length > 200) {
      return sendError(res, 400, 'invalid_param', 'title must be a non-empty string of at most 200 characters');
    }
    if (!STATUSES.includes(status)) {
      return sendError(res, 400, 'invalid_param', `status must be one of: ${STATUSES.join(', ')}`);
    }
    if (userId !== null && !getUser(userId)) {
      return sendError(res, 400, 'invalid_param', `user ${userId} does not exist`);
    }

    sendCreated(res, insertTodo({ title: title.trim(), status, userId }));
  });
}
