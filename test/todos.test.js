import test from 'node:test';
import assert from 'node:assert/strict';
import { addTodo, completeTodo, removeTodo, editTodo, activeTodos, completedInRange, startOfDay, startOfWeek, parseTodoInput, isOverdue, sortTodosForDisplay, todoToGraphTask, graphTaskToTodo, resolveSyncConflict } from '../src/todos.js';

test('addTodo: appends a new active todo with the given text', () => {
  const t1 = addTodo([], '写周报', 1000);
  assert.equal(t1.length, 1);
  assert.equal(t1[0].text, '写周报');
  assert.equal(t1[0].done, false);
  assert.equal(t1[0].createdAt, 1000);
});

test('addTodo: blank/whitespace-only text is a no-op', () => {
  assert.deepEqual(addTodo([], ''), []);
  assert.deepEqual(addTodo([], '   '), []);
});

test('addTodo: two todos added at the same ms get distinct ids', () => {
  const t1 = addTodo(addTodo([], 'a', 1000), 'b', 1000);
  assert.notEqual(t1[0].id, t1[1].id);
});

test('completeTodo: marks the matching todo done with a completedAt, leaves others untouched', () => {
  const todos = addTodo(addTodo([], 'a', 1000), 'b', 1000);
  const done = completeTodo(todos, todos[0].id, 2000);
  assert.equal(done[0].done, true);
  assert.equal(done[0].completedAt, 2000);
  assert.equal(done[1].done, false);
});

test('removeTodo: drops the matching todo only', () => {
  const todos = addTodo(addTodo([], 'a', 1000), 'b', 1000);
  const rest = removeTodo(todos, todos[0].id);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].text, 'b');
});

test('activeTodos: excludes done todos', () => {
  const todos = addTodo(addTodo([], 'a', 1000), 'b', 1000);
  const done = completeTodo(todos, todos[0].id, 2000);
  assert.deepEqual(activeTodos(done).map((t) => t.text), ['b']);
});

test('completedInRange: only done todos completed within [start, end)', () => {
  let todos = addTodo(addTodo(addTodo([], 'a', 1000), 'b', 1000), 'c', 1000);
  todos = completeTodo(todos, todos[0].id, 500); // before range
  todos = completeTodo(todos, todos[1].id, 1500); // inside range
  // todos[2] never completed
  const inRange = completedInRange(todos, 1000, 2000);
  assert.deepEqual(inRange.map((t) => t.text), ['b']);
});

test('startOfDay: returns local midnight for the given date', () => {
  const d = new Date(2026, 2, 15, 14, 37, 22);
  const mid = new Date(startOfDay(d));
  assert.equal(mid.getFullYear(), 2026);
  assert.equal(mid.getMonth(), 2);
  assert.equal(mid.getDate(), 15);
  assert.equal(mid.getHours(), 0);
  assert.equal(mid.getMinutes(), 0);
});

test('startOfWeek: Wednesday rolls back to Monday of the same week', () => {
  const wed = new Date(2026, 2, 18); // a Wednesday
  const mon = new Date(startOfWeek(wed));
  assert.equal(mon.getDay(), 1);
  assert.equal(mon.getDate(), 16);
});

test('startOfWeek: Sunday rolls back to the Monday six days earlier', () => {
  const sun = new Date(2026, 2, 15); // a Sunday
  const mon = new Date(startOfWeek(sun));
  assert.equal(mon.getDay(), 1);
  assert.equal(mon.getDate(), 9);
});

test('parseTodoInput: extracts one or more #tags and strips them from text', () => {
  const r = parseTodoInput('写周报 #work #urgent');
  assert.equal(r.text, '写周报');
  assert.deepEqual(r.tags, ['work', 'urgent']);
});

