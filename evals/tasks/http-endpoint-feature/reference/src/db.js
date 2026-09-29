import { todos as seedTodos, users as seedUsers } from './seed.js';

const users = new Map(seedUsers.map((u) => [u.id, { ...u }]));
const todos = new Map(seedTodos.map((t) => [t.id, { ...t }]));
let lastTodoNumber = Math.max(...seedTodos.map((t) => Number(t.id.slice(1))));

export function listUsers() {
  return [...users.values()];
}

export function getUser(id) {
  return users.get(id) ?? null;
}

export function listTodos() {
  return [...todos.values()];
}

export function getTodo(id) {
  return todos.get(id) ?? null;
}

export function insertTodo({ title, status, userId }) {
  lastTodoNumber += 1;
  const todo = {
    id: `t${String(lastTodoNumber).padStart(3, '0')}`,
    title,
    status,
    userId,
    createdAt: new Date().toISOString(),
  };
  todos.set(todo.id, todo);
  return todo;
}
