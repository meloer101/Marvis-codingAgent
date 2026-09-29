import { getTodo, getUser, insertTodo, listTodos } from '../db.js';
import { BadJsonError, readJson, sendCreated, sendError, sendOk } from '../http.js';

export const STATUSES = ['open', 'done'];

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function registerTodoRoutes(router) {
  router.get('/todos/:id', (req, res) => {
    const todo = getTodo(req.params.id);
    if (!todo) return sendError(res, 404, 'not_found', `todo ${req.params.id} not found`);
    sendOk(res, todo);
  });

  // Registered after /todos/:id: routes match by prefix, first one wins.
  router.get('/todos', (req, res) => {
    const { status, limit: rawLimit, cursor } = req.query;
    if (status !== undefined && !STATUSES.includes(status)) {
      return sendError(res, 400, 'invalid_param', `status must be one of: ${STATUSES.join(', ')}`);
    }
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
      limit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
      if (!(limit >= 1 && limit <= MAX_LIMIT)) {
        return sendError(res, 400, 'invalid_param', `limit must be an integer between 1 and ${MAX_LIMIT}`);
      }
    }
    if (cursor !== undefined && !getTodo(cursor)) {
      return sendError(res, 400, 'invalid_param', `cursor ${cursor} does not match any todo`);
    }

    const matching = listTodos()
      .filter((t) => (status === undefined || t.status === status) && (cursor === undefined || t.id > cursor))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const page = matching.slice(0, limit);
    const nextCursor = matching.length > limit ? page[page.length - 1].id : null;
    sendOk(res, page, { nextCursor });
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
