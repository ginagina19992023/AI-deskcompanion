#!/usr/bin/env node
// Writes {status, detail, taskTitle, ts, sessionId} to ~/.claude/pet-status.json.
//
// Called from settings.json hooks with the status name as argv[2]. Reads
// the hook's stdin JSON payload (when present) to fill in `detail` with
// what Claude is actually doing (the command, file, query, ...), not just
// the bare tool name. Never throws past its own boundary and never blocks
// the real Claude Code operation on file I/O -- this is a side channel for
// a desktop pet, not something that should ever affect a tool call.
//
// taskTitle: UserPromptSubmit's payload carries the user's actual prompt
// text (`payload.prompt`) -- this is the only hook event that ever sees
// it. Every *other* event (PreToolUse, etc.) only knows about the current
// tool call, not what overall task it's in service of. So taskTitle is
// captured once per UserPromptSubmit and then carried forward by reading
// the previous write back out on every subsequent call (each hook
// invocation is a fresh process with no memory of its own), until the next
// UserPromptSubmit *meaningfully* replaces it (see isFollowUp below) or an
// idle status clears it.
//
// Two real problems observed live, both fixed here:
// 1. Attaching a file/image in the Claude Desktop app encodes it in the
//    prompt text as literal `@"C:\...\path"` tokens -- left in, these
//    dominate the 40-char budget and the title becomes an unreadable file
//    path instead of the actual ask. Stripped out before truncating.
// 2. A short follow-up message ("继续", "对", "是的", ...) would otherwise
//    overwrite a good title from earlier in the conversation with
//    something meaningless. Short cleaned prompts are treated as
//    continuations of the current task, not the start of a new one, and
//    don't replace an existing title.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const status = process.argv[2] || 'idle';
const outPath = path.join(os.homedir(), '.claude', 'pet-status.json');
// Per-session status, for the desktop pet's "which Claude tasks are
// currently working" list -- the single pet-status.json above only ever
// reflects whichever session wrote most recently, so running more than one
// `claude` session at once makes them silently clobber each other there.
// Keyed by session_id so each session gets its own file; ppid (this hook
// process's own parent) is what tools/activate-by-pid.ps1 walks up from to
// find the actual terminal/IDE window this session is running in -- a hook
// has no direct way to know its own window handle, but every ancestor a
// few levels up eventually is one.
const sessionsDir = path.join(os.homedir(), '.claude', 'pet-sessions');
const usageDir = path.join(os.homedir(), '.claude', 'pet-usage');
// A day-spanning log of finished tasks, for the pet's report feature --
// pet-sessions/ only ever holds *currently active* sessions (idle deletes
// the file), so without this there's no way to answer "what did I work on
// today" once a session ends. Capped so it can't grow unbounded across
// months of use.
const dailyActivityPath = path.join(os.homedir(), '.claude', 'pet-daily-activity.json');
const DAILY_ACTIVITY_MAX = 500;

function logFinishedTask(taskTitle) {
  if (!taskTitle) return;
  try {
    let entries = [];
    try {
      entries = JSON.parse(fs.readFileSync(dailyActivityPath, 'utf8'));
      if (!Array.isArray(entries)) entries = [];
    } catch {
      /* no log yet, or corrupt -- start fresh */
    }
    entries.push({ taskTitle, ts: Date.now(), agent: 'claude' });
    if (entries.length > DAILY_ACTIVITY_MAX) entries = entries.slice(-DAILY_ACTIVITY_MAX);
    fs.writeFileSync(dailyActivityPath, JSON.stringify(entries));
  } catch {
    /* best-effort logging, never worth failing the real hook over */
  }
}

