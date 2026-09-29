# todo-api

A small JSON API for the team's todo list. Plain `node:http`, no dependencies;
data lives in memory and is seeded from `src/seed.js` on start.

```sh
npm start          # listens on $PORT (default 3000)
npm test
```

## Responses

Every response is JSON. Success:

```json
{ "ok": true, "data": { "id": "t012", "title": "Write release notes for 0.3", "status": "open", "userId": "u03", "createdAt": "2026-06-13T12:30:00Z" } }
```

List endpoints may add fields next to `data` (for example `total`).

Errors:

```json
{ "ok": false, "error": { "code": "not_found", "message": "todo t404 not found" } }
```

| Code            | HTTP status | When                                   |
| --------------- | ----------- | -------------------------------------- |
| `not_found`     | 404         | unknown id or route                    |
| `invalid_param` | 400         | a request parameter or body is invalid |

## Endpoints

| Method | Path          | Description                                             |
| ------ | ------------- | ------------------------------------------------------- |
| GET    | `/users`      | All users, with `total`                                 |
| GET    | `/users/:id`  | One user                                                |
| GET    | `/todos/:id`  | One todo                                                |
| POST   | `/todos`      | Create a todo. Body: `title` (required), `status` (`open` or `done`, default `open`), `userId` |

A todo looks like `{ id, title, status, userId, createdAt }`; ids are `t001`, `t002`, …