test('parseTodoInput: @today/@明天 resolve to that day\'s local midnight relative to now', () => {
  const now = new Date(2026, 2, 15, 10, 0, 0).getTime(); // Sun Mar 15 2026, 10:00
  const today = parseTodoInput('写周报 @today', now);
  assert.equal(new Date(today.dueAt).getDate(), 15);
  assert.equal(new Date(today.dueAt).getHours(), 0);
  const tomorrow = parseTodoInput('写周报 @明天', now);
  assert.equal(new Date(tomorrow.dueAt).getDate(), 16);
});

test('parseTodoInput: @YYYY-MM-DD and @MM-DD both parse to that date', () => {
  const now = new Date(2026, 0, 1).getTime();
  const full = parseTodoInput('报税 @2026-04-15', now);
  assert.equal(new Date(full.dueAt).getFullYear(), 2026);
  assert.equal(new Date(full.dueAt).getMonth(), 3);
  assert.equal(new Date(full.dueAt).getDate(), 15);
  const short = parseTodoInput('报税 @4-15', now);
  assert.equal(new Date(short.dueAt).getMonth(), 3);
  assert.equal(new Date(short.dueAt).getDate(), 15);
});

test('parseTodoInput: unrecognized @mentions are left in the text, not eaten', () => {
  const r = parseTodoInput('ping @someone about this');
  assert.equal(r.text, 'ping @someone about this');
  assert.equal(r.dueAt, null);
});

test('parseTodoInput: no tags or date leaves tags empty and dueAt null', () => {
  const r = parseTodoInput('买菜');
  assert.deepEqual(r.tags, []);
  assert.equal(r.dueAt, null);
});

test('addTodo: stores parsed tags and dueAt on the created todo', () => {
  const now = new Date(2026, 2, 15).getTime();
  const t = addTodo([], '写周报 #work @today', now);
  assert.equal(t[0].text, '写周报');
  assert.deepEqual(t[0].tags, ['work']);
  assert.equal(new Date(t[0].dueAt).getDate(), 15);
});

test('isOverdue: false for a done todo even with a past dueAt', () => {
  const now = new Date(2026, 2, 15).getTime();
  const todo = { done: true, dueAt: new Date(2026, 2, 10).getTime() };
  assert.equal(isOverdue(todo, now), false);
});

test('isOverdue: false when dueAt is null', () => {
  assert.equal(isOverdue({ done: false, dueAt: null }, Date.now()), false);
});

test('isOverdue: true when dueAt is before the start of today', () => {
  const now = new Date(2026, 2, 15, 9, 0, 0).getTime();
  const todo = { done: false, dueAt: new Date(2026, 2, 14).getTime() };
  assert.equal(isOverdue(todo, now), true);
});

test('isOverdue: false when dueAt is today (not yet overdue until tomorrow)', () => {
  const now = new Date(2026, 2, 15, 9, 0, 0).getTime();
  const todo = { done: false, dueAt: new Date(2026, 2, 15).getTime() };
  assert.equal(isOverdue(todo, now), false);
});

test('editTodo: patches only the matching todo, leaves others untouched', () => {
  const todos = addTodo(addTodo([], 'a', 1000), 'b', 1000);
  const edited = editTodo(todos, todos[0].id, { text: 'a-renamed', importance: 2 });
  assert.equal(edited[0].text, 'a-renamed');
  assert.equal(edited[0].importance, 2);
  assert.equal(edited[1].text, 'b');
});

test('editTodo: no-op when id does not match anything', () => {
  const todos = addTodo([], 'a', 1000);
  const edited = editTodo(todos, 'nonexistent-id', { text: 'x' });
  assert.deepEqual(edited, todos);
});

test('sortTodosForDisplay: overdue items sort before everything else', () => {
  const now = new Date(2026, 2, 15).getTime();
  const overdue = { id: 'a', done: false, dueAt: new Date(2026, 2, 10).getTime() };
  const dueLater = { id: 'b', done: false, dueAt: new Date(2026, 2, 20).getTime() };
  const noDue = { id: 'c', done: false, dueAt: null };
  const sorted = sortTodosForDisplay([noDue, dueLater, overdue], now);
  assert.deepEqual(sorted.map((t) => t.id), ['a', 'b', 'c']);
});