function shorten(s, max) {
  if (!s) return s;
  const str = String(s);
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

// Strips file/image-attachment mentions (`@"C:\...\path"` or bare
// `@/some/path`) out of a raw prompt -- noise for a task title, not part
// of the actual ask.
function stripAttachmentMentions(prompt) {
  return prompt
    .replace(/@"[^"]*"/g, '')
    .replace(/@\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Task titles/command details end up shown in the pet's speech bubble and
// the dashboard's task list -- both far more casually visible (glance at
// the desktop, screen-shared, screenshotted) than a terminal scrollback.
// Scrub the common secret shapes before anything derived from a raw
// prompt/command ever reaches those surfaces.
const SECRET_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)
  /\bsk-[A-Za-z0-9]{20,}\b/g, // OpenAI-style secret keys
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\b(api[_-]?key|token|secret|password|bearer)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{8,}['"]?/gi,
];
function scrubSecrets(s) {
  if (!s) return s;
  let out = String(s);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[已隐藏]');
  return out;
}

// A short cleaned prompt (after stripping attachments) reads as a
// follow-up/continuation ("继续", "对", "ok", a bare "yes") rather than a
// new task description -- not worth overwriting a real title with.
function isFollowUp(cleaned) {
  return cleaned.length > 0 && cleaned.length < 8;
}

// What Claude is concretely doing, phrased as a natural short sentence
// rather than raw tool syntax ("运行命令: npm test", not "Bash: npm test").
function whatFor(payload) {
  const tool = payload && payload.tool_name;
  const input = (payload && payload.tool_input) || {};
  if (!tool) return '';

  switch (tool) {
    case 'Bash':
      return input.command ? `运行命令：${shorten(scrubSecrets(input.command), 44)}` : '运行命令';
    case 'Read':
      return input.file_path ? `查看 ${path.basename(input.file_path)}` : '查看文件';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return input.file_path ? `编辑 ${path.basename(input.file_path)}` : '编辑文件';
    case 'Grep':
      return input.pattern ? `搜索代码："${shorten(input.pattern, 26)}"` : '搜索代码';
    case 'Glob':
      return input.pattern ? `查找文件：${shorten(input.pattern, 26)}` : '查找文件';
    case 'WebFetch':
      return input.url ? `打开网页：${shorten(input.url, 34)}` : '打开网页';
    case 'WebSearch':
      return input.query ? `搜索："${shorten(input.query, 26)}"` : '联网搜索';
    case 'Task':
    case 'Agent':
      return '派发子任务';
    case 'TodoWrite':
      return '更新任务清单';
    default:
      return `使用 ${tool}`;
  }
}

// TaskCompleted's exact payload shape isn't documented anywhere I could
// confirm, so this tries a few plausible field names rather than assuming
// one -- falls back to a plain "done" phrase if none are present.
function celebrateDetail(payload) {
  const label =
    payload?.title ?? payload?.task_name ?? payload?.name ?? payload?.summary ?? payload?.description ?? null;
  return label ? `完成：${shorten(String(label), 40)}` : '任务完成！';
}

function detailFor(status, payload) {
  const what = whatFor(payload);
  switch (status) {
    case 'working':
      return what || '处理中';
    case 'review':
      return what || '审阅中';
    case 'waiting':
      return what ? `等你批准：${what}` : '等待你的输入';
    case 'error':
      return what ? `出错了：${what}` : '出错了';
    case 'celebrate':
      return celebrateDetail(payload);
    case 'idle':
    default:
      return '空闲';
  }
}

// The transcript contains current prompt tokens but not the window limit.
// Reuse the same session's last official statusLine window size when it is
// available (Claude Desktop's embedded stream-json agent does not refresh
// statusLine continuously). Fall back conservatively for a brand-new
// session, promoting to 1M once its prompt has already exceeded 200K.
const CONTEXT_WINDOW_DEFAULT = 200000;

function contextWindowForSession(sessionId, tokens) {
  if (sessionId) {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(usageDir, `${sessionId}.json`), 'utf8'));
      const size = Number(saved.contextWindowSize);
      if (size > 0) return size;
    } catch {
      /* no official statusLine sample for this session yet */
    }
  }
  return tokens > CONTEXT_WINDOW_DEFAULT ? 1000000 : CONTEXT_WINDOW_DEFAULT;
}

// Each assistant turn's usage block carries the *current* prompt's token
// breakdown -- cache_read + cache_creation + input together are the full
// context sent for that turn, which is exactly "how much of the window is
// occupied right now" (output_tokens are what came back, not context
// pressure). Reads only the tail of the transcript (most recent ~200KB) so
// this stays cheap even on a long-running session's multi-MB file; a hook
// that's slow on every single tool call is a much worse problem than an
// occasional missed reading from a mid-file byte-offset that fails to parse.
function readContextUsage(transcriptPath, sessionId) {
  if (!transcriptPath) return null;
  try {
    const stat = fs.statSync(transcriptPath);
    const tailBytes = Math.min(stat.size, 200000);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(tailBytes);
    fs.readSync(fd, buf, 0, tailBytes, stat.size - tailBytes);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let obj;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        continue; // likely a line truncated by the byte-offset tail read
      }
      const usage = obj && obj.message && obj.message.usage;
      if (!usage) continue;
      const tokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      if (!tokens) continue;
      const contextWindowMax = contextWindowForSession(sessionId, tokens);
      return {
        contextTokens: tokens,
        contextWindowMax,
        contextPercent: Math.min(1, tokens / contextWindowMax),
      };
    }
  } catch {
    /* transcript unreadable or missing this call -- no reading available */
  }
  return null;
}

