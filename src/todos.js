// Pure todo-list + date-bucketing logic, kept separate from main.js so it's
// unit testable without touching fs/IPC. main.js owns persistence (reading/
// writing data/todos.json) and calls these as plain data transforms.

// Todoist-style inline quick-add syntax, parsed out of the same single text
// field the UI already has everywhere (pet panel and dashboard both) --
// avoids needing separate tag/date inputs on a 260px-wide panel. `#tag`
// (repeatable) becomes a tag; `@today`/`@明天`/`@2026-08-10`/`@8-10` becomes
// a due date (stored as that day's local midnight, so "overdue" reads as a
// whole-day comparison, not an hour-of-day one). Unrecognized `@mentions`
// are left in the text untouched rather than silently eaten.
const DATE_SHORTHANDS = { 今天: 0, today: 0, 明天: 1, tomorrow: 1, 后天: 2 };

function parseDueDateToken(token, now) {
  const key = token.toLowerCase();
  if (key in DATE_SHORTHANDS) {
    const base = new Date(now);
    base.setDate(base.getDate() + DATE_SHORTHANDS[key]);
    return new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
  }
  const full = token.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const short = !full && token.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!full && !short) return null;
  const nowDate = new Date(now);
  const year = full ? Number(full[1]) : nowDate.getFullYear();
  const month = full ? Number(full[2]) : Number(short[1]);
  const day = full ? Number(full[3]) : Number(short[2]);
  const d = new Date(year, month - 1, day);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export function parseTodoInput(text, now = Date.now()) {
  const tags = [];
  let dueAt = null;
  const cleaned = String(text ?? '')
    .replace(/#(\S+)/g, (_, tag) => {
      tags.push(tag);
      return '';
    })
    .replace(/@(\S+)/g, (whole, token) => {
      const parsed = parseDueDateToken(token, now);
      if (parsed === null) return whole;
      dueAt = parsed;
      return '';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { text: cleaned, tags, dueAt };
}

export function addTodo(todos, text, now = Date.now()) {
  const { text: cleaned, tags, dueAt } = parseTodoInput(text, now);
  if (!cleaned) return todos;
  const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
  return [
    ...todos,
    // updatedAt starts equal to createdAt and bumps on every mutation --
    // the sync engine's conflict resolution (see outlook-sync.js) is
    // last-write-wins by comparing this against the provider's own
    // lastModifiedDateTime, so it has to track *content* changes, not just
    // existence. externalId/externalProvider are null until a sync creates
    // the matching remote task and stamps them back on.
    { id, text: cleaned.slice(0, 200), done: false, createdAt: now, completedAt: null, updatedAt: now, tags, dueAt, externalId: null, externalProvider: null },
  ];
}

export function completeTodo(todos, id, now = Date.now()) {
  return todos.map((t) => (t.id === id ? { ...t, done: true, completedAt: now, updatedAt: now } : t));
}

export function removeTodo(todos, id) {
  return todos.filter((t) => t.id !== id);
}

// Direct field patch (text/tags/dueAt/importance), not re-run through
// parseTodoInput -- editing is for fixing/adjusting an existing todo's
// structured fields individually (e.g. from a form), not re-typing the
// whole "#tag @date" shorthand.
export function editTodo(todos, id, patch, now = Date.now()) {
  return todos.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: now } : t));
}

export function isOverdue(todo, now = Date.now()) {
  return !todo.done && todo.dueAt != null && todo.dueAt < startOfDay(new Date(now));
}

// Overdue items first, then soonest-due, then everything without a due
// date keeps its original relative order at the end (stable sort) -- so a
// due date actually makes a todo more likely to be seen, not just a label
// nobody re-reads.
export function sortTodosForDisplay(todos, now = Date.now()) {
  return [...todos].sort((a, b) => {
    const aOverdue = isOverdue(a, now);
    const bOverdue = isOverdue(b, now);
    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
    const aDue = a.dueAt ?? Infinity;
    const bDue = b.dueAt ?? Infinity;
    return aDue - bDue;
  });
}

// --- Outlook sync mapping (pure) -----------------------------------------
// The actual HTTP calls live in outlook-sync.js (main-process only, needs
// fetch + stored tokens); these are just the pure shape-translation and
// conflict-resolution pieces, kept here so they're unit-testable without a
// real Microsoft Graph account.

// Local todo -> Microsoft Graph's todoTask resource shape.
// https://learn.microsoft.com/en-us/graph/api/resources/todotask
export function todoToGraphTask(todo) {
  return {
    title: todo.text,
    status: todo.done ? 'completed' : 'notStarted',
    dueDateTime: todo.dueAt ? { dateTime: new Date(todo.dueAt).toISOString(), timeZone: 'UTC' } : null,
    categories: todo.tags ?? [],
  };
}

// Microsoft Graph's todoTask resource -> local todo fields (a partial
// patch, not a full todo -- id/createdAt/externalId are handled by the
// caller since they depend on whether this is a new or existing local
// todo).
export function graphTaskToTodo(task) {
  return {
    text: String(task.title ?? '').slice(0, 200),
    done: task.status === 'completed',
    dueAt: task.dueDateTime?.dateTime ? new Date(task.dueDateTime.dateTime).getTime() : null,
    tags: Array.isArray(task.categories) ? task.categories : [],
    updatedAt: task.lastModifiedDateTime ? new Date(task.lastModifiedDateTime).getTime() : Date.now(),
  };
}

// Continuous two-way sync needs a rule for "which side wins" when both
// changed -- last-write-wins by comparing local updatedAt against the
// remote task's lastModifiedDateTime is the simplest rule that's still
// predictable to a user (whichever you touched more recently is the one
// that sticks). No local copy at all means create it from the remote side.
export function resolveSyncConflict(localTodo, remoteUpdatedAt) {
  if (!localTodo) return 'pull';
  return remoteUpdatedAt > localTodo.updatedAt ? 'pull' : 'push';
}

export function activeTodos(todos) {
  return todos.filter((t) => !t.done);
}

export function completedInRange(todos, startMs, endMs) {
  return todos.filter((t) => t.done && t.completedAt >= startMs && t.completedAt < endMs);
}

// Local-time midnight for `now` -- day boundaries should match the user's
// own sense of "today", not UTC's.
export function startOfDay(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

// Monday as the start of the week (ISO-ish; day 0=Sun..6=Sat in JS).
export function startOfWeek(now = new Date()) {
  const day = now.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday).getTime();
}