test('sortTodosForDisplay: among due items, soonest due date comes first', () => {
  const now = new Date(2026, 2, 1).getTime();
  const dueLate = { id: 'a', done: false, dueAt: new Date(2026, 2, 20).getTime() };
  const dueSoon = { id: 'b', done: false, dueAt: new Date(2026, 2, 5).getTime() };
  const sorted = sortTodosForDisplay([dueLate, dueSoon], now);
  assert.deepEqual(sorted.map((t) => t.id), ['b', 'a']);
});

test('sortTodosForDisplay: items with no due date keep their original relative order', () => {
  const now = Date.now();
  const a = { id: 'a', done: false, dueAt: null };
  const b = { id: 'b', done: false, dueAt: null };
  const sorted = sortTodosForDisplay([a, b], now);
  assert.deepEqual(sorted.map((t) => t.id), ['a', 'b']);
});

test('addTodo: stamps updatedAt equal to createdAt and nulls externalId/externalProvider', () => {
  const t = addTodo([], '写周报', 1000);
  assert.equal(t[0].updatedAt, 1000);
  assert.equal(t[0].externalId, null);
  assert.equal(t[0].externalProvider, null);
});

test('completeTodo/editTodo: bump updatedAt to the mutation time', () => {
  const t = addTodo([], '写周报', 1000);
  const completed = completeTodo(t, t[0].id, 2000);
  assert.equal(completed[0].updatedAt, 2000);
  const edited = editTodo(t, t[0].id, { text: '写月报' }, 3000);
  assert.equal(edited[0].updatedAt, 3000);
  assert.equal(edited[0].text, '写月报');
});

test('todoToGraphTask: maps done/dueAt/tags to Graph todoTask shape', () => {
  const due = new Date(2026, 2, 15).getTime();
  const task = todoToGraphTask({ text: '写周报', done: false, dueAt: due, tags: ['work', 'urgent'] });
  assert.equal(task.title, '写周报');
  assert.equal(task.status, 'notStarted');
  assert.equal(task.dueDateTime.dateTime, new Date(due).toISOString());
  assert.deepEqual(task.categories, ['work', 'urgent']);
});

test('todoToGraphTask: done todo maps to status completed, no due date maps to null', () => {
  const task = todoToGraphTask({ text: '报税', done: true, dueAt: null, tags: [] });
  assert.equal(task.status, 'completed');
  assert.equal(task.dueDateTime, null);
});

test('graphTaskToTodo: maps Graph todoTask fields back to local todo shape', () => {
  const iso = new Date(2026, 2, 15).toISOString();
  const patch = graphTaskToTodo({ title: '写周报', status: 'notStarted', dueDateTime: { dateTime: iso }, categories: ['work'], lastModifiedDateTime: iso });
  assert.equal(patch.text, '写周报');
  assert.equal(patch.done, false);
  assert.equal(patch.dueAt, new Date(iso).getTime());
  assert.deepEqual(patch.tags, ['work']);
  assert.equal(patch.updatedAt, new Date(iso).getTime());
});

test('resolveSyncConflict: no local todo means pull (create locally from remote)', () => {
  assert.equal(resolveSyncConflict(null, Date.now()), 'pull');
});

test('resolveSyncConflict: remote more recently modified than local wins (pull)', () => {
  const local = { updatedAt: 1000 };
  assert.equal(resolveSyncConflict(local, 2000), 'pull');
});

test('resolveSyncConflict: local more recently modified than remote wins (push)', () => {
  const local = { updatedAt: 2000 };
  assert.equal(resolveSyncConflict(local, 1000), 'push');
});

test('resolveSyncConflict: equal timestamps favor local (push, nothing to overwrite)', () => {
  const local = { updatedAt: 1500 };
  assert.equal(resolveSyncConflict(local, 1500), 'push');
});