function write(payload) {
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const sessionId = (payload && payload.session_id) || null;
    const sessionPath = sessionId ? path.join(sessionsDir, `${sessionId}.json`) : null;

    // Carry-forward must read THIS session's own last-known title, not the
    // shared pet-status.json -- that file reflects whichever session wrote
    // most recently, so with two+ sessions running it was clobbering titles
    // across sessions (and nulling every other session's title the instant
    // any one session went idle). Fall back to the shared file only for a
    // session's very first-ever hook call, before it has its own file yet.
    let previousTaskTitle = null;
    try {
      const prevData = JSON.parse(fs.readFileSync(sessionPath ?? outPath, 'utf8'));
      previousTaskTitle = prevData.taskTitle ?? null;
    } catch {
      /* first-ever write, or the file is missing/corrupt -- no previous title to carry forward */
    }

    let taskTitle;
    if (typeof payload?.prompt === 'string') {
      const cleaned = scrubSecrets(stripAttachmentMentions(payload.prompt));
      // A short follow-up doesn't replace a real title already in place --
      // but if there's no previous title yet (start of a session), use it
      // anyway rather than showing nothing.
      taskTitle = isFollowUp(cleaned) && previousTaskTitle ? previousTaskTitle : shorten(cleaned, 40);
    } else if (status === 'idle') {
      // Session ended or Claude stopped responding -- no task is active.
      taskTitle = null;
    } else {
      taskTitle = previousTaskTitle;
    }

    const contextUsage = status === 'idle' ? null : readContextUsage(payload?.transcript_path, sessionId);

    fs.writeFileSync(
      outPath,
      JSON.stringify({
        status,
        detail: shorten(detailFor(status, payload), 80),
        taskTitle,
        ts: Date.now(),
        sessionId,
        ...contextUsage,
      }),
    );

    if (sessionId) {
      if (status === 'idle') {
        // Not "working" anymore -- remove it from the active list rather
        // than writing a stale idle entry that would need its own
        // freshness check on the read side. If there was a real task in
        // progress, record it finishing before the file disappears --
        // this is the only point where that information still exists.
        logFinishedTask(previousTaskTitle);
        try {
          fs.unlinkSync(sessionPath);
        } catch {
          /* already gone, or never existed -- fine either way */
        }
      } else {
        fs.mkdirSync(sessionsDir, { recursive: true });
        // Reuse the ancestor chain a previous hook call in this session
        // already resolved, rather than re-spawning the resolver on every
        // single tool call.
        let ancestorChain = null;
        try {
          ancestorChain = JSON.parse(fs.readFileSync(sessionPath, 'utf8')).ancestorChain ?? null;
        } catch {
          /* first write for this session -- nothing to reuse yet */
        }
        fs.writeFileSync(
          sessionPath,
          JSON.stringify({
            sessionId,
            agent: 'claude',
            status,
            detail: shorten(detailFor(status, payload), 80),
            taskTitle,
            ts: Date.now(),
            ppid: process.ppid,
            ancestorChain,
            ...contextUsage,
          }),
        );
        if (!ancestorChain) resolveAncestorChainInBackground(process.ppid, sessionPath);
      }
    }
  } catch {
    /* never block the real hook on this */
  }
}

// Fire-and-forget: spawns a detached PowerShell process that walks the
// process ancestry and writes the result back into sessionPath once done --
// completely decoupled from this hook's own lifetime (it doesn't wait,
// doesn't block `finish()`/process.exit below). See
// tools/resolve-ancestor-chain.ps1 for what actually does the walking.
function resolveAncestorChainInBackground(startPid, sessionPath) {
  try {
    const scriptPath = path.join(__dirname, 'resolve-ancestor-chain.ps1');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-StartPid', String(startPid), '-SessionPath', sessionPath],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
  } catch {
    /* best effort -- the session just won't have a jump target this time */
  }
}

let input = '';
let done = false;
function finish() {
  if (done) return;
  done = true;
  let payload = {};
  try {
    payload = JSON.parse(input || '{}');
  } catch {
    payload = {};
  }
  write(payload);
  process.exit(0);
}

process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', finish);
process.stdin.on('error', finish);
// Some hook events fire without ever closing stdin in every shell; don't
// hang the hook waiting for a close that may not come.
setTimeout(finish, 300).unref();

