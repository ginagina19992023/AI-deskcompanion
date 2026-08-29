// Serializes every local Ollama call this app makes (chat + vision +
// memory embedding) so they never run concurrently. Confirmed live via
// `ollama ps` on this machine: every loaded model shows size_vram: 0 -- no
// GPU offload at all, pure CPU inference -- and each individual call
// (chat, screen-tip vision, memory embedding) has been measured taking
// tens of seconds to over a minute on its own. Running several
// concurrently doesn't just queue politely on a GPU scheduler; CPU-only
// Ollama repeatedly evicts and reloads whichever model isn't currently
// resident, which turns what should be an isolated ~22s chat reply into
// a multi-minute stall.
//
// Two-tier priority, not plain FIFO: a chat send is something the user is
// actively watching a reply for, while screen-tips/memory-extraction/
// memory-embedding are ambient conveniences nobody is staring at a
// spinner for. Without priority, a chat message that lands right after
// the 90s screen-tip timer fires just sits behind it (and behind whatever
// else queued up in the meantime) for as long as those take -- which is
// exactly what reproduced live as a chat message that "sends but never
// replies." High-priority work always jumps ahead of anything still
// *waiting*; a call already in flight can't be preempted (its fetch is
// already running), so the most a chat send ever waits on is the one
// call already running when it arrives, not an entire ambient backlog.
let running = false;
const highQueue = [];
const normalQueue = [];
let debug = false;

export function setOllamaLockDebug(value) {
  debug = value;
}

function scheduleNext() {
  if (running) return;
  const next = highQueue.shift() ?? normalQueue.shift();
  if (!next) return;
  running = true;
  if (debug) console.log('[ollama-lock] running, priority=', next.priority);
  next
    .fn()
    .then(next.resolve, next.reject)
    .finally(() => {
      if (debug) console.log('[ollama-lock] done, priority=', next.priority);
      running = false;
      scheduleNext();
    });
}

/**
 * Runs `fn` (an async function making one Ollama call) once it's this
 * call's turn. `priority: 'high'` (chat sends, and the memory-embedding
 * lookup that blocks a chat reply) jumps ahead of any 'normal'-priority
 * work (screen-tips, background memory extraction) still waiting -- but
 * never interrupts whatever's already running.
 */
export function withOllamaLock(fn, { priority = 'normal' } = {}) {
  if (debug) console.log('[ollama-lock] enqueued, priority=', priority);
  return new Promise((resolve, reject) => {
    (priority === 'high' ? highQueue : normalQueue).push({ fn, resolve, reject, priority });
    scheduleNext();
  });
}
