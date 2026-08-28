import { app, BrowserWindow, screen, ipcMain, Tray, Menu, dialog, nativeImage, globalShortcut, shell } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { ATLAS, BASE_ROWS } from './atlas.js';
import { companionAnchor } from './companion.js';
import { createCompanionWatcher } from './companion-watcher.js';
import { createScreenTipWatcher, captureAndDescribe, captureCroppedScreenshot } from './screen-tip.js';
import { createCameraSenseWatcher } from './camera-sense.js';
import { streamChatReply } from './chat.js';
import { addTodo, completeTodo, removeTodo, editTodo, activeTodos, completedInRange, sortTodosForDisplay, startOfDay, startOfWeek } from './todos.js';
import { connectOutlookAccount, disconnectOutlookAccount, getOutlookAccountStatus, syncOnce as syncOutlookOnce, deleteOutlookTask } from './outlook-sync.js';
import { startPomodoro, pomodoroRemainingMs } from './pomodoro.js';
import { pickMusicComment, classifyMusicPulse } from './music-comment.js';
import { normalizeAiActivity, pickAllContextActivities, pickPrimaryActivity } from './ai-activity.js';
import { createCodexActivityReader } from './codex-activity.js';
import { buildSemanticMemoryGraph, cosineSimilarity } from './memory-clusters.js';
import { filterStaleRateLimits } from './claude-status.js';
import {
  resizedBoundsKeepingAnchor,
  screenEdgeDropPose,
  windowEdgeDropPose,
  pickBubbleSide,
  growBoundsForBubble,
  petRectFromGrownBounds,
  growBoundsForRing,
} from './geometry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const configPath = join(root, 'config.json');
const defaultConfigPath = join(root, 'config.default.json');
const cfg = JSON.parse(readFileSync(existsSync(configPath) ? configPath : defaultConfigPath, 'utf8'));
const activityCfg = { enabled: true, ...(cfg.claudeStatus ?? {}), ...(cfg.aiActivity ?? {}) };

// Published builds keep portable, repository-relative atlas paths in the
// default config. Resolve them once at startup; imported pets can still use
// absolute paths selected by the user.
for (const pet of cfg.pets ?? []) {
  if (pet.spritesheetPath && !isAbsolute(pet.spritesheetPath)) {
    pet.spritesheetPath = join(root, pet.spritesheetPath);
  }
}

// Transparent frameless windows crash the renderer on a number of Windows
// GPU/driver combinations. Software compositing costs little for a 192x208
// sprite and makes startup reliable.
if (cfg.disableHardwareAcceleration !== false) {
  app.disableHardwareAcceleration();
}

// Mutable: the right-click "resize" menu changes these at runtime.
let PET_W = Math.round(ATLAS.cellW * cfg.scale);
let PET_H = Math.round(ATLAS.cellH * cfg.scale);
// 60Hz: at 30 the head visibly lagged a fast cursor.
const CURSOR_HZ = 60;

const SCREEN_TIP_INTERVAL_CHOICES = [
  { label: '30 秒', ms: 30000 },
  { label: '1 分钟', ms: 60000 },
  { label: '90 秒', ms: 90000 },
  { label: '3 分钟', ms: 180000 },
  { label: '5 分钟', ms: 300000 },
];

let win = null;
let tray = null;
let wanderTarget = null;
let wandering = false;
let dragging = false;
let dragOffset = { x: 0, y: 0 };
let paused = false;

// Wandering is autonomous and cycles every ~10-20s -- a panel-open request
// landing mid-wander used to just silently no-op (blocked by `wandering`
// in the guard), with zero feedback that anything was even attempted.
// Cancelling instead of blocking means clicking "跟他聊天"/"待办 & 报告"
// always works regardless of what the pet happened to be doing.
// `pet:wander-arrived` tells the renderer's brain to leave STATES.WANDER
// cleanly -- without it the sprite would freeze on a mid-step walk frame,
// asked to stop with no "you've arrived" event to actually transition on.
function cancelWander() {
  if (!wandering) return;
  wandering = false;
  wanderTarget = null;
  if (alive()) win.webContents.send('pet:wander-arrived', {});
}
let wanderVisiting = false;
let wanderPerching = false;
let wanderLieDown = false;
// Which side (if any) the window is currently grown into to make room for
// a bubble -- see the pet:bubble-space handler below.
let bubbleSide = null;
let bubbleExtra = 0;

// Every panel-open function (toolbar ring, chat, todo) needs the
// sprite's *true* rect to anchor its own growth math against -- but a
// status/pomodoro bubble can be growing the window independently at the
// exact moment one of them opens (bubbleSide/bubbleExtra track that
// separately from chatPanelOpen/etc). Naively treating
// win.getBounds() as the sprite's rect is wrong whenever a bubble is
// active: with a 'top'-side bubble the sprite actually sits at the
// *bottom* of an already-tall window, not flush with its top-left corner.
// Confirmed live as the cause of the toolbar ring opening centred on the
// wrong point while the sprite sat elsewhere entirely.
function truePetRect(bounds) {
  if (bubbleSide !== null) return petRectFromGrownBounds(bounds, bubbleSide, bubbleExtra);
  return { x: bounds.x, y: bounds.y, width: PET_W, height: PET_H };
}

// A panel taking over the window makes any active bubble-growth tracking
// stale the same way applyScale() already has to guard against -- without
// this, closing the panel back to plain PET_W x PET_H leaves bubbleSide
// pointing at bounds that no longer exist, corrupting the next bubble
// resize (petRectFromGrownBounds would recover a wrong, too-short rect).
function clearBubbleGrowthForPanel() {
  if (bubbleSide === null) return;
  bubbleSide = null;
  bubbleExtra = 0;
  if (alive()) win.webContents.send('pet:bubble-layout', { side: null, extra: 0 });
}
let companion = null;
let lastCompanionLog = 0;
let screenTipWatcher = null;
let cameraSenseWatcher = null;
let cameraFrameRequestId = 0;
const pendingCameraFrameRequests = new Map(); // requestId -> {resolve, reject}
let screenTipsPaused = false;
let workSupervisionWatcher = null;
let consecutiveSlackCount = 0;
let baseSize = null;
// Renderer-facing display/behaviour toggles, all runtime-only (reset to
// enabled on restart, same as `paused`/`screenTipsPaused` above -- these
// are quick session toggles from the tray/right-click menu, not settings).
let statusBubbleEnabled = true;
let tipBubbleEnabled = true;
let randomActionsEnabled = true;

// Whether the renderer's brain is allowed to pick STATES.WANDER at all --
// NOT purely cosmetic. main.js silently no-ops a wander-start request while
// paused or cfg.wander is false, so if the brain picked WANDER anyway it
// would be stuck showing the walk frame forever, having asked to move and
// been ignored with no "arrived" event to ever leave that state.
function wanderEnabled() {
  return !!cfg.wander && !paused;
}

// Todos, pomodoro sessions, and chat history all persist across restarts
// (unlike the runtime-only toggles above) -- kept in their own small JSON
// files under data/, not config.json, since they're user data that changes
// constantly, not settings you'd hand-edit.
const dataDir = join(root, 'data');
const todosPath = join(dataDir, 'todos.json');
const pomodoroSessionsPath = join(dataDir, 'pomodoro-sessions.json');
const chatConvsPath = join(dataDir, 'chat-conversations.json');
const petMemoryPath = join(dataDir, 'pet-memory.json');

function loadJsonArray(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveJsonArray(path, arr) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, JSON.stringify(arr, null, 2), 'utf8');
}

function loadJsonObject(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveJsonObject(path, obj) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2), 'utf8');
}

// Backfill updatedAt/externalId/externalProvider on todos saved before the
// Outlook-sync fields existed -- updatedAt defaults to createdAt (best
// available guess at "last touched"), external* default to unlinked.
let todos = loadJsonArray(todosPath).map((t) => ({
  updatedAt: t.createdAt,
  externalId: null,
  externalProvider: null,
  ...t,
}));
let pomodoroSessions = loadJsonArray(pomodoroSessionsPath);

function sendTodos() {
  if (alive()) win.webContents.send('pet:todos', { active: sortTodosForDisplay(activeTodos(todos)) });
}

// A function, not a frozen const -- durationMin is now settable from the
// dashboard (dashboard:set-setting 'pomodoroDurationMin'), and a const
// computed once at boot would never see that change without a restart.
function pomodoroDefaultMs() {
  return (cfg.pomodoro?.durationMin ?? 25) * 60 * 1000;
}
let pomodoroState = null;
let pomodoroTimer = null;

function sendPomodoroState() {
  if (alive()) win.webContents.send('pet:pomodoro-state', { active: !!pomodoroState, endsAt: pomodoroState?.endsAt ?? null });
}

function stopPomodoro(completed) {
  if (!pomodoroState) return;
  const finishedState = pomodoroState; // snapshot before clearing -- startedAt/durationMs only exist on this
  pomodoroState = null;
  if (pomodoroTimer) {
    clearTimeout(pomodoroTimer);
    pomodoroTimer = null;
  }
  sendPomodoroState();
  if (completed) {
    pomodoroSessions.push({ completedAt: Date.now(), startedAt: finishedState.startedAt, durationMs: finishedState.durationMs });
    saveJsonArray(pomodoroSessionsPath, pomodoroSessions);
    if (alive()) {
      win.webContents.send('pet:play-spin');
      win.webContents.send('pet:pomodoro-done');
    }
  }
}

function startPomodoroTimer(durationMs) {
  if (pomodoroState || !win || win.isDestroyed()) return;
  pomodoroState = startPomodoro(durationMs);
  sendPomodoroState();
  pomodoroTimer = setTimeout(() => stopPomodoro(true), durationMs);
}

// Log of Claude Code tasks that finished today/this week, written by
// ~/.claude/hooks/pet-status.cjs the instant a session goes idle (the only
// point that information still exists -- pet-sessions/ only ever holds
// currently-active sessions). Read-only here.
const claudeDailyActivityPath = join(homedir(), '.claude', 'pet-daily-activity.json');

function legacyStatsReport(label, doneTodos, pomodoroCount) {
  const lines = [`${label}完成待办 ${doneTodos.length} 项，番茄钟 ${pomodoroCount} 个。`];
  if (doneTodos.length) {
    const names = doneTodos.slice(0, 6).map((t) => t.text);
    lines.push(`完成的事：${names.join('、')}${doneTodos.length > 6 ? ' 等' : ''}。`);
  } else {
    lines.push('这段时间还没有勾掉任何待办。');
  }
  return lines.join(' ');
}

// Pulls together everything the pet knows about a period -- todos,
// pomodoro count, Claude Code tasks finished (from the daily-activity log)
// and still in progress, and sampled screen-tip/work-supervision records --
// and asks the chat model to write one connected summary instead of just
// reporting counts. Falls back to the old deterministic stats-only text if
// chat isn't enabled or the model call fails, so the report never comes
// back completely empty.
// Reports used to be pure IPC round-trips -- generated, shown once, then
// gone the moment the panel closed. There was no way to look at
// yesterday's report again. Kept as a flat capped array (reports are
// generated by a button click, not on a timer, so there's no volume
// pressure that would justify per-day files the way screen-tips has).
const reportsPath = join(dataDir, 'reports.json');
const REPORTS_MAX = 200;
function saveReport(kind, text) {
  const arr = loadJsonArray(reportsPath);
  arr.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind, ts: Date.now(), text });
  if (arr.length > REPORTS_MAX) arr.splice(0, arr.length - REPORTS_MAX);
  saveJsonArray(reportsPath, arr);
}

async function buildReport(kind) {
  const now = new Date();
  const start = kind === 'week' ? startOfWeek(now) : startOfDay(now);
  const end = Date.now();
  const label = kind === 'week' ? '本周' : '今日';

  const doneTodos = completedInRange(todos, start, end);
  const pomodoroCount = pomodoroSessions.filter((s) => s.completedAt >= start && s.completedAt < end).length;
  const activityEntries = loadJsonArray(claudeDailyActivityPath).filter((e) => e.ts >= start && e.ts < end);
  const activeNow = readActiveSessions()
    .map((s) => s.taskTitle)
    .filter(Boolean);

  const dayKeys = [];
  if (kind === 'week') {
    for (let t = start; t < end; t += 86400000) dayKeys.push(dateKey(t));
  } else {
    dayKeys.push(dateKey(start));
  }
  let records = [];
  for (const day of dayKeys) records = records.concat(loadJsonArray(join(screenTipsDataDir, `${day}.json`)));
  records = records.filter((e) => e.ts >= start && e.ts < end);
  const sampledRecords = sampleEntriesAcrossDay(records, MAX_SUMMARY_ENTRIES);

  const chatCfg = cfg.chat ?? {};
  if (!chatCfg.enabled) {
    const text = legacyStatsReport(label, doneTodos, pomodoroCount);
    saveReport(kind, text);
    return text;
  }

  const sections = [`待办完成 ${doneTodos.length} 项${doneTodos.length ? '：' + doneTodos.slice(0, 10).map((t) => t.text).join('、') : ''}`];
  sections.push(`番茄钟 ${pomodoroCount} 个`);
  if (activityEntries.length) {
    sections.push(`Claude 完成的任务（共 ${activityEntries.length} 个）：\n${activityEntries.slice(-30).map((e) => `- ${e.taskTitle}`).join('\n')}`);
  }
  if (activeNow.length) sections.push(`目前还在进行：${activeNow.join('、')}`);
  if (sampledRecords.length) {
    sections.push(`屏幕记录片段：\n${sampledRecords.map((e) => `- ${e.text}`).join('\n')}`);
  }

  const prompt =
    `以下是我${label}的活动记录：\n\n${sections.join('\n\n')}\n\n` +
    `请用中文写一段自然的总结（4-6 句话），综合待办、番茄钟、AI 任务和屏幕记录，讲清楚我${label}主要做了什么、精力花在哪、有什么进展——不要逐条罗列，写成连贯的话；如果某一类完全没有内容就不用提。`;
  try {
    const full = await streamChatReply({ ...chatCfg, timeoutMs: Math.max(chatCfg.timeoutMs ?? 90000, 240000) }, [{ role: 'user', content: prompt }], () => {});
    saveReport(kind, full);
    return full;
  } catch (err) {
    if (cfg.debug) console.error('[report] AI synthesis failed:', err.message);
    // Error/degraded output isn't saved -- same policy as generateDailySummary,
    // a transient model failure shouldn't pollute the saved report history.
    return `${legacyStatsReport(label, doneTodos, pomodoroCount)}\n\n（AI 总结生成失败：${err.message}）`;
  }
}

// Screen-tip history -- every "clicky" aside persisted as screenshot + AI
// text, browsable by date, with an on-demand AI-generated daily summary of
// what was actually on screen. Kept as one JSON index per day
// (data/screen-tips/<date>.json, an array of {ts, text, imageFile}) plus
// the actual PNGs alongside it in a same-named subfolder -- an index file
// per day keeps each read/write small regardless of how long this has been
// running, rather than one ever-growing file.
const screenTipsDataDir = join(dataDir, 'screen-tips');

function dateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function saveScreenTip(tip) {
  try {
    const day = dateKey(tip.ts);
    const dayDir = join(screenTipsDataDir, day);
    mkdirSync(dayDir, { recursive: true });
    const imageFile = `${tip.ts}.png`;
    if (tip.imageBase64) {
      writeFileSync(join(dayDir, imageFile), Buffer.from(tip.imageBase64, 'base64'));
    }
    const indexPath = join(screenTipsDataDir, `${day}.json`);
    const entries = loadJsonArray(indexPath);
    entries.push({ ts: tip.ts, text: tip.text, imageFile: tip.imageBase64 ? imageFile : null, source: tip.source ?? 'screenTip' });
    saveJsonArray(indexPath, entries);
  } catch (err) {
    if (cfg.debug) console.error('[screen-tip-history] save failed:', err.message);
  }
}

function loadScreenTipsForDate(day) {
  const indexPath = join(screenTipsDataDir, `${day}.json`);
  const entries = loadJsonArray(indexPath);
  return entries.map((e) => ({
    ts: e.ts,
    text: e.text,
    source: e.source ?? 'screenTip',
    imageUrl: e.imageFile ? pathToFileURL(join(screenTipsDataDir, day, e.imageFile)).href : null,
  }));
}

// Generated summaries are kept as their own per-day history (separate file
// from the raw tip index) so "生成这天的总结" never throws away a previous
// result -- every click (and every auto-run, see startDailySummaryTimer)
// appends instead of overwriting, and the history tab can show all of them.
function summariesIndexPath(day) {
  return join(screenTipsDataDir, `${day}-summaries.json`);
}
function loadScreenTipSummaries(day) {
  return loadJsonArray(summariesIndexPath(day));
}
function appendScreenTipSummary(day, text) {
  const entries = loadScreenTipSummaries(day);
  entries.push({ ts: Date.now(), text });
  saveJsonArray(summariesIndexPath(day), entries);
}

// A day with screenTips + workSupervision both firing every few minutes
// racks up 100+ entries fast (measured: 158 by mid-day) -- dumping every one
// verbatim into the prompt produced a ~30k-character prompt that blew right
// past chat.timeoutMs and just failed with a timeout every single time,
// which is why summaries had never once actually been generated. Sampling
// down to a fixed cap keeps the prompt (and therefore the model's context
// usage and response time) roughly constant regardless of how long the app
// has been running, while still spanning the whole day rather than just
// the most recent entries.
const MAX_SUMMARY_ENTRIES = 40;
function sampleEntriesAcrossDay(entries, max) {
  if (entries.length <= max) return entries;
  const step = entries.length / max;
  const sampled = [];
  for (let i = 0; i < max; i++) sampled.push(entries[Math.floor(i * step)]);
  return sampled;
}

// Shared by the manual "生成这天的总结" button and the auto-summary timer.
// Returns the summary text; only persists it (appendScreenTipSummary) when
// there was actually something to summarize and a chat model produced real
// output -- error/placeholder text is returned for display but not saved,
// so a transient failure doesn't pollute the saved history.
async function generateDailySummary(day) {
  const entries = loadJsonArray(join(screenTipsDataDir, `${day}.json`));
  if (!entries.length) return { text: '这天没有屏幕提示记录。', saved: false };
  const chatCfg = cfg.chat ?? {};
  if (!chatCfg.enabled) return { text: '需要先在设置里开启聊天模型才能生成总结。', saved: false };
  const sampled = sampleEntriesAcrossDay(entries, MAX_SUMMARY_ENTRIES);
  const bulletized = sampled
    .map((e) => `- ${new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} ${e.text}`)
    .join('\n');
  const prompt =
    `以下是我${day === dateKey(Date.now()) ? '今天' : `在 ${day} 这天`}屏幕上被随手记录下的一些片段（按时间抽样，每条是当时屏幕内容的简短描述或想法，共记录了 ${entries.length} 条，这里抽样展示 ${sampled.length} 条）：\n\n${bulletized}\n\n` +
    '请用中文写 2-4 句话，总结我这段时间大概在做什么/关注什么，像是回顾今天的注意力都花在哪了，不要逐条复述。';
  // Deliberately longer than chat's normal interactive timeout -- this is a
  // button-triggered, occasional background call, not something blocking a
  // chat bubble the user is staring at, so it's fine to give a 12B local
  // model real room to finish even on a slow day.
  const full = await streamChatReply({ ...chatCfg, timeoutMs: Math.max(chatCfg.timeoutMs ?? 90000, 240000) }, [{ role: 'user', content: prompt }], () => {});
  appendScreenTipSummary(day, full);
  return { text: full, saved: true };
}

// Auto-summary: re-runs generateDailySummary for *today only* every
// intervalMs, so the day's history tab fills in with periodic AI summaries
// without needing the button clicked. Skips silently when there's nothing
// new to summarize (empty day) -- same guard generateDailySummary already
// has, checked here too just to avoid the pointless model call.
let dailySummaryTimer = null;
function startDailySummaryTimer() {
  if (dailySummaryTimer) return;
  const intervalMs = cfg.dailySummary?.intervalMs ?? 21600000;
  dailySummaryTimer = setInterval(() => {
    const today = dateKey(Date.now());
    const entries = loadJsonArray(join(screenTipsDataDir, `${today}.json`));
    if (entries.length) {
      generateDailySummary(today)
        .then(({ saved }) => {
          if (saved && cfg.debug) console.log('[daily-summary] auto-generated for', today);
        })
        .catch((err) => {
          if (cfg.debug) console.error('[daily-summary] auto failed:', err.message);
        });
    }
    extractActivityMemoryFacts()
      .catch((err) => {
        if (cfg.debug) console.error('[memory-activity] auto failed:', err.message);
      })
      .then(() => {
        const dropped = dedupeMemoryFacts();
        if (dropped && cfg.debug) console.log('[memory-dedupe] dropped', dropped, 'near-duplicate facts');
      })
      .then(() => reflectOnMemoryClusters())
      .then((added) => {
        if (added && cfg.debug) console.log('[memory-reflection] synthesized', added, 'higher-level insight(s)');
      })
      .catch((err) => {
        if (cfg.debug) console.error('[memory-reflection] auto failed:', err.message);
      });
  }, intervalMs);
}
function stopDailySummaryTimer() {
  if (dailySummaryTimer) {
    clearInterval(dailySummaryTimer);
    dailySummaryTimer = null;
  }
}

// Work supervision (during an active pomodoro only): the vision model's
// reply is asked to lead with one of three fixed words so this can be
// parsed reliably, with a spoken-out-loud comment on the line after --
// same shared history via saveScreenTip as the ambient screen-tip feature,
// just a different question being asked of the same screenshot mechanism.
// llava (the default local vision model) was already confirmed unreliable
// at multi-part instructions in this project (see the earlier screenTips
// prompt work) -- measured live here too: asked for verdict + a
// personality comment, it sometimes only returns the verdict word. Rather
// than show a bare "摸鱼" as the bubble text when that happens, fall back
// to a real in-character line.
const SLACK_FALLBACK_COMMENTS = ['哦呀，被我看到了呢。', '少爷可不会喜欢看到这个。', '这就是您所谓的「专注」？'];
function handleSupervisionResult(rawText) {
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const verdict = lines[0] ?? '';
  const modelComment = lines.slice(1).join(' ').trim();
  if (/摸鱼|分心|slack|distract/i.test(verdict)) {
    consecutiveSlackCount++;
    const comment = modelComment || SLACK_FALLBACK_COMMENTS[consecutiveSlackCount % SLACK_FALLBACK_COMMENTS.length];
    if (consecutiveSlackCount >= 3) {
      if (alive()) {
        win.webContents.send('pet:play-spin');
        win.webContents.send('pet:chat-reply', { text: `连续摸鱼 ${consecutiveSlackCount} 次了。${comment}` });
      }
      consecutiveSlackCount = 0;
    } else if (alive()) {
      win.webContents.send('pet:chat-reply', { text: comment });
    }
  } else if (/专注|认真|focus/i.test(verdict)) {
    consecutiveSlackCount = 0;
  }
  // "不确定"/anything else: no reaction, don't reset or increment the streak
}

function startScreenTips() {
  if (screenTipWatcher) return;
  screenTipWatcher = createScreenTipWatcher({
    cfg: cfg.screenTips,
    isPaused: () => screenTipsPaused,
    onTip: (tip) => {
      if (cfg.debug) console.log('[screen-tip] got tip:', tip.text);
      saveScreenTip(tip);
      // Only text/ts goes to the renderer for the live bubble -- the
      // image is for the history view (a separate on-demand request), no
      // reason to push a base64 PNG over IPC on every single tip.
      if (alive()) win.webContents.send('pet:screen-tip', { text: tip.text, ts: tip.ts });
    },
    // Ollama being unreachable is the expected state until it's installed
    // and a model is pulled -- log it under debug only, never surface it.
    onError: (err) => {
      if (cfg.debug) console.error('[screen-tip]', err.message);
    },
  });
}

function stopScreenTips() {
  screenTipWatcher?.stop();
  screenTipWatcher = null;
}

function requestCameraFrame() {
  return new Promise((resolve, reject) => {
    if (!alive()) return resolve(null);
    const requestId = ++cameraFrameRequestId;
    const timer = setTimeout(() => {
      pendingCameraFrameRequests.delete(requestId);
      resolve(null); // renderer never answered (e.g. permission denied) -- don't hang the watcher
    }, 8000);
    pendingCameraFrameRequests.set(requestId, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    win.webContents.send('pet:camera-frame-request', { requestId });
  });
}

function startCameraSense() {
  if (cameraSenseWatcher) return;
  cameraSenseWatcher = createCameraSenseWatcher({
    cfg: cfg.cameraSense,
    getFrame: requestCameraFrame,
    isPaused: () => false,
    onTip: (tip) => {
      if (cfg.debug) console.log('[camera-sense] got tip:', tip.text);
      saveScreenTip(tip); // tip.source is already 'camera', see camera-sense.js
      if (alive()) win.webContents.send('pet:screen-tip', { text: tip.text, ts: tip.ts });
    },
    onError: (err) => {
      if (cfg.debug) console.error('[camera-sense]', err.message);
    },
  });
}

function stopCameraSense() {
  cameraSenseWatcher?.stop();
  cameraSenseWatcher = null;
}

ipcMain.on('pet:camera-frame-response', (_e, { requestId, base64, error } = {}) => {
  const pending = pendingCameraFrameRequests.get(requestId);
  if (!pending) return;
  pendingCameraFrameRequests.delete(requestId);
  if (error) pending.reject(new Error(error));
  else pending.resolve(base64 ?? null);
});

function startWorkSupervision() {
  if (workSupervisionWatcher) return;
  workSupervisionWatcher = createScreenTipWatcher({
    cfg: cfg.workSupervision,
    // Only checks while a pomodoro is actually running -- there's
    // nothing to "supervise" otherwise, and it would just be an
    // ambient screenshot feature wearing a scarier name. Deliberately NOT
    // gated on screenTipsPaused -- that flag mutes the ambient screen-tip
    // bubbles, and muting those is exactly the thing someone does *while*
    // trying to focus, which used to silently kill supervision too (the
    // one feature that's supposed to be running at that exact moment).
    // Confirmed via data/screen-tips/*.json: zero workSupervision-sourced
    // entries ever existed despite two completed pomodoro sessions.
    isPaused: () => !pomodoroState,
    onTip: (tip) => {
      if (cfg.debug) console.log('[work-supervision] got:', tip.text);
      saveScreenTip({ ...tip, source: 'workSupervision' });
      handleSupervisionResult(tip.text);
    },
    onError: (err) => {
      if (cfg.debug) console.error('[work-supervision]', err.message);
    },
  });
}

function stopWorkSupervision() {
  workSupervisionWatcher?.stop();
  workSupervisionWatcher = null;
  consecutiveSlackCount = 0;
}

ipcMain.on('pet:screentip-history-request', (_e, day) => {
  const requested = typeof day === 'string' && day ? day : dateKey(Date.now());
  if (alive()) {
    win.webContents.send('pet:screentip-history-result', {
      day: requested,
      entries: loadScreenTipsForDate(requested),
      summaries: loadScreenTipSummaries(requested),
    });
  }
});

ipcMain.on('pet:screentip-summary-request', async (_e, day) => {
  const requested = typeof day === 'string' && day ? day : dateKey(Date.now());
  try {
    const { text } = await generateDailySummary(requested);
    if (alive()) {
      win.webContents.send('pet:screentip-summary-result', { day: requested, text, summaries: loadScreenTipSummaries(requested) });
    }
  } catch (err) {
    if (cfg.debug) console.error('[screentip-summary]', err.message);
    if (alive()) {
      win.webContents.send('pet:screentip-summary-result', {
        day: requested,
        text: `生成失败：${err.message}`,
        summaries: loadScreenTipSummaries(requested),
      });
    }
  }
});

ipcMain.on('pet:todo-add', (_e, text) => {
  todos = addTodo(todos, text);
  saveJsonArray(todosPath, todos);
  sendTodos();
});

ipcMain.on('pet:todo-complete', (_e, id) => {
  todos = completeTodo(todos, id);
  saveJsonArray(todosPath, todos);
  sendTodos();
  if (alive()) win.webContents.send('pet:play-spin');
});

ipcMain.on('pet:todo-remove', (_e, id) => {
  const removed = todos.find((t) => t.id === id);
  todos = removeTodo(todos, id);
  saveJsonArray(todosPath, todos);
  sendTodos();
  // Continuous sync means a local delete should propagate, not just get
  // silently re-created on the next pull. Fire-and-forget -- the local
  // delete already happened and shouldn't wait on (or fail because of) a
  // network call.
  if (removed?.externalProvider === 'outlook' && removed.externalId && cfg.outlookSync?.enabled && cfg.outlookSync?.clientId) {
    deleteOutlookTask({ clientId: cfg.outlookSync.clientId, tenantId: cfg.outlookSync.tenantId, dataDir, externalId: removed.externalId }).catch((err) => {
      if (cfg.debug) console.error('[outlook-sync] delete failed:', err.message);
    });
  }
});

ipcMain.on('pet:todo-edit', (_e, { id, text, tags, dueAt } = {}) => {
  const patch = {};
  if (typeof text === 'string' && text.trim()) patch.text = text.trim().slice(0, 200);
  if (Array.isArray(tags)) patch.tags = tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 10);
  if (dueAt === null || typeof dueAt === 'number') patch.dueAt = dueAt;
  todos = editTodo(todos, id, patch);
  saveJsonArray(todosPath, todos);
  sendTodos();
});

// --- Outlook sync --------------------------------------------------------
ipcMain.handle('dashboard:outlook-status', async () => {
  if (!cfg.outlookSync?.clientId) return { connected: false, enabled: !!cfg.outlookSync?.enabled };
  try {
    const status = await getOutlookAccountStatus({ clientId: cfg.outlookSync.clientId, tenantId: cfg.outlookSync.tenantId, dataDir });
    return { ...status, enabled: !!cfg.outlookSync?.enabled };
  } catch (err) {
    return { connected: false, enabled: !!cfg.outlookSync?.enabled, error: err.message };
  }
});

ipcMain.handle('dashboard:outlook-set-client-id', (_e, { clientId, tenantId } = {}) => {
  cfg.outlookSync = cfg.outlookSync ?? {};
  cfg.outlookSync.clientId = String(clientId ?? '').trim();
  cfg.outlookSync.tenantId = String(tenantId ?? '').trim() || 'common';
  persistConfig();
  return { ok: true };
});

ipcMain.handle('dashboard:outlook-connect', async () => {
  if (!cfg.outlookSync?.clientId) return { ok: false, error: '还没填 client ID' };
  try {
    const res = await connectOutlookAccount({ clientId: cfg.outlookSync.clientId, tenantId: cfg.outlookSync.tenantId, dataDir });
    cfg.outlookSync.enabled = true;
    persistConfig();
    startOutlookSyncTimer();
    return res;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('dashboard:outlook-disconnect', async () => {
  if (!cfg.outlookSync?.clientId) return { ok: true };
  try {
    await disconnectOutlookAccount({ clientId: cfg.outlookSync.clientId, tenantId: cfg.outlookSync.tenantId, dataDir });
  } catch (err) {
    if (cfg.debug) console.error('[outlook-sync] disconnect failed:', err.message);
  }
  cfg.outlookSync.enabled = false;
  persistConfig();
  stopOutlookSyncTimer();
  return { ok: true };
});

ipcMain.handle('dashboard:outlook-sync-now', async () => {
  if (!cfg.outlookSync?.enabled || !cfg.outlookSync?.clientId) return { ok: false, error: 'Outlook 同步未开启' };
  try {
    const { todos: next, summary } = await syncOutlookOnce({ clientId: cfg.outlookSync.clientId, tenantId: cfg.outlookSync.tenantId, dataDir, todos });
    todos = next;
    saveJsonArray(todosPath, todos);
    sendTodos();
    return { ok: true, summary };
  } catch (err) {
    if (cfg.debug) console.error('[outlook-sync] sync failed:', err.message);
    return { ok: false, error: err.message };
  }
});

let outlookSyncTimer = null;
function startOutlookSyncTimer() {
  if (outlookSyncTimer) return;
  const intervalMs = cfg.outlookSync?.intervalMs ?? 600000;
  outlookSyncTimer = setInterval(async () => {
    if (!cfg.outlookSync?.enabled || !cfg.outlookSync?.clientId) return;
    try {
      const { todos: next } = await syncOutlookOnce({ clientId: cfg.outlookSync.clientId, tenantId: cfg.outlookSync.tenantId, dataDir, todos });
      todos = next;
      saveJsonArray(todosPath, todos);
      sendTodos();
    } catch (err) {
      if (cfg.debug) console.error('[outlook-sync] auto sync failed:', err.message);
    }
  }, intervalMs);
}
function stopOutlookSyncTimer() {
  if (outlookSyncTimer) {
    clearInterval(outlookSyncTimer);
    outlookSyncTimer = null;
  }
}

// Optional endpoint for ~/.claude/hooks/pet-permission.cjs. Keep this feature
// disabled unless the upstream PermissionRequest hook once again guarantees
// a non-blocking fallback: current Claude Code versions may interpret an HTTP
// hook connection failure as a denial instead of showing the terminal prompt.
// When explicitly enabled, the endpoint remains loopback-only (127.0.0.1)
// and every in-flight request has a bounded server-side timeout.
const PERMISSION_SERVER_PORT = 47811;
const PERMISSION_TIMEOUT_MS = 55000;
let permissionServer = null;
const pendingPermissionRequests = new Map(); // requestId -> resolve(decision)

function safeActivityFilePart(value) {
  return String(value || 'default').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 96);
}

function persistExternalActivity(payload) {
  const activity = normalizeAiActivity(payload);
  if (!activity) return null;
  mkdirSync(aiSessionsDir, { recursive: true });
  const path = join(aiSessionsDir, `${safeActivityFilePart(activity.provider)}-${safeActivityFilePart(activity.sessionId)}.json`);
  if (activity.status === 'idle') {
    try {
      unlinkSync(path);
    } catch {
      /* no prior session file */
    }
  } else {
    writeFileSync(path, JSON.stringify(activity), 'utf8');
  }
  return activity;
}

function startPermissionCardServer() {
  if (permissionServer) return;
  permissionServer = createServer((req, res) => {
    if (req.method === 'POST' && (req.url === '/activity' || req.url === '/v1/activity')) {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 65536) req.destroy();
      });
      req.on('end', () => {
        try {
          const activity = persistExternalActivity(JSON.parse(body));
          if (!activity) throw new Error('invalid activity');
          res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, activity }));
        } catch {
          res.writeHead(400).end();
        }
      });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/permission-request') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20000) req.destroy(); // malformed/oversized -- bail rather than buffer unbounded
    });
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let timer;
      const resolve = (decision) => {
        if (!pendingPermissionRequests.has(requestId)) return; // already resolved (timeout raced the click)
        pendingPermissionRequests.delete(requestId);
        clearTimeout(timer);
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ decision }));
        } catch {
          /* client (the hook) already gave up -- nothing to do */
        }
        // decision is only ever null via this timeout path (a click always
        // sends 'allow'/'deny') -- tell the card to remove itself right now
        // instead of sitting there forever. Confirmed bug: without this the
        // card outlived its own request whenever the user answered in the
        // terminal instead (which only happens *after* this timeout already
        // gave up and let the real prompt through), and looked permanently
        // stuck on the desktop.
        if (decision === null && alive()) win.webContents.send('pet:permission-resolved', requestId);
      };
      timer = setTimeout(() => resolve(null), PERMISSION_TIMEOUT_MS);
      pendingPermissionRequests.set(requestId, resolve);
      // If the hook's own process dies/gets killed/times out on its side
      // before a decision is made, the underlying socket closes and there's
      // no longer anyone to deliver a decision to -- resolve (and tell the
      // card to remove itself) right away instead of leaving a
      // now-pointless card on screen for up to another 55s. Confirmed live:
      // without this, a hook invocation that exited early left an orphaned
      // card that a later click on could never actually do anything.
      req.on('close', () => resolve(null));
      if (alive()) {
        win.webContents.send('pet:permission-request', {
          requestId,
          sessionId: payload.sessionId ?? null,
          toolName: payload.toolName ?? '',
          summary: payload.summary ?? '',
          expiresAt: Date.now() + PERMISSION_TIMEOUT_MS,
        });
      } else {
        // No pet window to show a card in right now -- resolve immediately
        // (no decision) instead of making the real hook/terminal wait out
        // the full timeout for a card nobody could ever have seen.
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
  permissionServer.on('error', (err) => {
    if (cfg.debug) console.error('[local-bridge] failed to start:', err.message);
    permissionServer = null;
  });
  permissionServer.listen(PERMISSION_SERVER_PORT, '127.0.0.1');
}

ipcMain.on('pet:permission-response', (_e, { requestId, decision } = {}) => {
  pendingPermissionRequests.get(requestId)?.(decision);
});

ipcMain.on('pet:pomodoro-start', () => startPomodoroTimer(pomodoroDefaultMs()));
ipcMain.on('pet:pomodoro-stop', () => stopPomodoro(false));

// A real panel (see openTodoPanel below), not a native menu you can only
// glance at -- same growable-window pattern as the chat panel.
let todoPanelOpen = false;
const TODO_PANEL_W = 260;
const TODO_PANEL_H = 340;

function openTodoPanel(initialTab) {
  if (!win || win.isDestroyed() || dragging || todoPanelOpen || chatPanelOpen || toolbarOpen) return;
  cancelWander();
  const petRect = truePetRect(win.getBounds());
  clearBubbleGrowthForPanel();
  const targetW = Math.max(PET_W, TODO_PANEL_W);
  const targetH = PET_H + TODO_PANEL_H;
  const grown = resizedBoundsKeepingAnchor(petRect, targetW, targetH);
  const { x, y, width, height } = screen.getDisplayNearestPoint({ x: grown.x, y: grown.y }).workArea;
  const clampedX = Math.min(Math.max(grown.x, x), x + width - targetW);
  const clampedY = Math.min(Math.max(grown.y, y), y + height - targetH);
  win.setBounds({ x: Math.round(clampedX), y: Math.round(clampedY), width: targetW, height: targetH });
  baseSize = { width: targetW, height: targetH };
  win.setIgnoreMouseEvents(false);
  win.setFocusable(true);
  win.focus();
  todoPanelOpen = true;
  if (cfg.debug) console.log('[todo-panel] opened %dx%d', targetW, targetH);
  win.webContents.send('pet:todo-panel-ready', { petH: PET_H, initialTab: initialTab === 'tasks' ? 'tasks' : 'todo' });
  sendTodos();
  if (initialTab === 'tasks') win.webContents.send('pet:task-list-result', { sessions: readActiveSessions() });
}

function closeTodoPanel() {
  if (!win || win.isDestroyed() || !todoPanelOpen) return;
  todoPanelOpen = false;
  win.setFocusable(false);
  const bounds = win.getBounds();
  const shrunk = resizedBoundsKeepingAnchor(bounds, PET_W, PET_H);
  win.setBounds({ x: Math.round(shrunk.x), y: Math.round(shrunk.y), width: PET_W, height: PET_H });
  baseSize = { width: PET_W, height: PET_H };
  if (cfg.debug) console.log('[todo-panel] closed');
  win.webContents.send('pet:todo-panel-closed');
}

ipcMain.on('pet:todo-panel-open', () => openTodoPanel());
ipcMain.on('pet:todo-panel-close', () => closeTodoPanel());

// Model settings -- which Ollama model screenTips/chat call. A dropdown
// beats hand-editing config.json: no restart needed, and it's populated
// from whatever's actually pulled locally so you can't typo a model name
// that doesn't exist.
async function listOllamaModels() {
  const ollamaUrl = (cfg.chat?.ollamaUrl ?? cfg.screenTips?.ollamaUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return []; // Ollama not running/reachable -- dropdown just shows empty, no crash
  }
}

ipcMain.on('pet:settings-set', (_e, { field, value }) => {
  // Deliberately not `if (!value) return` -- that silently drops `false`
  // and `0`, which are exactly the values toggles/hour-pickers need to be
  // able to set. undefined/null are the only "nothing was sent" cases.
  if (value === undefined || value === null) return;
  switch (field) {
    case 'screenTipsModel':
      if (cfg.screenTips) cfg.screenTips.model = value;
      break;
    case 'screenTipsProvider':
      if (cfg.screenTips) cfg.screenTips.provider = value;
      break;
    case 'screenTipsBaseUrl':
      if (cfg.screenTips) cfg.screenTips.baseUrl = value;
      break;
    case 'screenTipsApiKeyEnv':
      if (cfg.screenTips) cfg.screenTips.apiKeyEnv = value;
      break;
    case 'cameraSenseEnabled':
      cfg.cameraSense = cfg.cameraSense ?? {};
      cfg.cameraSense.enabled = !!value;
      if (value) startCameraSense();
      else stopCameraSense();
      break;
    case 'cameraSenseIntervalMs':
      cfg.cameraSense = cfg.cameraSense ?? {};
      cfg.cameraSense.intervalMs = Math.max(30000, Number(value) || 120000);
      break;
    case 'screenTipsEnabled':
      // The master on/off, distinct from screenTipsPaused (a runtime-only
      // "quiet for now" toggle). Previously this could only be turned off
      // by hand-editing config.json and back on the same way -- the
      // right-click submenu that would let you touch it only *shows up*
      // when it's already on, so there was no way back in from the UI.
      cfg.screenTips = cfg.screenTips ?? {};
      cfg.screenTips.enabled = !!value;
      if (value) startScreenTips();
      else stopScreenTips();
      buildTrayMenu();
      break;
    case 'tipDisplayStacked':
      cfg.screenTips = cfg.screenTips ?? {};
      cfg.screenTips.stackedDisplay = !!value;
      if (alive()) win.webContents.send('pet:tip-display-mode', !!value);
      break;
    case 'screenTipsIntervalMs':
      // No restart needed -- createScreenTipWatcher re-reads cfg.intervalMs
      // fresh on every reschedule of its own setTimeout, same as workSupervision.
      cfg.screenTips = cfg.screenTips ?? {};
      cfg.screenTips.intervalMs = Math.max(30000, Number(value) || 180000);
      break;
    case 'soundsEnabled':
      cfg.sounds = cfg.sounds ?? {};
      cfg.sounds.enabled = !!value;
      if (alive()) win.webContents.send('pet:sounds-enabled', !!value);
      break;
    case 'gestures': {
      // value = { annoyedLines, annoyedRow, petLines, petRow, hoverLines, hoverRow }
      // from the dashboard's "手势" form -- one line-array field per gesture,
      // each pre-split by the renderer (one phrase per line, blanks dropped).
      cfg.gestures = cfg.gestures ?? {};
      for (const key of ['annoyedLines', 'petLines', 'hoverLines']) {
        if (Array.isArray(value?.[key])) cfg.gestures[key] = value[key].filter((l) => typeof l === 'string' && l.trim()).slice(0, 20);
      }
      for (const key of ['annoyedRow', 'petRow', 'hoverRow']) {
        if (!(key in (value ?? {}))) continue;
        const n = value[key];
        cfg.gestures[key] = n === null || n === '' || n === undefined ? null : Math.max(0, Number(n) || 0);
      }
      if (alive()) win.webContents.send('pet:gestures-changed', cfg.gestures);
      break;
    }
    case 'chatModel':
      if (cfg.chat) cfg.chat.model = value;
      break;
    case 'chatProvider':
      if (cfg.chat) cfg.chat.provider = value;
      break;
    case 'chatBaseUrl':
      if (cfg.chat) cfg.chat.baseUrl = value;
      break;
    case 'chatApiKeyEnv':
      if (cfg.chat) cfg.chat.apiKeyEnv = value;
      break;
    case 'chatEnabled':
      // Same gap as screenTipsEnabled above -- "跟他聊天" only appeared in
      // the right-click menu when chat was already on, no way back in
      // once off. No watcher to start/stop here (chat is request-driven,
      // not a timer), just the flag pet:chat-send already checks.
      cfg.chat = cfg.chat ?? {};
      cfg.chat.enabled = !!value;
      buildTrayMenu();
      break;
    case 'musicNodEnabled':
      // The ring toggle and right-click checkbox both flip the *runtime*
      // musicNodEnabled variable already; this is what makes that choice
      // survive a restart instead of always reverting to config.json's
      // stale default. See performToggle/the tray menu's own click
      // handlers for the runtime half of this.
      cfg.musicNod = cfg.musicNod ?? {};
      cfg.musicNod.enabled = !!value;
      break;
    case 'pomodoroDurationMin':
      cfg.pomodoro = cfg.pomodoro ?? {};
      cfg.pomodoro.durationMin = Math.max(1, Number(value) || 25);
      buildTrayMenu();
      break;
    case 'companionEnabled':
      cfg.companion = cfg.companion ?? {};
      cfg.companion.enabled = !!value;
      break;
    case 'workSupervisionEnabled':
      cfg.workSupervision = cfg.workSupervision ?? {};
      cfg.workSupervision.enabled = !!value;
      if (value) startWorkSupervision();
      else stopWorkSupervision();
      break;
    case 'workSupervisionIntervalMs':
      // No restart needed -- the watcher was created with a *reference* to
      // cfg.workSupervision, so it re-reads intervalMs fresh on every
      // reschedule (same trick screenTips' own frequency menu already
      // relies on).
      cfg.workSupervision = cfg.workSupervision ?? {};
      cfg.workSupervision.intervalMs = Number(value);
      break;
    case 'sleepEnabled':
      cfg.sleepSchedule = cfg.sleepSchedule ?? {};
      cfg.sleepSchedule.enabled = !!value;
      if (alive()) win.webContents.send('pet:sleep-settings', cfg.sleepSchedule);
      break;
    case 'sleepStartHour':
      cfg.sleepSchedule = cfg.sleepSchedule ?? {};
      cfg.sleepSchedule.startHour = Number(value);
      if (alive()) win.webContents.send('pet:sleep-settings', cfg.sleepSchedule);
      break;
    case 'sleepEndHour':
      cfg.sleepSchedule = cfg.sleepSchedule ?? {};
      cfg.sleepSchedule.endHour = Number(value);
      if (alive()) win.webContents.send('pet:sleep-settings', cfg.sleepSchedule);
      break;
    case 'dailySummaryEnabled':
      cfg.dailySummary = cfg.dailySummary ?? {};
      cfg.dailySummary.enabled = !!value;
      if (value) startDailySummaryTimer();
      else stopDailySummaryTimer();
      break;
    case 'dailySummaryIntervalMs':
      cfg.dailySummary = cfg.dailySummary ?? {};
      cfg.dailySummary.intervalMs = Number(value);
      if (dailySummaryTimer) {
        stopDailySummaryTimer();
        startDailySummaryTimer();
      }
      break;
    case 'statusLightsEnabled':
      cfg.statusLights = cfg.statusLights ?? {};
      cfg.statusLights.enabled = !!value;
      if (alive()) win.webContents.send('pet:status-lights-enabled', !!value);
      break;
    case 'contextRingEnabled':
      cfg.claudeStatus = cfg.claudeStatus ?? {};
      cfg.claudeStatus.contextRingEnabled = !!value;
      if (alive()) win.webContents.send('pet:context-ring-enabled', !!value);
      break;
    case 'dashboardPanelAlpha':
      cfg.dashboard = cfg.dashboard ?? {};
      cfg.dashboard.panelAlpha = Math.min(1, Math.max(0.3, Number(value) || 0.92));
      if (dashboardWin && !dashboardWin.isDestroyed()) dashboardWin.setOpacity(cfg.dashboard.panelAlpha);
      break;
    case 'memoryEnabled':
      cfg.petMemory = cfg.petMemory ?? {};
      cfg.petMemory.enabled = !!value;
      break;
    case 'petSkinColor': {
      const hex = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#faf0e4';
      cfg.theme = cfg.theme ?? {};
      cfg.theme.skinColor = hex;
      if (alive()) win.webContents.send('pet:skin-color', hex);
      break;
    }
    case 'musicCommentChance': {
      const pet = activePet();
      pet.musicTaste = pet.musicTaste ?? {};
      pet.musicTaste.commentChance = Math.min(1, Math.max(0, Number(value)));
      break;
    }
    case 'musicCommentCooldownMs': {
      const pet = activePet();
      pet.musicTaste = pet.musicTaste ?? {};
      pet.musicTaste.cooldownMs = Math.max(30000, Number(value));
      break;
    }
    default:
      return;
  }
  persistConfig();
});

ipcMain.on('pet:report-request', async (_e, kind) => {
  const text = await buildReport(kind === 'week' ? 'week' : 'day');
  if (alive()) win.webContents.send('pet:report-result', { text });
});

// Hover toolbar ring -- quick access + at-a-glance toggle state, replacing
// the old "linger on the sprite opens the reply box" gesture. Grows the
// window symmetrically around the sprite (see growBoundsForRing) instead
// of to one side like the bubbles/chat/todo panel, since the ring needs
// room on every side at once.
let toolbarOpen = false;
let toolbarPetRect = null;
const RING_EXTRA = 130;

function toolbarState() {
  return { pomodoroActive: !!pomodoroState, musicNodEnabled, wanderPaused: paused };
}

function openToolbar() {
  if (!win || win.isDestroyed() || dragging || toolbarOpen || chatPanelOpen || todoPanelOpen) return;
  cancelWander();
  const petRect = truePetRect(win.getBounds());
  clearBubbleGrowthForPanel();
  const grown = growBoundsForRing(petRect, RING_EXTRA);
  const { x, y, width, height } = screen.getDisplayNearestPoint({ x: grown.x, y: grown.y }).workArea;
  const clampedX = Math.min(Math.max(grown.x, x), x + width - grown.width);
  const clampedY = Math.min(Math.max(grown.y, y), y + height - grown.height);
  win.setBounds({ x: Math.round(clampedX), y: Math.round(clampedY), width: grown.width, height: grown.height });
  toolbarPetRect = { ...petRect };
  baseSize = { width: grown.width, height: grown.height };
  win.setIgnoreMouseEvents(false);
  toolbarOpen = true;
  if (cfg.debug) console.log('[toolbar] opened');
  win.webContents.send('pet:toolbar-ready', {
    petW: PET_W,
    petH: PET_H,
    petX: petRect.x - clampedX,
    petY: petRect.y - clampedY,
    windowW: grown.width,
    windowH: grown.height,
    ringExtra: RING_EXTRA,
    state: toolbarState(),
  });
}

function closeToolbar() {
  if (!win || win.isDestroyed() || !toolbarOpen) return;
  toolbarOpen = false;
  const target = toolbarPetRect ?? resizedBoundsKeepingAnchor(win.getBounds(), PET_W, PET_H);
  win.setBounds({ x: Math.round(target.x), y: Math.round(target.y), width: PET_W, height: PET_H });
  toolbarPetRect = null;
  baseSize = { width: PET_W, height: PET_H };
  if (cfg.debug) console.log('[toolbar] closed');
  win.webContents.send('pet:toolbar-closed');
}

ipcMain.on('pet:toolbar-open', () => openToolbar());
ipcMain.on('pet:toolbar-close', () => closeToolbar());

// A recovery path if a panel's window-growth state ever gets stuck out of
// sync with what's actually on screen -- unconditionally snaps the window
// back to the plain sprite size regardless of which internal flag caused
// the problem. Shared by the tray/right-click menu item and the global
// shortcut below, same as performAction/performToggle.
function forceResetSize() {
  chatPanelOpen = false;
  todoPanelOpen = false;
  toolbarOpen = false;
  bubbleSide = null;
  bubbleExtra = 0;
  win.setFocusable(false);
  win.setBounds({ ...clampToDisplay(win.getPosition()[0], win.getPosition()[1]), width: PET_W, height: PET_H });
  baseSize = { width: PET_W, height: PET_H };
  win.webContents.send('pet:reply-box-close-forced');
}

// Shared by the ring toolbar's action/toggle buttons AND global keyboard
// shortcuts (see registerShortcuts below) -- one place that actually knows
// how to do each thing, so a shortcut firing behaves identically to
// clicking the equivalent ring button.
function performAction(action) {
  if (action === 'chat') openChatPanel();
  else if (action === 'todo') openTodoPanel();
  else if (action === 'tasks') openTodoPanel('tasks');
  else if (action === 'settings') openDashboard();
  else if (action === 'resetSize') forceResetSize();
}

function performToggle(toggle) {
  if (toggle === 'pomodoro') {
    if (pomodoroState) stopPomodoro(false);
    else startPomodoroTimer(pomodoroDefaultMs());
  } else if (toggle === 'musicNod') {
    musicNodEnabled = !musicNodEnabled;
    if (musicNodEnabled) startAudioNod();
    else stopAudioNod();
    cfg.musicNod = cfg.musicNod ?? {};
    cfg.musicNod.enabled = musicNodEnabled;
    persistConfig();
  } else if (toggle === 'wander') {
    paused = !paused;
    if (paused) cancelWander();
    sendPetToggles();
  }
  if (alive()) win.webContents.send('pet:toolbar-state', toolbarState());
}

ipcMain.on('pet:toolbar-action', (_e, action) => {
  closeToolbar();
  performAction(action);
});

ipcMain.on('pet:toolbar-toggle', (_e, toggle) => performToggle(toggle));

// Global keyboard shortcuts -- one per ring action/toggle, all opt-in (unset
// by default; a desktop pet silently eating a hotkey combo you already use
// elsewhere would be a nasty surprise). Configured from the dashboard's
// "快捷键" section, which can either capture a live keypress or let you type
// an Electron accelerator string directly. Registered globally (works even
// when no window is focused), same as any system-wide hotkey app.
const SHORTCUT_ACTIONS = [
  { key: 'chat', label: '打开聊天', kind: 'action' },
  { key: 'todo', label: '打开待办', kind: 'action' },
  { key: 'tasks', label: '打开任务列表', kind: 'action' },
  { key: 'settings', label: '打开控制面板', kind: 'action' },
  { key: 'resetSize', label: '恢复正常大小', kind: 'action' },
  { key: 'pomodoro', label: '切换番茄钟', kind: 'toggle' },
  { key: 'musicNod', label: '切换听歌点头', kind: 'toggle' },
  { key: 'wander', label: '切换到处走', kind: 'toggle' },
];

// Re-registers every configured shortcut from scratch (Electron has no
// partial-update API) and returns the list of keys whose accelerator failed
// to register -- usually because the OS or another app already owns that
// combo, which globalShortcut.register() reports by simply returning false
// rather than throwing.
function registerShortcuts() {
  globalShortcut.unregisterAll();
  const failures = [];
  for (const { key, kind } of SHORTCUT_ACTIONS) {
    const accel = cfg.shortcuts?.[key];
    if (!accel) continue;
    try {
      const ok = globalShortcut.register(accel, () => {
        if (kind === 'toggle') performToggle(key);
        else performAction(key);
      });
      if (!ok) failures.push(key);
    } catch {
      failures.push(key); // malformed accelerator string
    }
  }
  return failures;
}

ipcMain.handle('dashboard:set-shortcut', (_e, { key, accelerator }) => {
  if (!SHORTCUT_ACTIONS.some((a) => a.key === key)) return { ok: false };
  cfg.shortcuts = cfg.shortcuts ?? {};
  cfg.shortcuts[key] = accelerator || '';
  persistConfig();
  const failures = registerShortcuts();
  return { ok: !failures.includes(key) };
});

let audioNodProc = null;
let musicNodEnabled = false;
let audioNodStdoutBuf = '';
let musicBeatSamples = [];
let lastMusicCommentAt = 0;
let musicCommentInFlight = false;

const MUSIC_MOOD_DESC = {
  intense: '节奏快、能量高，听起来很带劲',
  delicate: '节奏舒缓、能量低，听起来很温柔安静',
  neutral: '节奏适中，不快不慢',
};

// Real per-song identification (track title/artist) isn't wired up -- this
// works off the same real-time energy/tempo classification the beat-nod
// animation itself uses (see classifyMusicPulse), so "根据当前音乐" here
// means "reacting to how this moment's audio actually sounds", not the
// track's name. Falls back to a static line from the phrase pool whenever
// the chat model isn't configured/enabled or the call fails -- ambient
// background commentary shouldn't ever block on, or retry, a flaky network
// call, and the pool exists precisely as an always-available floor.
//
// Confirmed live bug: this call is fire-and-forget (see the .then() at the
// call site below) rather than blocking the beat-processing loop, so there
// was no real reason to cap its timeout tightly -- but an earlier version
// did anyway (20s), which silently lost to local Ollama models every time:
// streamOllamaChat's own header comment already documents ~40-55s for a
// single non-streaming reply from a 12B model, which is exactly the size
// class configured here. The result was invisible from the outside -- the
// try/catch below still produced *a* comment via the phrase-pool fallback,
// so it looked like the feature was working while silently never actually
// using the AI path. No artificial ceiling now; same default other one-shot
// calls in this file use.
async function generateMusicComment(samples, taste) {
  const mood = classifyMusicPulse(samples);
  const chatCfg = cfg.chat ?? {};
  if (!chatCfg.enabled) return pickMusicComment(samples, taste);
  const prompt =
    `你正在听主人现在播放的音乐，能感受到的特点是：${MUSIC_MOOD_DESC[mood] ?? MUSIC_MOOD_DESC.neutral}。` +
    '用你自己的角色口吻，即兴说一句话评论一下这段音乐或跟着的感觉——不超过 20 个字，只输出这一句话，不要加引号、不要解释。';
  try {
    const pet = activePet();
    const systemPrompt = pet.chatSystemPrompt ?? chatCfg.systemPrompt;
    const full = await streamChatReply({ ...chatCfg, timeoutMs: chatCfg.timeoutMs ?? 90000, systemPrompt }, [{ role: 'user', content: prompt }], () => {});
    const text = full.trim().replace(/^["'“”]+|["'“”]+$/g, '').slice(0, 40);
    return text ? { mood, text } : pickMusicComment(samples, taste);
  } catch (err) {
    if (cfg.debug) console.error('[music-comment] AI generation failed, falling back to phrase pool:', err.message);
    return pickMusicComment(samples, taste);
  }
}

function stopAudioNod() {
  if (audioNodProc) {
    audioNodProc.kill();
    audioNodProc = null;
  }
  audioNodStdoutBuf = '';
  musicBeatSamples = [];
}

// Real WASAPI loopback capture (tools/audio-nod, see its README) -- not a
// simulated beat. On any failure (device error, exe missing) log once and
// give up for this session rather than retry-looping; the user can retry
// via the menu checkbox.
function startAudioNod() {
  if (audioNodProc) return;
  const exePath = join(root, 'tools', 'audio-nod', 'audio-nod.exe');
  if (!existsSync(exePath)) {
    if (cfg.debug) console.error('[audio-nod] exe not found at', exePath);
    return;
  }
  const child = spawn(exePath, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  audioNodProc = child;
  child.stdout.on('data', (chunk) => {
    audioNodStdoutBuf += chunk.toString('utf8');
    const lines = audioNodStdoutBuf.split('\n');
    audioNodStdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (msg.beat && alive()) {
        if (cfg.debug) console.log('[audio-nod] beat energy=%s', msg.energy);
        win.webContents.send('pet:beat', { energy: msg.energy });
        const now = Date.now();
        musicBeatSamples.push({ energy: Number(msg.energy), ts: now });
        musicBeatSamples = musicBeatSamples.filter((s) => now - s.ts <= 20000).slice(-24);
        const taste = activePet().musicTaste;
        const cooldownMs = Math.max(30000, Number(taste?.cooldownMs) || 120000);
        const chance = Math.min(1, Math.max(0, Number(taste?.commentChance) || 0.08));
        // musicCommentInFlight, not just the cooldown timer, guards the next
        // trigger: cooldownMs only has a 30s floor (user-configurable, see
        // the dashboard slider), but a real local-model generation can
        // measurably exceed that under load -- confirmed live: without this
        // guard, a slow generation left the cooldown window elapse again
        // before it finished, so a second (then third...) overlapping
        // request piled up on top of it, each one competing for the same
        // Ollama process and making every one of them slower still.
        if (musicBeatSamples.length >= 8 && !musicCommentInFlight && now - lastMusicCommentAt >= cooldownMs && Math.random() < chance) {
          lastMusicCommentAt = now;
          musicCommentInFlight = true;
          const samplesSnapshot = [...musicBeatSamples];
          generateMusicComment(samplesSnapshot, taste)
            .then((comment) => {
              if (comment && alive()) win.webContents.send('pet:music-comment', comment);
            })
            .finally(() => {
              musicCommentInFlight = false;
            });
        }
      } else if (msg.status === 'error' && cfg.debug) {
        console.error('[audio-nod]', msg.message);
      } else if (msg.status === 'started' && cfg.debug) {
        console.log('[audio-nod] capturing', msg.sampleRate, 'Hz', msg.channels, 'ch');
      }
    }
  });
  child.on('exit', (code) => {
    if (cfg.debug && code !== 0) console.error('[audio-nod] exited code', code);
    if (audioNodProc === child) audioNodProc = null;
  });
  child.on('error', (err) => {
    if (cfg.debug) console.error('[audio-nod] spawn failed:', err.message);
    if (audioNodProc === child) audioNodProc = null;
  });
}

function sendPetToggles() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('pet:toggles', {
    statusBubbleEnabled,
    tipBubbleEnabled,
    randomActionsEnabled,
    wanderEnabled: wanderEnabled(),
  });
}

// A transparent always-on-top window that has silently grown is invisible but
// steals clicks everywhere it covers. Never let its size drift.
function enforceSize() {
  if (!win || win.isDestroyed() || !baseSize) return;
  const b = win.getBounds();
  if (b.width === baseSize.width && b.height === baseSize.height) return;
  // Drift of a pixel or two per move is expected at fractional DPI; only shout
  // if it ever gets far enough to matter.
  const drift = Math.max(
    Math.abs(b.width - baseSize.width),
    Math.abs(b.height - baseSize.height),
  );
  if (drift > 8) {
    console.error('[size guard] large drift %dx%d -> %dx%d', b.width, b.height, baseSize.width, baseSize.height);
  }
  win.setBounds({ x: b.x, y: b.y, width: baseSize.width, height: baseSize.height });
}

function activePet() {
  return cfg.pets.find((p) => p.id === cfg.activePet) ?? cfg.pets[0];
}

function petPayload(pet) {
  return {
    id: pet.id,
    displayName: pet.displayName,
    gaze: pet.gaze ?? {},
    profile: pet.profile ?? {},
    // Rows that are a different creature than the rest of the atlas (the
    // raven, for Sebastian). Empty for a pet that never transforms.
    ravenRows: pet.ravenRows ?? [],
    claudeStatusRows: pet.claudeStatusRows ?? {},
    spritesheetUrl: pathToFileURL(pet.spritesheetPath).href,
  };
}

// Character packs -- import someone else's (or your own) sprite sheet as a
// selectable pet, mirroring mantou-deskpet's "换皮肤：角色包" feature but
// adapted to this app's actual sprite system: one fixed atlas grid shared
// by every pet (see atlas.js), not mantou's per-slot arbitrary video clips.
// A pack is just a folder holding a spritesheet image (matching that exact
// grid) plus an optional pack.json with the same shape as a `pets[]` entry
// in config.json. No pack.json at all still imports fine -- generic row
// defaults below use only the base-11-row semantics every valid sheet has.
const DEFAULT_PACK_PROFILE = {
  performRows: [3, 4],
  restRow: 7,
  fillerRow: 5,
  weights: { wander: 0.45, perform: 0.3, filler: 0.15, rest: 0.1 },
  idleDwellMs: [7000, 16000],
  performMs: 2600,
  fillerMs: 4000,
  restMs: 7000,
  wanderSpeed: 90,
  spinEnabled: true,
  visitChance: 0,
  edgePerchChance: 0,
  lieDownChance: 0,
};
const DEFAULT_PACK_CLAUDE_ROWS = { working: 3, review: 8, waiting: 6, error: 5 };
const DEFAULT_PACK_GAZE = { mode: 'lean', tau: 0.2, deadzone: 10, radius: 600, attentionMs: 1500, maxLeanPx: 6, hysteresis: 5, subFrameGain: 0, fullTurnPx: 480 };

function findPackImage(dir) {
  const preferred = ['spritesheet.webp', 'spritesheet.png'];
  const files = readdirSync(dir);
  for (const name of preferred) {
    if (files.includes(name)) return join(dir, name);
  }
  const anyImage = files.find((f) => /\.(webp|png)$/i.test(f));
  return anyImage ? join(dir, anyImage) : null;
}

function slugifyPackId(name) {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-+|-+$/g, '') || 'pack';
  let id = base;
  let n = 2;
  while (cfg.pets.some((p) => p.id === id)) {
    id = `${base}-${n++}`;
  }
  return id;
}

// Import is two IPC round-trips, not one, because of a real gap found while
// testing this: Electron's nativeImage (main process) fails to decode this
// app's own actual spritesheet.webp files -- getSize() silently returns
// {0,0} for a file that a plain <img> in the renderer loads and uses just
// fine every time the app starts. So dimension validation can't happen
// here; it happens in the renderer (dashboard-renderer.js), which loads the
// candidate image the same way renderer.js's loadPet() already does and
// only calls dashboard:commit-pet-pack once *that* confirms it decodes and
// measures correctly.
// Custom notification sounds -- an actual audio file per trigger, played
// via the renderer's <audio> element instead of (or alongside a fallback
// to) the built-in Web Audio oscillator tones. cfg.sounds.<slot>File holds
// the raw filesystem path; soundsPayload() below converts it to a
// file:// URL for the renderer the same way spritesheet/screenshot paths
// already are elsewhere in this file.
const SOUND_SLOTS = new Set(['pomodoro', 'alert', 'pet']);

function soundsPayload() {
  const s = cfg.sounds ?? {};
  const urlFor = (slot) => {
    const p = s[`${slot}File`];
    return p && existsSync(p) ? pathToFileURL(p).href : null;
  };
  return {
    enabled: !!s.enabled,
    pomodoroUrl: urlFor('pomodoro'),
    alertUrl: urlFor('alert'),
    petUrl: urlFor('pet'),
  };
}

ipcMain.handle('dashboard:pick-sound-file', async (_e, slot) => {
  if (!SOUND_SLOTS.has(slot)) return { ok: false, error: '未知的音效槽位' };
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    title: '选择音频文件',
    filters: [{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true };
  cfg.sounds = cfg.sounds ?? {};
  cfg.sounds[`${slot}File`] = result.filePaths[0];
  persistConfig();
  if (alive()) win.webContents.send('pet:sounds-files-changed', soundsPayload());
  return { ok: true, ...soundsPayload() };
});

ipcMain.handle('dashboard:clear-sound-file', (_e, slot) => {
  if (!SOUND_SLOTS.has(slot)) return { ok: false, error: '未知的音效槽位' };
  cfg.sounds = cfg.sounds ?? {};
  delete cfg.sounds[`${slot}File`];
  persistConfig();
  if (alive()) win.webContents.send('pet:sounds-files-changed', soundsPayload());
  return { ok: true, ...soundsPayload() };
});

ipcMain.handle('dashboard:pick-pet-pack-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择角色包文件夹' });
  if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true };
  const dir = result.filePaths[0];

  const imagePath = findPackImage(dir);
  if (!imagePath) return { ok: false, error: '文件夹里没找到雪碧图（spritesheet.webp 或 spritesheet.png）' };

  let packJson = {};
  const packJsonPath = join(dir, 'pack.json');
  if (existsSync(packJsonPath)) {
    try {
      packJson = JSON.parse(readFileSync(packJsonPath, 'utf8'));
    } catch (err) {
      return { ok: false, error: `pack.json 解析失败：${err.message}` };
    }
  }
  return { ok: true, dir, imagePath, imageUrl: pathToFileURL(imagePath).href, packJson };
});

ipcMain.handle('dashboard:commit-pet-pack', (_e, { dir, imagePath, packJson, rowCount }) => {
  const displayName = packJson.displayName || dir.split(/[\\/]/).pop() || '未命名角色';
  const id = packJson.id && !cfg.pets.some((p) => p.id === packJson.id) ? packJson.id : slugifyPackId(packJson.id || displayName);

  const pet = {
    id,
    displayName,
    spritesheetPath: imagePath,
    chatSystemPrompt: packJson.chatSystemPrompt ?? 'You are a desktop pet companion. Reply in Chinese, in one or two short sentences.',
    hasExtendedRows: packJson.hasExtendedRows ?? rowCount >= ATLAS.rows,
    ravenRows: packJson.ravenRows ?? [],
    gaze: packJson.gaze ?? DEFAULT_PACK_GAZE,
    profile: packJson.profile ?? DEFAULT_PACK_PROFILE,
    claudeStatusRows: packJson.claudeStatusRows ?? DEFAULT_PACK_CLAUDE_ROWS,
    rowLabels: packJson.rowLabels ?? null,
  };
  cfg.pets.push(pet);
  persistConfig();
  return { ok: true, pet: { id: pet.id, displayName: pet.displayName } };
});

ipcMain.handle('dashboard:set-active-pet', (_e, id) => {
  if (!cfg.pets.some((p) => p.id === id)) return { ok: false };
  if (id === cfg.activePet) return { ok: true, restarted: false };
  cfg.activePet = id;
  persistConfig();
  app.relaunch();
  app.exit(0);
  return { ok: true, restarted: true };
});

// "不同动作适配不同状态" -- which atlas row plays for each Claude Code
// status (working/review/waiting/error), per active pet. Previously only
// settable by hand-editing claudeStatusRows in config.json/pack.json; this
// gives it the same dashboard entry point every other feature this session
// got. Takes effect on next launch, same as switching character packs --
// the renderer only reads claudeStatusRows once at startup (via pet:config)
// so there's no live-patch path without a lot more plumbing for something
// this minor.
ipcMain.handle('dashboard:set-action-mapping', (_e, { status, row }) => {
  const validStatuses = new Set(['working', 'review', 'waiting', 'error']);
  if (!validStatuses.has(status)) return { ok: false, error: '未知状态' };
  const rowNum = Number(row);
  if (!Number.isInteger(rowNum) || rowNum < 0) return { ok: false, error: '行号不对' };
  const pet = activePet();
  pet.claudeStatusRows = pet.claudeStatusRows ?? {};
  pet.claudeStatusRows[status] = rowNum;
  persistConfig();
  return { ok: true };
});

ipcMain.handle('dashboard:delete-pet-pack', (_e, id) => {
  if (cfg.pets.length <= 1) return { ok: false, error: '至少要留一个形象' };
  const idx = cfg.pets.findIndex((p) => p.id === id);
  if (idx === -1) return { ok: false, error: '找不到这个形象' };
  cfg.pets.splice(idx, 1);
  let restarted = false;
  if (cfg.activePet === id) {
    cfg.activePet = cfg.pets[0].id;
    restarted = true;
  }
  persistConfig();
  if (restarted) {
    app.relaunch();
    app.exit(0);
  }
  return { ok: true, restarted };
});

// Sebastian is a demon who moves like a crow; Ciel is a frail child who
// dislikes exertion. Their travel speeds should not match.
function wanderSpeed() {
  return activePet().profile?.wanderSpeed ?? 90;
}

function persistConfig() {
  writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

function createWindow() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;

  win = new BrowserWindow({
    width: PET_W,
    height: PET_H,
    x: Math.round(x + width / 2),
    y: y + height - PET_H,
    // NOT useContentSize: at fractional DPI it makes every setPosition
    // round-trip DIP<->physical, and the rounding compounds. At 60Hz the
    // window grew to 14000px wide, which silently swallowed clicks across
    // the whole screen.
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  baseSize = { width: win.getBounds().width, height: win.getBounds().height };

  // Renderer failures are otherwise invisible: a transparent window that draws
  // nothing looks identical to one that never started.
  if (cfg.debug) {
    win.webContents.on('console-message', (details) => {
      console.log(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    });
  }
  win.webContents.on('did-finish-load', () => {
    rendererLive = true;
    // Restore a completion that was still unseen when the app last closed
    // (see statusTrackingPath above) -- the renderer has no memory of its
    // own, so it needs telling once on this fresh load.
    sendUnseenCompletion();
    if (unseenCompletion) startFocusWatch();
    if (!cfg.debug) return;
    const d = screen.getPrimaryDisplay();
    console.log(
      '[diag] scaleFactor=%s workArea=%j bounds=%j contentBounds=%j petWH=%dx%d',
      d.scaleFactor,
      d.workArea,
      win.getBounds(),
      win.getContentBounds(),
      PET_W,
      PET_H,
    );
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    rendererLive = false;
    console.error('[renderer gone]', JSON.stringify(details));
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[preload error]', preloadPath, error);
  });

  win.loadFile(join(__dirname, 'index.html'));
}

// Full control-panel window -- a normal resizable/maximizable BrowserWindow,
// deliberately independent of the tiny frameless pet window (no shared
// bounds, no mutual-exclusion flags, the pet can keep wandering/dragging
// while this is open). Opened from the ring's ⚙️ button in place of the old
// small growable settings panel, which this supersedes entirely. Talks to
// the main process over its own request/response ("dashboard:*") channels
// rather than reusing the pet window's push-based ones, since those all
// target `win` specifically -- request/response means whichever window
// asked is automatically the one that gets the answer, no bookkeeping.
let dashboardWin = null;

function openDashboard() {
  if (dashboardWin && !dashboardWin.isDestroyed()) {
    dashboardWin.show();
    dashboardWin.focus();
    return;
  }
  const appIconPath = join(root, 'assets', 'app-icon.png');
  dashboardWin = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 720,
    minHeight: 480,
    title: '桌面宠物控制面板',
    // Keep a stable framed renderer instead of the crash-prone transparent
    // frameless variant. BrowserWindow.setOpacity below still makes the
    // complete native window (base layer included) genuinely translucent.
    backgroundColor: '#faf0e4',
    icon: existsSync(appIconPath) ? appIconPath : undefined,
    webPreferences: {
      preload: join(__dirname, 'dashboard-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  dashboardWin.setMenuBarVisibility(false);
  dashboardWin.setOpacity(Math.min(1, Math.max(0.3, Number(cfg.dashboard?.panelAlpha) || 0.92)));
  dashboardWin.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const protocol = new URL(url).protocol;
      if (protocol === 'https:' || protocol === 'http:') void shell.openExternal(url);
    } catch {
      // Invalid or non-web URLs stay blocked inside the renderer.
    }
    return { action: 'deny' };
  });
  dashboardWin.loadFile(join(__dirname, 'dashboard.html'));
  dashboardWin.on('closed', () => {
    dashboardWin = null;
  });
  if (cfg.debug) {
    dashboardWin.webContents.on('console-message', (details) => {
      console.log(`[dashboard:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    });
  }
}

ipcMain.on('dashboard:preview-opacity', (_e, value) => {
  if (!dashboardWin || dashboardWin.isDestroyed()) return;
  dashboardWin.setOpacity(Math.min(1, Math.max(0.3, Number(value) || 0.92)));
});

function dashboardSnapshot() {
  const aiStatusSnapshot = pickPrimaryActivity(readActiveSessions(), { staleMs: activityCfg.staleMs ?? 120000 });
  return {
    todos: sortTodosForDisplay(activeTodos(todos)),
    sessions: readActiveSessions(),
    pomodoro: { active: !!pomodoroState, endsAt: pomodoroState?.endsAt ?? null },
    aiStatus: aiStatusSnapshot,
    claudeStatus: aiStatusSnapshot,
    settings: {
      screenTipsModel: cfg.screenTips?.model ?? '',
      screenTipsProvider: cfg.screenTips?.provider ?? 'ollama',
      screenTipsBaseUrl: cfg.screenTips?.baseUrl ?? '',
      screenTipsApiKeyEnv: cfg.screenTips?.apiKeyEnv ?? '',
      screenTipsPaused,
      chatModel: cfg.chat?.model ?? '',
      chatProvider: cfg.chat?.provider ?? 'ollama',
      chatBaseUrl: cfg.chat?.baseUrl ?? '',
      chatApiKeyEnv: cfg.chat?.apiKeyEnv ?? '',
      workSupervisionEnabled: !!cfg.workSupervision?.enabled,
      workSupervisionIntervalMs: cfg.workSupervision?.intervalMs ?? 180000,
      sleepEnabled: !!cfg.sleepSchedule?.enabled,
      sleepStartHour: cfg.sleepSchedule?.startHour ?? 1,
      sleepEndHour: cfg.sleepSchedule?.endHour ?? 6,
      dailySummaryEnabled: !!cfg.dailySummary?.enabled,
      dailySummaryIntervalMs: cfg.dailySummary?.intervalMs ?? 21600000,
      statusLightsEnabled: cfg.statusLights?.enabled ?? true,
      contextRingEnabled: cfg.claudeStatus?.contextRingEnabled ?? true,
      dashboardPanelAlpha: cfg.dashboard?.panelAlpha ?? 0.92,
      screenTipsIntervalMs: cfg.screenTips?.intervalMs ?? 180000,
      memoryEnabled: cfg.petMemory?.enabled ?? true,
      screenTipsEnabled: !!cfg.screenTips?.enabled,
      chatEnabled: !!cfg.chat?.enabled,
      musicNodEnabled: !!cfg.musicNod?.enabled,
      pomodoroDurationMin: cfg.pomodoro?.durationMin ?? 25,
      companionEnabled: !!cfg.companion?.enabled,
      tipDisplayStacked: !!cfg.screenTips?.stackedDisplay,
      soundsEnabled: !!cfg.sounds?.enabled,
      soundFileNames: {
        pomodoro: cfg.sounds?.pomodoroFile ? basename(cfg.sounds.pomodoroFile) : null,
        alert: cfg.sounds?.alertFile ? basename(cfg.sounds.alertFile) : null,
        pet: cfg.sounds?.petFile ? basename(cfg.sounds.petFile) : null,
      },
      petSkinColor: cfg.theme?.skinColor ?? '#faf0e4',
      musicCommentChance: activePet().musicTaste?.commentChance ?? 0.08,
      musicCommentCooldownMs: activePet().musicTaste?.cooldownMs ?? 120000,
    },
    gestures: cfg.gestures ?? {},
    outlookSync: { clientId: cfg.outlookSync?.clientId ?? '', tenantId: cfg.outlookSync?.tenantId ?? 'common' },
    shortcuts: cfg.shortcuts ?? {},
    pets: cfg.pets.map((p) => ({ id: p.id, displayName: p.displayName })),
    activePet: activePet().id,
    memoryCount: petMemory.length,
    actionMapping: {
      rowCount: activePet().hasExtendedRows ? ATLAS.rows : BASE_ROWS,
      rowLabels: activePet().rowLabels ?? null,
      claudeStatusRows: activePet().claudeStatusRows ?? {},
    },
  };
}

ipcMain.handle('dashboard:get-data', () => dashboardSnapshot());
ipcMain.handle('dashboard:get-memory', () => dashboardMemoryPayload());
ipcMain.handle('dashboard:delete-memory', (_e, id) => {
  petMemory = petMemory.filter((m) => m.id !== id);
  saveMemory();
  return { ok: true };
});
ipcMain.handle('dashboard:clear-memory', () => {
  petMemory = [];
  saveMemory();
  return { ok: true };
});
ipcMain.handle('dashboard:add-memory', async (_e, { category, importance, text } = {}) => {
  const cleanText = String(text ?? '').trim().slice(0, 300);
  if (!cleanText) return { ok: false, error: '内容不能为空' };
  const cat = MEMORY_CATEGORIES.has(category) ? category : '其他';
  const imp = Math.min(3, Math.max(1, Number(importance) || 1));
  const now = Date.now();
  const embedding = await embedText(cleanText);
  petMemory.push({ id: `${now}-${Math.random().toString(36).slice(2, 8)}`, text: cleanText, category: cat, importance: imp, ts: now, groupId: now, embedding, source: 'manual', uncertain: false });
  saveMemory();
  return { ok: true };
});
ipcMain.handle('dashboard:edit-memory', async (_e, { id, category, importance, text } = {}) => {
  const idx = petMemory.findIndex((m) => m.id === id);
  if (idx === -1) return { ok: false, error: '没找到这条记忆' };
  const m = petMemory[idx];
  const cleanText = String(text ?? m.text).trim().slice(0, 300);
  if (!cleanText) return { ok: false, error: '内容不能为空' };
  const cat = MEMORY_CATEGORIES.has(category) ? category : m.category;
  const imp = Math.min(3, Math.max(1, Number(importance) || m.importance || 1));
  const textChanged = cleanText !== m.text;
  const changed = textChanged || cat !== m.category || imp !== m.importance;
  // Keep the pre-edit snapshot rather than silently overwriting -- this
  // matters most for a fact that was source: 'screen-observation' and
  // uncertain: true (a vision-model guess): editing it is a human
  // confirming/correcting a guess, and both the original guess and the
  // corrected version should stay visible, not just the latest one.
  const history = changed ? [...(m.history ?? []), { text: m.text, category: m.category, importance: m.importance, uncertain: !!m.uncertain, editedAt: Date.now() }] : (m.history ?? []);
  petMemory[idx] = {
    ...m,
    text: cleanText,
    category: cat,
    importance: imp,
    // A manual edit is a human verifying/correcting the fact -- it's no
    // longer just a screenshot guess regardless of how it originally got
    // extracted, even if the text itself didn't change this time.
    uncertain: false,
    embedding: textChanged ? await embedText(cleanText) : m.embedding,
    history,
  };
  saveMemory();
  return { ok: true };
});
ipcMain.handle('dashboard:models', async () => ({ models: await listOllamaModels() }));
ipcMain.handle('dashboard:report', (_e, kind) => buildReport(kind === 'week' ? 'week' : 'day'));
function getReports() {
  return loadJsonArray(reportsPath).slice().reverse();
}
function deleteReport(id) {
  const arr = loadJsonArray(reportsPath).filter((r) => r.id !== id);
  saveJsonArray(reportsPath, arr);
  return { ok: true };
}
ipcMain.handle('dashboard:get-reports', () => getReports());
ipcMain.handle('dashboard:delete-report', (_e, id) => deleteReport(id));
ipcMain.handle('pet:get-reports', () => getReports());
ipcMain.handle('pet:delete-report', (_e, id) => deleteReport(id));
ipcMain.handle('dashboard:screentip-history', (_e, day) => {
  const requested = typeof day === 'string' && day ? day : dateKey(Date.now());
  return { day: requested, entries: loadScreenTipsForDate(requested), summaries: loadScreenTipSummaries(requested) };
});
ipcMain.handle('dashboard:screentip-summary', async (_e, day) => {
  const requested = typeof day === 'string' && day ? day : dateKey(Date.now());
  try {
    const { text } = await generateDailySummary(requested);
    return { day: requested, text, summaries: loadScreenTipSummaries(requested) };
  } catch (err) {
    return { day: requested, text: `生成失败：${err.message}`, summaries: loadScreenTipSummaries(requested) };
  }
});
// Same verdict-line convention handleSupervisionResult already reacts to
// live (see above) -- re-derived here from the saved raw text rather than
// storing a separate classified field, since the full text (verdict line +
// comment) is already what's persisted and re-parsing it is cheap and
// keeps there being exactly one place that knows what counts as "摸鱼".
function classifySupervisionVerdict(text) {
  const verdict = (text || '').split('\n')[0] || '';
  if (/摸鱼|分心|slack|distract/i.test(verdict)) return 'slack';
  if (/专注|认真|focus/i.test(verdict)) return 'focus';
  return 'uncertain';
}

// Day x hour-of-day buckets of 专注/摸鱼/不确定 counts, built from
// workSupervision's saved history (only ever recorded while a pomodoro is
// actually running -- see startWorkSupervision), plus completed-pomodoro
// timestamps for the same range so the dashboard can mark which hours had
// an actual pomodoro finish, not just supervision samples.
ipcMain.handle('dashboard:focus-heatmap', (_e, { days: numDays } = {}) => {
  const n = Math.min(60, Math.max(1, Number(numDays) || 14));
  const dayKeys = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    dayKeys.push(dateKey(d.getTime()));
  }
  const cells = {};
  const totals = { focus: 0, slack: 0, uncertain: 0 };
  for (const day of dayKeys) {
    const entries = loadJsonArray(join(screenTipsDataDir, `${day}.json`));
    for (const e of entries) {
      if (e.source !== 'workSupervision') continue;
      const hour = new Date(e.ts).getHours();
      const key = `${day}-${hour}`;
      const bucket = cells[key] ?? (cells[key] = { focus: 0, slack: 0, uncertain: 0 });
      const kind = classifySupervisionVerdict(e.text);
      bucket[kind]++;
      totals[kind]++;
    }
  }
  const rangeStartTs = new Date(`${dayKeys[0]}T00:00:00`).getTime();
  const pomodoros = pomodoroSessions
    .filter((s) => s.completedAt >= rangeStartTs)
    .map((s) => ({ ts: s.completedAt, day: dateKey(s.completedAt), hour: new Date(s.completedAt).getHours() }));
  return { days: dayKeys, cells, pomodoros, totals };
});

// Per-pomodoro focus timeline -- like the heatmap above but at the
// resolution of a single ~25min session instead of an hour bucket, so the
// dashboard can draw a sleep-tracker-style segmented bar showing *when*
// during that specific pomodoro attention dropped, not just an aggregate
// ratio. Sessions saved before startedAt/durationMs were tracked (see
// stopPomodoro) fall back to assuming the current default duration ending
// at completedAt -- hasWindow tells the renderer that fallback was used, so
// it can caveat the timeline instead of presenting it as exact.
ipcMain.handle('dashboard:pomodoro-list', (_e, { limit } = {}) => {
  const n = Math.min(50, Math.max(1, Number(limit) || 20));
  const recent = pomodoroSessions.slice(-n).reverse();
  return recent.map((s) => {
    const hasWindow = typeof s.startedAt === 'number';
    const startedAt = hasWindow ? s.startedAt : s.completedAt - pomodoroDefaultMs();
    const durationMs = s.durationMs ?? pomodoroDefaultMs();
    const day = dateKey(s.completedAt);
    const startDay = dateKey(startedAt);
    const entries = startDay === day ? loadJsonArray(join(screenTipsDataDir, `${day}.json`)) : [...loadJsonArray(join(screenTipsDataDir, `${startDay}.json`)), ...loadJsonArray(join(screenTipsDataDir, `${day}.json`))];
    const samples = entries
      .filter((e) => e.source === 'workSupervision' && e.ts >= startedAt && e.ts <= s.completedAt)
      .map((e) => ({ ts: e.ts, kind: classifySupervisionVerdict(e.text) }))
      .sort((a, b) => a.ts - b.ts);
    return { completedAt: s.completedAt, startedAt, durationMs, hasWindow, samples };
  });
});

ipcMain.on('dashboard:toggle-screentips', (_e, paused) => {
  screenTipsPaused = !!paused;
});
// Manual "look right now" -- reuses the exact same ambient watcher/config
// (cropSize, model, prompt) rather than a separate one-off capture path, so
// a manual look and an ambient one behave identically. Only available when
// screenTips is enabled (that's what the watcher instance requires) --
// workSupervision has its own separate watcher/config and isn't covered by
// this button, since it only makes sense mid-pomodoro anyway.
ipcMain.handle('dashboard:trigger-screentip', async () => {
  if (!screenTipWatcher) return { ok: false, error: '屏幕提示功能未开启（先在"功能开关"页打开）' };
  try {
    const tip = await screenTipWatcher.trigger();
    if (!tip) return { ok: false, error: '这次没有识别到内容（可能被暂停了，或视觉模型没反应）' };
    return { ok: true, day: dateKey(tip.ts), ts: tip.ts };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('pet:config', () => {
  const pet = activePet();
  if (!existsSync(pet.spritesheetPath)) {
    dialog.showErrorBox('桌面宠物', `找不到图集：\n${pet.spritesheetPath}`);
    app.quit();
    return null;
  }
  return {
    scale: cfg.scale,
    fps: cfg.fps,
    headFollow: cfg.headFollow,
    tiltEnabled: cfg.tiltEnabled,
    debug: !!cfg.debug,
    companion: cfg.companion ?? { enabled: false },
    // Keep the legacy renderer key while feeding it the merged, provider-
    // neutral activity settings.  This lets existing installs continue to
    // work and enables Codex/DeepSeek/Kimi without a second UI code path.
    claudeStatus: activityCfg,
    aiActivity: activityCfg,
    screenTips: cfg.screenTips ?? { enabled: false },
    sounds: soundsPayload(),
    gestures: cfg.gestures ?? {},
    toggles: { statusBubbleEnabled, tipBubbleEnabled, randomActionsEnabled, wanderEnabled: wanderEnabled() },
    theme: { skinColor: cfg.theme?.skinColor ?? '#faf0e4' },
    pet: petPayload(pet),
  };
});

ipcMain.on('pet:interactive', (_e, hit) => {
  // While the reply box or chat panel is open, the whole window (including
  // the input/panel area above the sprite) must stay fully interactive
  // regardless of sprite-alpha hit-testing -- neither is part of the
  // sprite, so canvas hit-testing would otherwise make the window
  // click-through the instant the cursor left the small sprite canvas,
  // swallowing clicks on the panel's own buttons (confirmed: this is why
  // the chat panel's close button did nothing).
  if (win && !win.isDestroyed() && !dragging && !chatPanelOpen && !todoPanelOpen && !toolbarOpen) {
    win.setIgnoreMouseEvents(!hit, { forward: true });
  }
});

ipcMain.on('pet:fatal', (_e, msg) => {
  dialog.showErrorBox('桌面宠物', String(msg));
  app.quit();
});

ipcMain.on('pet:drag-start', () => {
  if (!win || win.isDestroyed() || chatPanelOpen || todoPanelOpen || toolbarOpen) return;
  dragging = true;
  wandering = false;
  wanderTarget = null;
  win.setIgnoreMouseEvents(false);
  const c = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  dragOffset = { x: c.x - wx, y: c.y - wy };
});

// Drop-pose threshold, DIPs. Loose enough that "close to the edge" still
// counts -- a pixel-perfect touch would feel finicky to land by hand.
const DROP_EDGE_PX = 28;

ipcMain.on('pet:drag-end', () => {
  dragging = false;
  if (!win || win.isDestroyed()) return;
  if (!activePet().hasExtendedRows) return; // this pet's sheet has no perch/lie-down art
  const [wx, wy] = win.getPosition();
  const petRect = { x: wx, y: wy, width: PET_W, height: PET_H };
  const { x, y, width, height } = screen.getDisplayNearestPoint({
    x: wx + PET_W / 2,
    y: wy + PET_H / 2,
  }).workArea;

  const screenPose = screenEdgeDropPose(petRect, { x, y, width, height }, DROP_EDGE_PX);
  if (cfg.debug) {
    console.log('[drag-end] petRect=%j workArea=%j screenPose=%j', petRect, { x, y, width, height }, screenPose);
  }
  if (screenPose) {
    win.webContents.send('pet:drag-landed', { pose: screenPose });
    return;
  }

  // Not near a screen edge -- ask Windows what other app window (if any)
  // the drop point is touching. One-shot, so a few hundred ms of latency
  // before the pose lands is fine; this only runs once per drag release.
  const scriptPath = join(root, 'tools', 'find-drop-window.ps1');
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-PetLeft',
      String(Math.round(petRect.x)),
      '-PetTop',
      String(Math.round(petRect.y)),
      '-PetRight',
      String(Math.round(petRect.x + petRect.width)),
      '-PetBottom',
      String(Math.round(petRect.y + petRect.height)),
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.on('close', () => {
    if (cfg.debug) console.log('[drop-window]', out.trim());
    if (dragging || !win || win.isDestroyed()) return; // dragged again before this resolved
    let result;
    try {
      result = JSON.parse(out);
    } catch {
      return;
    }
    if (!result?.found) return;
    const winRect = { x: result.L, y: result.T, width: result.R - result.L, height: result.B - result.T };
    const pose = windowEdgeDropPose(petRect, winRect, DROP_EDGE_PX);
    if (pose) win.webContents.send('pet:drag-landed', { pose });
  });
  child.on('error', (err) => {
    if (cfg.debug) console.error('[drop-window] spawn failed:', err.message);
  });
});

function clampToDisplay(px, py) {
  const { x, y, width, height } = screen.getDisplayNearestPoint({ x: px, y: py }).workArea;
  return {
    x: Math.min(Math.max(px, x), x + width - PET_W),
    y: Math.min(Math.max(py, y), y + height - PET_H),
  };
}

// A pet with a nonzero edgePerchChance occasionally settles at a side/top
// screen edge instead of always the bottom. Returns 'bottom' (the default,
// ordinary behaviour) most of the time; only pets whose profile opts in
// (Sebastian) ever get anything else -- Ciel's is 0, so this always returns
// 'bottom' for him.
function pickEdge() {
  const chance = activePet().profile?.edgePerchChance ?? 0;
  if (chance <= 0 || Math.random() >= chance) return 'bottom';
  const weights = cfg.edgeWeights ?? { left: 0.4, right: 0.4, top: 0.2 };
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0) || 1;
  let roll = Math.random() * total;
  for (const [name, w] of entries) {
    if ((roll -= w) < 0) return name;
  }
  return 'bottom';
}

// opts.toCompanion: walk over to stand near the companion pet instead of a
// random point. The renderer decides *whether* to visit (its profile knows
// visitChance); main decides *where*, since it owns the companion rect.
ipcMain.on('pet:wander-start', (_e, opts) => {
  if (paused || !cfg.wander || dragging || chatPanelOpen || todoPanelOpen || toolbarOpen || !win || win.isDestroyed()) return;
  const [wx, wy] = win.getPosition();
  const { x, y, width, height } = screen.getDisplayNearestPoint({ x: wx, y: wy }).workArea;

  const rect = companion?.rect;
  const wantVisit = opts?.toCompanion && cfg.companion?.enabled && rect?.present;

  if (wantVisit) {
    const anchorPhys = companionAnchor(rect, cfg.companion.anchor);
    const a = screen.screenToDipPoint({
      x: Math.round(anchorPhys.x),
      y: Math.round(anchorPhys.y),
    });
    const approach = activePet().profile?.visitApproachPx ?? 90;
    const side = wx < a.x ? -1 : 1;
    wanderTarget = clampToDisplay(a.x + side * approach - PET_W / 2, a.y - PET_H * 0.6);
    wanderVisiting = true;
    wanderPerching = false;
    wanderLieDown = false;
  } else {
    const edge = pickEdge();
    const randX = () => Math.round(x + Math.random() * Math.max(1, width - PET_W));
    const randY = () => Math.round(y + Math.random() * Math.max(1, height - PET_H));
    switch (edge) {
      case 'left':
        wanderTarget = { x: Math.round(x), y: randY() };
        break;
      case 'right':
        wanderTarget = { x: Math.round(x + width - PET_W), y: randY() };
        break;
      case 'top':
        wanderTarget = { x: randX(), y: Math.round(y) };
        break;
      case 'bottom':
      default:
        wanderTarget = { x: randX(), y: cfg.dockToTaskbar ? y + height - PET_H : randY() };
        break;
    }
    wanderVisiting = false;
    wanderPerching = edge !== 'bottom';
    // Landing at the bottom via dockToTaskbar is the pet's ordinary resting
    // height, not a special occasion -- most wanders end up there, so lying
    // down every single time would read as repetitive rather than deliberate.
    // lieDownChance (0 for pets with no lie-down art) throttles it to an
    // occasional flourish instead.
    const lieDownChance = activePet().profile?.lieDownChance ?? 0;
    wanderLieDown = edge === 'bottom' && cfg.dockToTaskbar && Math.random() < lieDownChance;
  }

  wandering = true;
  win.webContents.send('pet:moving', { movingRight: wanderTarget.x >= wx });
});

// webContents.isDestroyed() still reports false after the render frame is
// gone, so track it explicitly or every tick throws.
let rendererLive = false;

function alive() {
  return rendererLive && win && !win.isDestroyed() && !win.webContents.isDestroyed();
}

// Provider-neutral AI activity. Claude supplies official command-hook events;
// Codex is observed from its local rollout stream; other clients can report
// through the loopback /activity endpoint or tools/ai-activity.cjs.
const claudeStatusPath = join(homedir(), '.claude', 'pet-status.json');
const aiSessionsDir = join(homedir(), '.ai-activity', 'sessions');
const codexSessionsRoot = join(homedir(), '.codex', 'sessions');
const readCodexActivities = createCodexActivityReader(codexSessionsRoot);
let lastAiStatusSignature = null;
let lastContextUsageSignature = null;
let lastRateLimitsSignature = null;

// Per-session task list (see ~/.claude/hooks/pet-status.cjs) -- replaces
// the old "type text, hope it lands in Claude's window" reply feature,
// which was confirmed via rigorous testing earlier this project to not
// reliably deliver text at all. Showing which tasks are actually running
// and letting you jump straight to the right window is something that
// works every time, not a heuristic that sometimes silently fails.
const petSessionsDir = join(homedir(), '.claude', 'pet-sessions');

function readSessionDirectory(dir) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  // Deliberately much more generous than claudeStatus.staleMs (used for the
  // pose display): a session sitting in "waiting for you" can easily go
  // 30+ minutes without a single new hook call, and that's exactly the case
  // where it most needs to still show up in the task list.
  const staleMs = activityCfg.taskListStaleMs ?? 1800000;
  const now = Date.now();
  const sessions = [];
  for (const f of files) {
    try {
      const data = normalizeAiActivity(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      if (!data) continue;
      if (now - data.ts > staleMs) continue; // stale -- hook stopped writing, session likely dead
      sessions.push(data);
    } catch {
      /* half-written file raced a read -- skip, next poll picks it up */
    }
  }
  return sessions;
}

function readActiveSessions() {
  const sessions = [...readSessionDirectory(petSessionsDir), ...readSessionDirectory(aiSessionsDir)];
  try {
    sessions.push(...readCodexActivities());
  } catch (err) {
    if (cfg.debug) console.error('[codex-activity] read failed:', err.message);
  }
  const byId = new Map();
  for (const session of sessions) {
    const previous = byId.get(session.sessionId);
    if (!previous || session.ts >= previous.ts) byId.set(session.sessionId, session);
  }
  const now = Date.now();
  const staleMs = activityCfg.taskListStaleMs ?? 1800000;
  return [...byId.values()].filter((session) => now - session.ts <= staleMs).sort((a, b) => b.ts - a.ts);
}

// Written by the official statusLine hook (~/.claude/hooks/pet-statusline.cjs,
// https://code.claude.com/docs/en/statusline) -- rate_limits is a documented
// field, not a private API. Account-level (5h/weekly rate limits are the
// same across every session on the same subscription, so whichever
// session's hook fired most recently just overwrites it -- they should all
// report near-identical numbers anyway). There is no alternative source for
// this specific data -- unlike per-session context usage (see
// dashboard:claude-usage below), it isn't derivable from a local transcript.
const accountRateLimitPath = join(homedir(), '.claude', 'pet-usage-account.json');

// See filterStaleRateLimits (claude-status.js) for why this filters at all --
// reuses the same staleness window the task list already applies to
// per-session files.
function readAccountRateLimits() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(accountRateLimitPath, 'utf8'));
  } catch {
    return null; // no session has reported rate limits yet, or file mid-write
  }
  return filterStaleRateLimits(raw, Date.now(), activityCfg.taskListStaleMs ?? 1800000);
}

ipcMain.handle('dashboard:claude-usage', () => {
  const accountRateLimits = readAccountRateLimits();

  // Confirmed live bug: petUsageDir (~/.claude/pet-usage/*.json) is only
  // ever written by the official statusLine hook, which doesn't fire
  // reliably in every harness -- observed going completely silent for 30+
  // hours in one real environment while the separate PreToolUse/
  // UserPromptSubmit hooks kept firing throughout, leaving this panel stuck
  // on "no session has reported data" despite heavy active use. Source from
  // the same per-session files (~/.claude/pet-sessions/*.json, written by
  // pet-status.cjs from the live transcript -- see readContextUsage there)
  // the context ring itself already relies on, which is confirmed reliable
  // in that same environment. Field names/scale are mapped to match what
  // this panel already expects (contextUsedPercent is 0-100, not 0-1).
  const sessions = readActiveSessions()
    .filter((s) => s.provider === 'claude' && Number.isFinite(s.contextPercent))
    .map((s) => ({
      sessionId: s.sessionId,
      taskTitle: s.taskTitle,
      cwd: s.cwd,
      contextUsedPercent: Math.round(s.contextPercent * 100),
      totalInputTokens: s.contextTokens,
      contextWindowSize: s.contextWindowMax,
      ts: s.ts,
    }))
    .sort((a, b) => b.ts - a.ts);
  return { sessions, accountRateLimits };
});

ipcMain.on('pet:task-list-request', () => {
  if (alive()) win.webContents.send('pet:task-list-result', { sessions: readActiveSessions() });
});

ipcMain.on('pet:task-jump', (_e, sessionId) => {
  const sessions = readActiveSessions();
  const session = sessions.find((s) => s.sessionId === sessionId);
  if (!session) return;
  // Codex's notify payload carries no PID/window info at all (cwd only) --
  // nothing to jump to yet for those entries, so skip rather than spawn
  // PowerShell with a garbage "undefined" pid chain.
  if (!session.ppid && !(Array.isArray(session.ancestorChain) && session.ancestorChain.length)) return;
  const scriptPath = join(root, 'tools', 'activate-by-pid.ps1');
  const pidChain = Array.isArray(session.ancestorChain) && session.ancestorChain.length ? session.ancestorChain : [session.ppid];
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-PidChain', pidChain.join(',')];
  const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.on('close', () => {
    if (cfg.debug) console.log('[task-jump]', out.trim());
  });
  child.on('error', (err) => {
    if (cfg.debug) console.error('[task-jump] spawn failed:', err.message);
  });
});

// "You haven't checked in Claude yet" head marker: set the instant a task
// finishes (Stop -> idle, or TaskCompleted -> celebrate) *from* an active
// status, cleared the instant a Claude window is actually the foreground
// window -- whichever way that happens (double-click-activate, alt-tab,
// clicking its taskbar icon).
//
// Persisted (unlike the runtime-only toggles elsewhere in this file) --
// confirmed live that this app gets restarted far more often than a normal
// long-running desktop pet would (development iteration), and every
// restart used to wipe `lastClaudeStatusValue` back to null right as a
// real working->idle transition happened, silently losing the exact signal
// this feature exists to catch. A completion that finished while the app
// was closed still counts as unseen once it's running again.
const statusTrackingPath = join(dataDir, 'claude-status-tracking.json');
const loadedTracking = loadJsonObject(statusTrackingPath);
let lastClaudeStatusValue = loadedTracking.lastStatus ?? null;
let unseenCompletion = !!loadedTracking.unseen;
let focusCheckTimer = null;
const FOCUS_CHECK_MS = 2000;
const DONE_STATUSES = new Set(['idle', 'celebrate']);

function saveStatusTracking() {
  saveJsonObject(statusTrackingPath, { lastStatus: lastClaudeStatusValue, unseen: unseenCompletion });
}

function sendUnseenCompletion() {
  if (alive()) win.webContents.send('pet:unseen-completion', { unseen: unseenCompletion });
}

function checkClaudeFocusOnce(onResult) {
  const scriptPath = join(root, 'tools', 'check-claude-focus.ps1');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.on('close', () => {
    try {
      onResult(JSON.parse(out.trim()));
    } catch {
      /* transient parse failure -- next poll tick tries again */
    }
  });
  child.on('error', (err) => {
    if (cfg.debug) console.error('[check-claude-focus] spawn failed:', err.message);
  });
}

function markSeen() {
  if (!unseenCompletion) return;
  unseenCompletion = false;
  if (focusCheckTimer) {
    clearInterval(focusCheckTimer);
    focusCheckTimer = null;
  }
  saveStatusTracking();
  sendUnseenCompletion();
}

function startFocusWatch() {
  if (focusCheckTimer) return;
  const tick = () => {
    if (!unseenCompletion) return;
    checkClaudeFocusOnce((res) => {
      if (res.focused) markSeen();
    });
  };
  focusCheckTimer = setInterval(tick, FOCUS_CHECK_MS);
  tick();
}

function pollAiStatus() {
  if (!activityCfg.enabled || !alive()) return;
  const activities = readActiveSessions();
  // Keep the shared Claude snapshot as a fallback for the brief interval
  // before its per-session file is written.
  let legacy = null;
  try {
    legacy = normalizeAiActivity({ provider: 'claude', ...JSON.parse(readFileSync(claudeStatusPath, 'utf8')) });
    if (legacy) activities.push(legacy);
  } catch {
    /* no Claude hook snapshot, or a write raced this read */
  }
  const data = pickPrimaryActivity(activities, { staleMs: activityCfg.staleMs ?? 120000 });
  // One entry per active session with real context data -- not a single
  // "best guess" pick -- so the pet can draw one ring per window instead of
  // trying to decide which one window's usage to show.
  const contextList = pickAllContextActivities(activities, { staleMs: activityCfg.staleMs ?? 120000 });
  const signature = JSON.stringify(data);
  if (signature !== lastAiStatusSignature) {
    lastAiStatusSignature = signature;
    win.webContents.send('pet:ai-status', data);
  }
  const contextSignature = JSON.stringify(contextList);
  if (contextSignature !== lastContextUsageSignature) {
    lastContextUsageSignature = contextSignature;
    win.webContents.send('pet:context-usage', contextList);
  }

  // Account-wide 5h/weekly rate limits -- same file (and same staleness
  // handling) the dashboard's own usage panel reads (see readAccountRateLimits
  // above, dashboard:claude-usage). Pushed to the pet window too so hovering
  // the context badge can show it directly instead of only being visible in
  // the dashboard.
  const rateLimits = readAccountRateLimits();
  const rateLimitsSignature = JSON.stringify(rateLimits);
  if (rateLimitsSignature !== lastRateLimitsSignature) {
    lastRateLimitsSignature = rateLimitsSignature;
    win.webContents.send('pet:rate-limits', rateLimits);
  }

  // A transition *into* idle/celebrate *from* an active status is a task
  // finishing -- not just SessionStart's initial idle write, and not
  // re-writing the same resting status repeatedly.
  const transitionStatus = data?.status ?? legacy?.status ?? 'idle';
  if (DONE_STATUSES.has(transitionStatus) && lastClaudeStatusValue && !DONE_STATUSES.has(lastClaudeStatusValue)) {
    unseenCompletion = true;
    sendUnseenCompletion();
    startFocusWatch();
  }
  lastClaudeStatusValue = transitionStatus;
  saveStatusTracking();
}

// The watcher reports physical pixels; the rest of Electron works in DIP.
function companionDelta(wx, wy) {
  const cfgC = cfg.companion;
  const rect = companion?.rect;
  const out =
    cfgC?.enabled && companion && rect?.present
      ? (() => {
          const anchorPhys = companionAnchor(rect, cfgC.anchor);
          const a = screen.screenToDipPoint({
            x: Math.round(anchorPhys.x),
            y: Math.round(anchorPhys.y),
          });
          return { dx: a.x - (wx + PET_W / 2), dy: a.y - (wy + PET_H * 0.28) };
        })()
      : null;

  if (cfg.debug && Date.now() - lastCompanionLog > 2000) {
    lastCompanionLog = Date.now();
    console.log('[companion] rect=%j -> delta=%j', rect ?? null, out);
  }
  return out;
}

function tickCursor() {
  if (!alive()) return;
  const c = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  win.webContents.send('pet:cursor', {
    dx: c.x - (wx + PET_W / 2),
    dy: c.y - (wy + PET_H * 0.28),
    insideX: c.x - wx,
    insideY: c.y - wy,
    companion: companionDelta(wx, wy),
  });

  if (dragging) {
    const p = clampToDisplay(c.x - dragOffset.x, c.y - dragOffset.y);
    // Face the direction actually being dragged, not whatever direction the
    // raven happened to be facing before the drag started.
    if (Math.abs(p.x - wx) > 0.5) {
      win.webContents.send('pet:moving', { movingRight: p.x >= wx });
    }
    win.setPosition(Math.round(p.x), Math.round(p.y));
    enforceSize();
  }
}

function tickMove(dt) {
  if (!wandering || dragging || paused || !alive()) return;
  const [wx, wy] = win.getPosition();
  const dx = wanderTarget.x - wx;
  const dy = wanderTarget.y - wy;
  const dist = Math.hypot(dx, dy);

  if (dist < 2) {
    wandering = false;
    wanderTarget = null;
    win.webContents.send('pet:wander-arrived', {
      visiting: wanderVisiting,
      perching: wanderPerching,
      lieDown: wanderLieDown,
    });
    wanderVisiting = false;
    wanderPerching = false;
    wanderLieDown = false;
    return;
  }

  const stepLen = Math.min(wanderSpeed() * dt, dist);
  const p = clampToDisplay(wx + (dx / dist) * stepLen, wy + (dy / dist) * stepLen);
  win.setPosition(Math.round(p.x), Math.round(p.y));
  enforceSize();
}

function applyScale(newScale) {
  if (!win || win.isDestroyed()) return;
  const oldBounds = win.getBounds();
  const newW = Math.round(ATLAS.cellW * newScale);
  const newH = Math.round(ATLAS.cellH * newScale);
  const anchored = resizedBoundsKeepingAnchor(oldBounds, newW, newH);

  PET_W = newW;
  PET_H = newH;
  const clamped = clampToDisplay(anchored.x, anchored.y);
  win.setBounds({ x: Math.round(clamped.x), y: Math.round(clamped.y), width: newW, height: newH });
  baseSize = { width: newW, height: newH };

  // This always resizes to the *plain* un-grown size, discarding any
  // active bubble growth -- without resetting the tracking state too, the
  // next bubble-space update would call petRectFromGrownBounds with a
  // side/extra computed against the *old* PET_H against these *new*
  // bounds, recovering a corrupted (too-short) rect and clipping the
  // sprite. Bubble content re-requests its space on the next render tick
  // regardless, so simply forgetting the old growth here is enough.
  if (bubbleSide !== null) {
    bubbleSide = null;
    bubbleExtra = 0;
    win.webContents.send('pet:bubble-layout', { side: null, extra: 0 });
  }

  cfg.scale = newScale;
  persistConfig();
  win.webContents.send('pet:scale', { scale: newScale });
}

function switchPet(id) {
  if (id === cfg.activePet) return;
  const pet = cfg.pets.find((p) => p.id === id);
  if (!pet) return;
  if (!existsSync(pet.spritesheetPath)) {
    dialog.showErrorBox('桌面宠物', `找不到图集：\n${pet.spritesheetPath}`);
    return;
  }
  cfg.activePet = id;
  persistConfig();
  win.webContents.send('pet:switch', petPayload(pet));
  buildTrayMenu();
}

// Shared by the tray icon and the pet's own right-click menu, so both always
// reflect the same live state (active pet, scale, pause) without drifting.
function buildFullMenuTemplate() {
  const pet = activePet();
  // Array index is the row number; a null entry (rows 9/10, the raw
  // head-turn frames -- see the "转头全套预览" item below) is skipped
  // rather than shifting every later row's index.
  const rowLabels = pet.rowLabels ?? [];
  const playItems = rowLabels
    .map((label, row) =>
      label ? { label, click: () => win?.webContents.send('pet:play-row', { row }) } : null,
    )
    .filter(Boolean);
  // Rows 9/10 only read as a real turn for a pet whose gaze mode is
  // 'frames' -- for 'lean' pets (Ciel) they're a near-static wobble and
  // previewing them full-cycle would just look broken.
  if (pet.gaze?.mode === 'frames') {
    if (playItems.length) playItems.push({ type: 'separator' });
    playItems.push({ label: '转头全套预览', click: () => win?.webContents.send('pet:play-spin') });
  }

  return [
    {
      label: '切换宠物',
      submenu: cfg.pets.map((p) => ({
        label: p.displayName,
        type: 'radio',
        checked: p.id === cfg.activePet,
        click: () => switchPet(p.id),
      })),
    },
    {
      label: '改变大小',
      submenu: (cfg.scaleSteps ?? [1]).map((s) => ({
        label: `${Math.round(s * 100)}%`,
        type: 'radio',
        checked: Math.abs(s - cfg.scale) < 0.001,
        click: () => applyScale(s),
      })),
    },
    { label: '播放动作', submenu: playItems },
    { type: 'separator' },
    {
      label: '显示 AI 状态气泡',
      type: 'checkbox',
      checked: statusBubbleEnabled,
      visible: !!activityCfg.enabled,
      click: (item) => {
        statusBubbleEnabled = item.checked;
        sendPetToggles();
      },
    },
    ...(cfg.screenTips?.enabled
      ? [
          {
            label: '显示屏幕提示气泡',
            type: 'checkbox',
            checked: tipBubbleEnabled,
            click: (item) => {
              tipBubbleEnabled = item.checked;
              sendPetToggles();
            },
          },
          {
            label: '暂停屏幕提示',
            type: 'checkbox',
            checked: screenTipsPaused,
            click: (item) => {
              screenTipsPaused = item.checked;
            },
          },
          {
            label: '分析频率',
            submenu: SCREEN_TIP_INTERVAL_CHOICES.map(({ label, ms }) => ({
              label,
              type: 'radio',
              checked: (cfg.screenTips.intervalMs ?? 90000) === ms,
              click: () => {
                // Mutate in place, not reassign -- createScreenTipWatcher
                // closed over this exact cfg.screenTips object and re-reads
                // intervalMs fresh every time it reschedules itself, so this
                // takes effect on the tip after the one currently in flight,
                // no watcher restart needed.
                cfg.screenTips.intervalMs = ms;
                persistConfig();
                buildTrayMenu();
              },
            })),
          },
        ]
      : []),
    {
      label: '随机动作（挥手/端茶等自发动画）',
      type: 'checkbox',
      checked: randomActionsEnabled,
      click: (item) => {
        randomActionsEnabled = item.checked;
        sendPetToggles();
      },
    },
    ...(cfg.chat?.enabled
      ? [
          {
            label: '跟他聊天',
            click: () => openChatPanel(),
          },
        ]
      : []),
    {
      label: '听歌点头（真实抓取系统音频）',
      type: 'checkbox',
      checked: musicNodEnabled,
      click: (item) => {
        musicNodEnabled = item.checked;
        if (musicNodEnabled) startAudioNod();
        else stopAudioNod();
        cfg.musicNod = cfg.musicNod ?? {};
        cfg.musicNod.enabled = musicNodEnabled;
        persistConfig();
      },
    },
    { type: 'separator' },
    {
      label: '待办 & 报告',
      click: () => openTodoPanel(),
    },
    {
      label: pomodoroState ? `番茄钟进行中（剩余 ${Math.ceil(pomodoroRemainingMs(pomodoroState) / 60000)} 分钟）—— 点击停止` : `开始番茄钟（${Math.round(pomodoroDefaultMs() / 60000)} 分钟）`,
      click: () => {
        if (pomodoroState) stopPomodoro(false);
        else startPomodoroTimer(pomodoroDefaultMs());
      },
    },
    { type: 'separator' },
    {
      label: '暂停闲逛',
      type: 'checkbox',
      checked: paused,
      click: (item) => {
        paused = item.checked;
        if (paused) {
          wandering = false;
          wanderTarget = null;
        }
        sendPetToggles();
      },
    },
    {
      label: '召回到光标旁',
      click: () => {
        const c = screen.getCursorScreenPoint();
        const p = clampToDisplay(c.x - PET_W / 2, c.y - PET_H);
        win.setPosition(Math.round(p.x), Math.round(p.y));
        cancelWander();
      },
    },
    ...(chatPanelOpen || todoPanelOpen || toolbarOpen
      ? [
          {
            // Always available whenever any panel is (recorded as) open --
            // see forceResetSize's own comment for what this recovers from.
            label: '恢复正常大小（面板卡住时用）',
            click: () => forceResetSize(),
          },
        ]
      : []),
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ];
}

function buildTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate(buildFullMenuTemplate()));
}

function buildTray() {
  const iconPath = join(root, 'assets', 'tray.png');
  tray = new Tray(
    existsSync(iconPath) ? iconPath : nativeImage.createEmpty(),
  );
  tray.setToolTip('桌面宠物');
  buildTrayMenu();
}

ipcMain.on('pet:context-menu', () => {
  if (!win || win.isDestroyed()) return;
  Menu.buildFromTemplate(buildFullMenuTemplate()).popup({ window: win });
});

// Double-click the pet -> bring whatever Claude window is around (Claude
// Code's own window, Claude Desktop, a claude.ai browser tab titled
// "Claude", ...) to the foreground. Read-only window discovery plus a
// single focus switch; never sends input to the target window's content.
ipcMain.on('pet:activate-claude', () => {
  const scriptPath = join(root, 'tools', 'activate-claude-window.ps1');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.on('close', () => {
    if (cfg.debug) console.log('[activate-claude]', out.trim());
    try {
      if (JSON.parse(out.trim()).ok) markSeen();
    } catch {
      /* ignore -- if activation didn't report success the focus-poll loop is still running */
    }
  });
  child.on('error', (err) => {
    if (cfg.debug) console.error('[activate-claude] spawn failed:', err.message);
  });
});

// Bubbles (Claude-status card, screen-tip aside) live in real DOM now, not
// canvas -- they need actual screen space *outside* the sprite's own small
// canvas, so the window grows on whichever side (top/bottom/left/right)
// currently has the most room, same anchor-preserving trick as everything
// else in this file. Renderer reports how much space its bubble content
// needs (0 when nothing is showing) every time that changes; this always
// re-derives the pet's true rect first (via petRectFromGrownBounds) so
// re-growing on a content-size change never compounds against an
// already-grown window.
const BUBBLE_MARGIN = 8; // gap between sprite and bubble area, DIP

ipcMain.on('pet:bubble-space', (_e, { needed } = {}) => {
  if (!win || win.isDestroyed() || dragging) return;
  const bounds = win.getBounds();
  const petRect = bubbleSide ? petRectFromGrownBounds(bounds, bubbleSide, bubbleExtra) : bounds;

  const wantsSpace = Number.isFinite(needed) && needed > 0;
  if (!wantsSpace) {
    if (bubbleSide === null) return; // already at rest, nothing to undo
    win.setBounds({ x: Math.round(petRect.x), y: Math.round(petRect.y), width: PET_W, height: PET_H });
    baseSize = { width: PET_W, height: PET_H };
    bubbleSide = null;
    bubbleExtra = 0;
    if (cfg.debug) console.log('[bubble-space] shrunk back to base size');
    win.webContents.send('pet:bubble-layout', { side: null, extra: 0 });
    return;
  }

  const extra = Math.round(needed + BUBBLE_MARGIN);
  const { x, y, width, height } = screen.getDisplayNearestPoint({ x: petRect.x, y: petRect.y }).workArea;
  const side = pickBubbleSide(petRect, { x, y, width, height }, extra);
  const grown = growBoundsForBubble(petRect, side, extra);
  win.setBounds({
    x: Math.round(grown.x),
    y: Math.round(grown.y),
    width: Math.round(grown.width),
    height: Math.round(grown.height),
  });
  baseSize = { width: Math.round(grown.width), height: Math.round(grown.height) };
  bubbleSide = side;
  bubbleExtra = extra;
  if (cfg.debug) {
    const actual = win.getBounds();
    console.log(
      '[bubble-space] side=%s extra=%d needed=%d workAreaH=%d requestedH=%d actualH=%d',
      side, extra, needed, height, Math.round(grown.height), actual.height,
    );
  }
  win.webContents.send('pet:bubble-layout', { side, extra });
});

// Real two-way chat. Lives in a persistent panel (see
// openChatPanel below) with real message history and streamed replies --
// not a one-shot input that vanishes after a single exchange, and not a
// transient bubble, both of which turned out to read as "not a real chat
// window" when that's what this started as. Same provider pattern as
// screenTips (ollama locally by default, or an openai-compatible cloud API
// as an explicit opt-in).
// Multiple named conversations, not one flat log -- so you can start fresh
// without losing an earlier thread, and browse back to it later, same as
// the reference chat panel this was modeled on.
let chatConvs = loadJsonArray(chatConvsPath);
let curConvId = chatConvs.length ? chatConvs[chatConvs.length - 1].id : null;
const CHAT_CONVS_MAX = 100; // conversations kept
const CHAT_CONTEXT_MESSAGES = 16; // most recent messages of the *current* conv sent to the model

function saveChatConvs() {
  if (chatConvs.length > CHAT_CONVS_MAX) chatConvs = chatConvs.slice(-CHAT_CONVS_MAX);
  saveJsonArray(chatConvsPath, chatConvs);
}

function curConv() {
  let c = chatConvs.find((x) => x.id === curConvId);
  if (!c) {
    c = { id: Date.now().toString(36), title: '新对话', messages: [], updatedAt: Date.now() };
    chatConvs.push(c);
    curConvId = c.id;
  }
  return c;
}

// Reuses an already-empty conversation instead of piling up empty shells
// every time you click "new" without ever sending anything.
function newConv() {
  const empty = [...chatConvs].reverse().find((x) => !x.messages.length);
  curConvId = empty ? empty.id : null;
  return curConv();
}

function convListSummary() {
  return [...chatConvs].reverse().map((c) => {
    const firstUser = c.messages.find((m) => m.role === 'user');
    const lastReply = [...c.messages].reverse().find((m) => m.role === 'assistant');
    return {
      id: c.id,
      title: (firstUser?.content || '(空对话)').slice(0, 20),
      subtitle: lastReply ? lastReply.content.slice(0, 26) : '…',
      active: c.id === curConvId,
    };
  });
}

let chatPanelOpen = false;
const CHAT_PANEL_W = 300; // fixed px, independent of pet scale -- a chat panel's
const CHAT_PANEL_H = 380; // readability shouldn't shrink just because the sprite is small

function openChatPanel() {
  if (!win || win.isDestroyed() || dragging || chatPanelOpen || todoPanelOpen || toolbarOpen) return;
  cancelWander();
  const petRect = truePetRect(win.getBounds());
  clearBubbleGrowthForPanel();
  const targetW = Math.max(PET_W, CHAT_PANEL_W);
  const targetH = PET_H + CHAT_PANEL_H;
  const grown = resizedBoundsKeepingAnchor(petRect, targetW, targetH);
  const { x, y, width, height } = screen.getDisplayNearestPoint({ x: grown.x, y: grown.y }).workArea;
  const clampedX = Math.min(Math.max(grown.x, x), x + width - targetW);
  const clampedY = Math.min(Math.max(grown.y, y), y + height - targetH);
  win.setBounds({ x: Math.round(clampedX), y: Math.round(clampedY), width: targetW, height: targetH });
  baseSize = { width: targetW, height: targetH };
  win.setIgnoreMouseEvents(false);
  win.setFocusable(true);
  win.focus();
  chatPanelOpen = true;
  if (cfg.debug) console.log('[chat-panel] opened %dx%d', targetW, targetH);
  win.webContents.send('pet:chat-panel-ready', { petW: PET_W, petH: PET_H, panelW: targetW, panelH: CHAT_PANEL_H, chatPending: chatRequestInFlight });
  win.webContents.send('pet:chat-history', { messages: curConv().messages });
}

function closeChatPanel() {
  if (!win || win.isDestroyed() || !chatPanelOpen) return;
  chatPanelOpen = false;
  win.setFocusable(false);
  const bounds = win.getBounds();
  const shrunk = resizedBoundsKeepingAnchor(bounds, PET_W, PET_H);
  win.setBounds({ x: Math.round(shrunk.x), y: Math.round(shrunk.y), width: PET_W, height: PET_H });
  baseSize = { width: PET_W, height: PET_H };
  if (cfg.debug) console.log('[chat-panel] closed');
  win.webContents.send('pet:chat-panel-closed');
}

ipcMain.on('pet:chat-panel-open', () => openChatPanel());
ipcMain.on('pet:chat-panel-close', () => closeChatPanel());

// "问问它" on a history entry -- the whole point of records/memory being
// something the pet can actually discuss, not just a read-only log. Works
// from either the pet's own history tab or the dashboard's 记录 page (both
// send the same quoted text here); switches over to the chat panel
// (closing the todo panel first since openChatPanel() refuses to open
// while it's up) and drops the quote into the input for the user to finish
// typing a question around, rather than guessing what they want to ask.
function askAboutEntry(text) {
  if (!text) return;
  if (todoPanelOpen) closeTodoPanel();
  openChatPanel();
  if (alive()) win.webContents.send('pet:chat-prefill', { text: `关于你刚才记录的这条——"${text}"，` });
}
ipcMain.on('pet:ask-about-entry', (_e, text) => askAboutEntry(text));
ipcMain.on('dashboard:ask-about-entry', (_e, text) => askAboutEntry(text));

// "截屏问它" -- captures right now (independent of screenTips.enabled,
// that flag only gates the ambient timer). Deliberately does NOT run the
// vision model here and stuff a text description into the chat prompt --
// that was the first version, and it meant the chat model was reasoning
// about a *description of a description*, with whatever the vision model
// got wrong baked in before the chat model ever saw a pixel. This just
// grabs the raw crop; pet:chat-send-with-image below sends the actual
// image straight to a vision-capable model for the real question.
ipcMain.handle('pet:capture-screenshot', async () => {
  try {
    const base64 = await captureCroppedScreenshot(cfg.screenTips ?? {});
    if (!base64) return { ok: false, error: '没能截到屏幕内容' };
    return { ok: true, imageBase64: base64 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// One real vision-model call that sees both the actual screenshot and the
// user's actual question, in the pet's own voice -- not text relayed
// through an intermediate description. Uses screenTips' model/provider
// (the vision-capable one) for just this turn rather than cfg.chat's
// text-only model, but keeps the same persona/memory system prompt and
// conversation-history plumbing as a normal chat send, so it reads as the
// same character continuing the same conversation, not a different bot.
ipcMain.on('pet:chat-send-with-image', async (_e, { text, imageBase64 } = {}) => {
  if (typeof text !== 'string' || !text.trim() || !imageBase64 || !alive()) return;
  if (chatRequestInFlight) {
    win.webContents.send('pet:chat-error', { message: '上一条还在回复中，请等它说完。' });
    return;
  }
  const visionCfg = cfg.screenTips ?? {};
  if (!visionCfg.model) {
    win.webContents.send('pet:chat-error', { message: '没配置视觉模型（设置里"模型"页的屏幕提示模型），没法看图回答。' });
    return;
  }
  chatRequestInFlight = true;
  const userText = text.slice(0, 1000);
  const conv = curConv();
  conv.messages.push({ role: 'user', content: userText, ts: Date.now() });
  if (conv.title === '新对话') conv.title = userText.slice(0, 18);
  conv.updatedAt = Date.now();
  saveChatConvs();
  const pet = activePet();
  const basePrompt = pet.chatSystemPrompt ?? cfg.chat?.systemPrompt;
  const effectiveCfg = { ...visionCfg, systemPrompt: basePrompt ? `${basePrompt}${await memoryContextBlock(userText)}` : visionCfg.systemPrompt };
  // Recent text history for continuity, then this turn WITH the image
  // attached -- only the current message carries pixels, older turns stay
  // text-only (Ollama attaches images per-message, not per-conversation).
  const context = conv.messages
    .slice(-CHAT_CONTEXT_MESSAGES, -1)
    .map(({ role, content }) => ({ role, content }));
  context.push({ role: 'user', content: userText, images: [imageBase64] });
  try {
    const full = await streamChatReply(effectiveCfg, context, (delta) => {
      if (alive()) win.webContents.send('pet:chat-delta', { text: delta });
    });
    conv.messages.push({ role: 'assistant', content: full, ts: Date.now() });
    conv.updatedAt = Date.now();
    saveChatConvs();
    if (alive()) win.webContents.send('pet:chat-message-done', { text: full });
    // Same shared history the ambient screen tips use, so this is browsable
    // from the 记录 page too -- the pet's actual reply (real analysis of
    // the real image) is what gets saved as the entry text, not a generic
    // caption, since that's the most informative thing this exchange
    // produced. source lets the history/report views tell these apart from
    // ambient/work-supervision entries.
    saveScreenTip({ ts: Date.now(), text: `[聊天问答] ${userText} → ${full}`, imageBase64, source: 'chat' });
    extractMemoryFacts(userText, full, cfg.chat ?? {});
  } catch (err) {
    if (cfg.debug) console.error('[chat-image]', err.message);
    if (alive()) win.webContents.send('pet:chat-error', { message: err.message });
  } finally {
    chatRequestInFlight = false;
  }
});

ipcMain.on('pet:chat-conv-list-request', () => {
  if (alive()) win.webContents.send('pet:chat-conv-list', { convs: convListSummary() });
});

ipcMain.on('pet:chat-conv-switch', (_e, id) => {
  if (!chatConvs.some((c) => c.id === id)) return;
  curConvId = id;
  if (alive()) win.webContents.send('pet:chat-history', { messages: curConv().messages });
});

ipcMain.on('pet:chat-conv-new', () => {
  newConv();
  if (alive()) win.webContents.send('pet:chat-history', { messages: [] });
});

ipcMain.on('pet:chat-conv-delete', (_e, id) => {
  chatConvs = chatConvs.filter((c) => c.id !== id);
  if (curConvId === id) curConvId = chatConvs.length ? chatConvs[chatConvs.length - 1].id : null;
  saveChatConvs();
  if (alive()) win.webContents.send('pet:chat-conv-list', { convs: convListSummary() });
});

// The renderer already blocks sending a second message while one is in
// flight, but that guard resets on panel close/reopen -- this is the real
// source of truth, and rejecting a genuinely-overlapping request here is
// what actually prevents two concurrent streamChatReply calls from
// interleaving their deltas onto the same conversation (confirmed live:
// three rapid sends produced replies that landed on the wrong bubble or
// never visibly resolved, since each new send silently reassigned which
// bubble was "pending").
// Cross-session factual memory -- separate from chatConvs (which is just
// the raw transcript, browsable but not "remembered" in the sense of being
// fed back into future prompts). After each reply, a small non-blocking
// follow-up model call asks "anything worth remembering here?" and appends
// whatever it finds; the next chat request prepends a compact digest of
// recent facts into the system prompt. Deliberately its own model call
// rather than trying to piggyback the main reply (which would mean parsing
// a special block out of what's shown in the chat bubble, or delaying the
// reply the user is waiting on).
let petMemory = loadJsonArray(petMemoryPath);
const MEMORY_MAX_FACTS = 200;
const MEMORY_INJECT_COUNT = 20;
// category + importance + recency + relevance -- the same four-ish axes
// the generative-agents "memory stream" retrieval scores on (Park et al.
// 2023: score = recency + importance + relevance, relevance = cosine
// similarity of embeddings). This app embeds locally via Ollama's
// nomic-embed-text (small, fast -- a few tens of ms per fact, nothing like
// the multi-second chat-model calls already made per message), so there's
// no real cost reason to skip the relevance term the way an earlier version
// of this file did.
const MEMORY_CATEGORIES = new Set(['身份', '喜好', '项目', '习惯', '事件', '其他']);
// bge-m3, not nomic-embed-text -- measured directly against this app's own
// short Chinese fact strings: nomic-embed-text compressed everything into a
// 0.59-0.88 cosine-similarity band with no reliable relatedness signal (an
// unrelated pair scored *higher* than the genuinely related one). bge-m3
// (multilingual, Chinese-strong) split the same pairs cleanly -- 0.788 for
// two facts about the same drink, 0.36-0.52 for everything unrelated.
const MEMORY_EMBED_MODEL = 'bge-m3';
const MEMORY_RECENCY_HALFLIFE_HOURS = 168; // 1 week

function memoryOllamaUrl() {
  return (cfg.chat?.ollamaUrl ?? cfg.screenTips?.ollamaUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
}

async function embedText(text) {
  if (!text) return null;
  try {
    const res = await fetch(`${memoryOllamaUrl()}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MEMORY_EMBED_MODEL, prompt: text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.embedding) ? data.embedding : null;
  } catch {
    return null; // Ollama unreachable or nomic-embed-text not pulled -- retrieval just falls back to recency+importance
  }
}

function saveMemory() {
  if (petMemory.length > MEMORY_MAX_FACTS) petMemory = petMemory.slice(-MEMORY_MAX_FACTS);
  saveJsonArray(petMemoryPath, petMemory);
}

// Deterministic, not LLM-extracted or relevance-scored -- Claude's and
// Codex's own hooks (pet-status.cjs/pet-notify.cjs) write ground-truth
// finished-task titles to claudeDailyActivityPath, tagged with `agent`. A
// full trailing window of that is always included verbatim, separate from
// the scored atomic-fact pool below, so "what did the agents actually do
// the last few days" is never subject to being outscored/dropped by the
// importance+recency+relevance ranking the way an ordinary memory fact can
// be -- it's a complete record, not a sampled one.
const AGENT_LABEL = { claude: 'Claude', codex: 'Codex' };

function recentProjectDigest(days) {
  const since = Date.now() - days * 86400000;
  const entries = loadJsonArray(claudeDailyActivityPath).filter((e) => e.ts >= since);
  if (!entries.length) return '';
  const byAgent = new Map();
  for (const e of entries) {
    const agent = e.agent ?? 'claude';
    if (!byAgent.has(agent)) byAgent.set(agent, []);
    byAgent.get(agent).push(e);
  }
  const parts = [];
  for (const [agent, list] of byAgent) {
    parts.push(`${AGENT_LABEL[agent] ?? agent} 最近 ${days} 天完成的任务（共 ${list.length} 个，确切记录）：\n${list.slice(-40).map((e) => `- ${e.taskTitle}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

// Lexical (keyword) relevance alongside the embedding-based one below --
// Convai's production NPC memory system (Mimir) combines semantic
// similarity with BM25 keyword matching precisely because an embedding's
// compressed similarity space can dilute an exact term/proper-noun match
// (e.g. a specific project name) that a keyword search would catch cleanly.
// No search-index dependency needed at this corpus size (a few hundred
// facts, max) -- plain BM25 computed fresh per query.
//
// Chinese has no whitespace word boundaries, so a real segmenter (jieba,
// etc.) would normally be needed for meaningful terms -- character bigrams
// are the standard fallback for CJK full-text search without one: two
// Chinese sentences that share a 2-character run share a real fragment of
// meaning, unlike two sentences that just happen to share individual Han
// characters. Latin/numeric runs (names, years, "Claude") still tokenize
// as whole words via the same pass.
function tokenizeForBm25(text) {
  const words = (text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens = [];
  for (const w of words) {
    if (/[一-鿿]/.test(w)) {
      if (w.length === 1) tokens.push(w);
      for (let i = 0; i < w.length - 1; i++) tokens.push(w.slice(i, i + 2));
    } else {
      tokens.push(w);
    }
  }
  return tokens;
}

function bm25Scores(query, docs, k1 = 1.5, b = 0.75) {
  const queryTokens = new Set(tokenizeForBm25(query));
  if (!queryTokens.size || !docs.length) return docs.map(() => 0);
  const docTokens = docs.map((d) => tokenizeForBm25(d));
  const avgLen = docTokens.reduce((s, t) => s + t.length, 0) / docTokens.length || 1;
  const df = new Map();
  for (const tokens of docTokens) {
    for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const N = docTokens.length;
  return docTokens.map((tokens) => {
    const len = tokens.length || 1;
    const termFreq = new Map();
    for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
    let score = 0;
    for (const qt of queryTokens) {
      const f = termFreq.get(qt) ?? 0;
      if (!f) continue;
      const n = df.get(qt) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + b * (len / avgLen)));
    }
    return score;
  });
}

async function memoryContextBlock(queryText) {
  if (!cfg.petMemory?.enabled) return '';
  const digest = recentProjectDigest(cfg.petMemory?.recentDays ?? 4);
  const digestBlock = digest ? `\n\n以下是最近几天 Claude / Codex 实际完成的任务，这是确切记录：\n${digest}` : '';
  const semanticMemory = buildSemanticMemoryGraph(petMemory).nodes;
  if (!semanticMemory.length) return digestBlock;
  const now = Date.now();
  const queryEmbedding = queryText ? await embedText(queryText) : null;
  // Raw cosine similarity from bge-m3 on these short Chinese facts sits in a
  // compressed band (measured: ~0.36-0.52 unrelated, ~0.79 for a genuinely
  // related pair -- see the MEMORY_EMBED_MODEL comment) that never reaches
  // 1.0 the way recencyScore/importanceScore can. Left as raw cosine,
  // relevance could never outweigh a merely-recent-or-important fact even
  // when it's the one thing that actually answers the current message. Rescale
  // relative to the best match *this specific query* has, so the top hit
  // always gets real pull in the ranking regardless of the model's absolute
  // similarity scale.
  const rawRelevances = queryEmbedding
    ? semanticMemory.map((m) => (m.embedding ? Math.max(0, cosineSimilarity(queryEmbedding, m.embedding)) : 0))
    : null;
  const maxRelevance = rawRelevances ? Math.max(...rawRelevances, 0.0001) : 1;
  // Same per-query rescaling as the embedding relevance above -- BM25's raw
  // scale is meaningless on its own (depends on corpus size/term rarity),
  // only relative-to-this-query ranking matters.
  const rawLexical = queryText ? bm25Scores(queryText, semanticMemory.map((m) => m.contextText || m.text)) : null;
  const maxLexical = rawLexical ? Math.max(...rawLexical, 0.0001) : 1;
  const scored = semanticMemory.map((m, i) => {
    const ageHours = (now - m.ts) / 3600000;
    const recencyScore = Math.exp(-ageHours / MEMORY_RECENCY_HALFLIFE_HOURS);
    const importanceScore = (m.importance ?? 1) / 3;
    const relevanceScore = rawRelevances ? rawRelevances[i] / maxRelevance : 0;
    const lexicalScore = rawLexical ? rawLexical[i] / maxLexical : 0;
    return { m, score: recencyScore + importanceScore + relevanceScore + lexicalScore };
  });
  scored.sort((a, b) => b.score - a.score);
  const recent = scored.slice(0, MEMORY_INJECT_COUNT).map((s) => s.m);
  // Screen-tip/work-supervision-derived facts come from a vision model
  // guessing at a cropped screenshot, not a ground-truth source like a
  // task log or something the person actually said -- marked so the chat
  // model doesn't state a guess as if it were confirmed.
  const factsBlock = `\n\n以下是你之前记住的一些关于他的事实，跟当前对话相关就自然地用上，不用刻意提起你"记得"这件事（标了"不确定"的是当时用视觉模型看屏幕截图猜的，可能不准，别当成确凿事实说出来）：\n${recent.map((m) => `- [${m.category}${m.uncertain ? '·不确定' : ''}] ${m.contextText || m.text}`).join('\n')}`;
  return `${digestBlock}${factsBlock}`;
}

// The dashboard receives the raw list for audit/editing, plus a separate
// semantic graph view. The graph folds related facts into a representative
// topic node and hides facts already summarized by a reflection. Embeddings
// stay in the main process instead of shipping megabytes of float arrays to
// the renderer on every refresh.
function withoutMemoryEmbedding(memory) {
  if (!memory) return memory;
  const { embedding: _embedding, clusterMembers, ...safe } = memory;
  if (clusterMembers) safe.clusterMembers = clusterMembers.map((m) => withoutMemoryEmbedding(m));
  return safe;
}

function dashboardMemoryPayload() {
  const graph = buildSemanticMemoryGraph(petMemory);
  return {
    facts: petMemory.slice().reverse().map((m) => withoutMemoryEmbedding(m)),
    graphFacts: graph.nodes.map((m) => withoutMemoryEmbedding(m)),
    edges: graph.edges,
  };
}

// Mechanical near-duplicate cleanup -- no LLM call, just cosine similarity
// within the same category. Threshold is deliberately much higher than the
// graph's "related" threshold (0.6) or the measured genuinely-related-pair
// score (~0.79) -- this only merges facts that are near-restatements of each
// other (e.g. "喝乌龙茶" and "喜欢喝乌龙波霸奶茶" both extracted from
// separate chat turns), not just topically related ones. Keeps whichever
// side of a duplicate pair has higher importance (tie-break: more recent).
// Without this, near-duplicates pile up and crowd out genuinely distinct
// facts in memoryContextBlock's fixed MEMORY_INJECT_COUNT slots.
const MEMORY_DEDUPE_SIMILARITY_THRESHOLD = 0.88;

function dedupeMemoryFacts() {
  const withEmbedding = petMemory.filter((m) => Array.isArray(m.embedding));
  const toDrop = new Set();
  for (let i = 0; i < withEmbedding.length; i++) {
    const a = withEmbedding[i];
    if (toDrop.has(a.id)) continue;
    for (let j = i + 1; j < withEmbedding.length; j++) {
      const b = withEmbedding[j];
      if (toDrop.has(b.id) || a.category !== b.category) continue;
      if (cosineSimilarity(a.embedding, b.embedding) < MEMORY_DEDUPE_SIMILARITY_THRESHOLD) continue;
      const keepA = (a.importance ?? 1) > (b.importance ?? 1) || ((a.importance ?? 1) === (b.importance ?? 1) && a.ts >= b.ts);
      toDrop.add(keepA ? b.id : a.id);
      if (!keepA) break; // a itself is now dropped -- stop comparing it against later facts
    }
  }
  if (!toDrop.size) return 0;
  petMemory = petMemory.filter((m) => !toDrop.has(m.id));
  saveMemory();
  return toDrop.size;
}

// Higher-level synthesis over accumulated related facts -- generative-
// agents' "reflection" (Park et al. 2023): periodically cluster
// not-yet-reflected facts by topic and ask the model to synthesize one
// higher-level insight per cluster ("长期在研究 X 项目的软硬件集成" instead
// of four separate scattered facts about drivers/adapters/USB ports for
// that project). Deliberately different from dedupeMemoryFacts above:
// dedup removes near-identical restatements of the *same* fact; this runs
// on topically-related-but-distinct facts and ADDS a new fact on top
// rather than deleting anything -- matching the paper's design where a
// reflection coexists with the raw observations that produced it (both
// stay retrievable), tagged with reflectsIds/reflectedInto so the
// relationship is traceable instead of silently rewriting history.
// Deliberately tighter than the graph's own "related" edge threshold
// (0.6) -- a looser value here clustered nearly everything into one giant
// group in practice (confirmed live: 32 of ~33 facts merged into a single
// broad "does robotics and AI stuff" insight instead of a few pointed
// ones), which defeats the point of reflection producing several specific
// higher-level insights rather than one all-encompassing summary.
const REFLECTION_CLUSTER_SIMILARITY = 0.68;
const REFLECTION_MIN_CLUSTER_SIZE = 3;
// Importance here is capped at 3 per fact (see dashboard-renderer.js edit
// form), unlike Park et al.'s wider 1-10 scale -- 12 (their ratio applied
// naively) turned out to be unreachable in practice: live data with real
// clusters of size 3-4 topped out at an importance sum of 10, so nothing
// ever reflected. Lowered to a threshold actually reachable at this scale.
const REFLECTION_IMPORTANCE_SUM_TRIGGER = 8;

function findUnreflectedClusters() {
  const candidates = petMemory.filter((m) => m.source !== 'reflection' && !m.reflectedInto && Array.isArray(m.embedding));
  const adj = new Map(candidates.map((m) => [m.id, []]));
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (cosineSimilarity(candidates[i].embedding, candidates[j].embedding) < REFLECTION_CLUSTER_SIMILARITY) continue;
      adj.get(candidates[i].id).push(candidates[j].id);
      adj.get(candidates[j].id).push(candidates[i].id);
    }
  }
  const byId = new Map(candidates.map((m) => [m.id, m]));
  const seen = new Set();
  const clusters = [];
  for (const m of candidates) {
    if (seen.has(m.id)) continue;
    const stack = [m.id];
    const cluster = [];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      cluster.push(byId.get(id));
      for (const nb of adj.get(id)) if (!seen.has(nb)) stack.push(nb);
    }
    if (cluster.length >= REFLECTION_MIN_CLUSTER_SIZE) clusters.push(cluster);
  }
  return clusters;
}

async function reflectOnMemoryClusters() {
  if (!cfg.petMemory?.enabled) return 0;
  const chatCfg = cfg.chat ?? {};
  if (!chatCfg.enabled) return 0;
  const clusters = findUnreflectedClusters();
  let added = 0;
  for (const cluster of clusters) {
    const importanceSum = cluster.reduce((s, m) => s + (m.importance ?? 1), 0);
    if (importanceSum < REFLECTION_IMPORTANCE_SUM_TRIGGER) continue;
    const prompt =
      `以下是几条互相相关的、关于这个人的零散事实：\n${cluster.map((m) => `- ${m.text}`).join('\n')}\n\n` +
      '请用一句话（不超过 40 字）概括这几条事实共同反映出的更高层次的情况或规律——比如共同指向的项目、长期在做的事、反复出现的偏好，不是简单复述某一条，要提炼出规律或结论。只输出这一句话，不加任何其他内容；如果这几条其实凑不出什么规律，只回复 NONE。';
    try {
      const full = await streamChatReply(
        {
          ...chatCfg,
          timeoutMs: Math.max(chatCfg.timeoutMs ?? 90000, 240000),
          systemPrompt: '你是一个信息提炼助手，只输出要求的一句话，不寒暄、不加任何多余的话。',
        },
        [{ role: 'user', content: prompt }],
        () => {},
      );
      const insight = full.trim();
      if (!insight || /^none$/i.test(insight)) continue;
      const now = Date.now();
      const embedding = await embedText(insight);
      const maxImportance = Math.max(...cluster.map((m) => m.importance ?? 1));
      const allUncertain = cluster.every((m) => m.uncertain);
      const categoryVotes = new Map();
      for (const m of cluster) categoryVotes.set(m.category, (categoryVotes.get(m.category) ?? 0) + 1);
      const category = [...categoryVotes.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const reflectionId = `${now}-${Math.random().toString(36).slice(2, 8)}`;
      petMemory.push({
        id: reflectionId,
        text: insight,
        category,
        importance: Math.min(3, maxImportance),
        ts: now,
        groupId: now,
        embedding,
        source: 'reflection',
        uncertain: allUncertain,
        reflectsIds: cluster.map((m) => m.id),
      });
      for (const m of cluster) {
        const idx = petMemory.findIndex((x) => x.id === m.id);
        if (idx !== -1) petMemory[idx] = { ...petMemory[idx], reflectedInto: reflectionId };
      }
      added++;
    } catch (err) {
      if (cfg.debug) console.error('[memory-reflection] failed:', err.message);
    }
  }
  if (added) saveMemory();
  return added;
}

// One-time backfill for facts saved before the embedding layer (and the
// source field) existed -- fire-and-forget, doesn't block boot, and
// embedText/saveMemory are silently no-op-safe if Ollama isn't reachable
// yet. Legacy facts predate any source other than chat, so that's the
// correct default rather than leaving them unlabeled.
(async () => {
  let changed = false;
  for (const m of petMemory) {
    if (!m.source) {
      m.source = 'chat';
      changed = true;
    }
    if (m.embedding) continue;
    m.embedding = await embedText(m.text);
    if (m.embedding) changed = true;
  }
  if (changed) saveMemory();
})();

// Shared by both extraction paths below -- parses "分类|重要性|内容" lines
// out of a model reply and stores each as a memory fact, tagged with which
// pipeline produced it (source) so the dashboard can show *where* a memory
// actually came from instead of leaving every fact looking the same.
async function parseAndStoreMemoryFacts(rawText, source, uncertain = false) {
  const trimmed = (rawText ?? '').trim();
  if (!trimmed || /^none$/i.test(trimmed)) return 0;
  const now = Date.now();
  let added = 0;
  for (const rawLine of trimmed.split('\n')) {
    if (added >= 5) break;
    const line = rawLine.replace(/^[-*\d.\s]+/, '').trim();
    if (!line) continue;
    const parts = line.split('|').map((p) => p.trim());
    let category = '其他';
    let importance = 1;
    let text = line;
    if (parts.length >= 3 && MEMORY_CATEGORIES.has(parts[0])) {
      category = parts[0];
      importance = Math.min(3, Math.max(1, parseInt(parts[1], 10) || 1));
      text = parts.slice(2).join('|').trim();
    }
    if (!text) continue;
    // groupId still ties every fact pulled from the same batch together --
    // kept for the "said/observed these N things at once" detail in the
    // graph view -- but the graph's drawn edges come from embedding
    // similarity (computeMemoryEdges), not group membership.
    const embedding = await embedText(text);
    petMemory.push({ id: `${now}-${Math.random().toString(36).slice(2, 8)}`, text, category, importance, ts: now, groupId: now, embedding, source, uncertain });
    added++;
  }
  if (added) saveMemory();
  return added;
}

async function extractMemoryFacts(userText, assistantText, chatCfg) {
  if (!cfg.petMemory?.enabled) return;
  try {
    const prompt =
      `以下是一段对话：\n用户：${userText}\n你：${assistantText}\n\n` +
      '如果这段对话里有值得长期记住的、关于这个人的具体事实（比如名字、身份、正在做的项目、喜好、习惯），按下面的格式输出，每条一行：\n' +
      '分类|重要性|内容\n' +
      '分类只能是「身份」「喜好」「项目」「习惯」「事件」「其他」之一；重要性是 1~3 的整数（3 = 很重要很长期，比如名字/职业；1 = 一般，比如某次随口提到的小事）；内容简短具体，用中文。\n' +
      '如果没有任何新的值得记的事实，只回复 NONE。不要记录太笼统或已经很显然的内容。';
    const full = await streamChatReply(
      { ...chatCfg, systemPrompt: '你是一个信息提取助手，只输出要求的格式，不寒暄、不加任何多余的话。' },
      [{ role: 'user', content: prompt }],
      () => {},
    );
    await parseAndStoreMemoryFacts(full, 'chat');
  } catch (err) {
    if (cfg.debug) console.error('[memory] extraction failed:', err.message);
  }
}

// Memory used to only ever come from things explicitly said in chat -- it
// had nothing to do with the Claude/Codex task log or the screen-tip/
// work-supervision observations this app already collects, even though
// both are richer signal about what the person actually does than a handful
// of chat messages. This mines that existing data on the same cadence as
// the daily-summary timer (see startDailySummaryTimer). activityMemoryStatePath
// tracks the last processed timestamp so repeated app restarts don't
// re-extract (and duplicate) the same window of activity.
//
// Deliberately TWO separate extraction passes, not one blended prompt:
// task-log entries (Claude/Codex hooks writing their own completed-task
// titles) are ground truth, while screen-tip/work-supervision entries are a
// vision model's best guess at a cropped screenshot -- meaningfully less
// reliable. Keeping them separate means each fact can be tagged with the
// confidence its actual source deserves (source: 'activity'/uncertain:false
// vs source: 'screen-observation'/uncertain:true) instead of one pass
// silently laundering a vision-model guess into something that reads as
// confirmed.
const activityMemoryStatePath = join(dataDir, 'activity-memory-state.json');

const ACTIVITY_EXTRACT_SYSTEM_PROMPT = '你是一个信息提取助手，只输出要求的格式，不寒暄、不加任何多余的话。';
const ACTIVITY_EXTRACT_FORMAT_RULES =
  '如果这里面有值得长期记住的、关于这个人的具体事实（比如正在做的项目、常用的技术/工具、工作习惯、作息规律），按下面的格式输出，每条一行：\n' +
  '分类|重要性|内容\n' +
  '分类只能是「身份」「喜好」「项目」「习惯」「事件」「其他」之一；重要性是 1~3 的整数；内容简短具体，用中文。\n' +
  '如果没有任何新的值得记的事实，只回复 NONE。不要逐条复述任务标题/原文，只提炼真正稳定、值得长期记住的模式。';

async function extractActivityMemoryFacts() {
  if (!cfg.petMemory?.enabled) return;
  const chatCfg = cfg.chat ?? {};
  if (!chatCfg.enabled) return;

  const state = loadJsonObject(activityMemoryStatePath);
  const now = Date.now();
  const since = state.lastTs || now - 86400000; // first run ever: look back one day
  const taskEntries = loadJsonArray(claudeDailyActivityPath).filter((e) => e.ts > since && e.ts <= now);
  const today = dateKey(now);
  const screenEntries = loadJsonArray(join(screenTipsDataDir, `${today}.json`)).filter(
    (e) => e.ts > since && e.ts <= now && (e.source === 'workSupervision' || e.source === 'screenTip'),
  );

  if (taskEntries.length) {
    const byAgent = new Map();
    for (const e of taskEntries) {
      const agent = e.agent ?? 'claude';
      if (!byAgent.has(agent)) byAgent.set(agent, []);
      byAgent.get(agent).push(e);
    }
    const section = [...byAgent.entries()]
      .map(([agent, list]) => `${AGENT_LABEL[agent] ?? agent} 完成的任务：\n${list.slice(-30).map((e) => `- ${e.taskTitle}`).join('\n')}`)
      .join('\n\n');
    const prompt =
      `以下是这个人最近实际完成的任务（Claude/Codex 的确切记录，不是猜测）：\n\n${section}\n\n${ACTIVITY_EXTRACT_FORMAT_RULES}`;
    try {
      const full = await streamChatReply(
        { ...chatCfg, systemPrompt: ACTIVITY_EXTRACT_SYSTEM_PROMPT },
        [{ role: 'user', content: prompt }],
        () => {},
      );
      await parseAndStoreMemoryFacts(full, 'activity', false);
    } catch (err) {
      if (cfg.debug) console.error('[memory-activity] task-log extraction failed:', err.message);
    }
  }

  if (screenEntries.length) {
    const sampledScreen = sampleEntriesAcrossDay(screenEntries, 20);
    const prompt =
      `以下是这个人最近屏幕上出现过的内容片段（视觉模型看截图写的描述，可能有误读，不是确凿事实）：\n\n${sampledScreen.map((e) => `- ${e.text}`).join('\n')}\n\n${ACTIVITY_EXTRACT_FORMAT_RULES}`;
    try {
      const full = await streamChatReply(
        { ...chatCfg, systemPrompt: ACTIVITY_EXTRACT_SYSTEM_PROMPT },
        [{ role: 'user', content: prompt }],
        () => {},
      );
      await parseAndStoreMemoryFacts(full, 'screen-observation', true);
    } catch (err) {
      if (cfg.debug) console.error('[memory-activity] screen-observation extraction failed:', err.message);
    }
  }

  saveJsonObject(activityMemoryStatePath, { lastTs: now });
}

let chatRequestInFlight = false;

ipcMain.on('pet:chat-send', async (_e, text) => {
  if (typeof text !== 'string' || !text.trim() || !alive()) return;
  if (chatRequestInFlight) {
    win.webContents.send('pet:chat-error', { message: '上一条还在回复中，请等它说完。' });
    return;
  }
  const chatCfg = cfg.chat ?? {};
  if (!chatCfg.enabled) {
    win.webContents.send('pet:chat-error', { message: '聊天功能未开启（config.json 里 chat.enabled）。' });
    return;
  }
  chatRequestInFlight = true;
  const userText = text.slice(0, 1000);
  const conv = curConv();
  conv.messages.push({ role: 'user', content: userText, ts: Date.now() });
  if (conv.title === '新对话') conv.title = userText.slice(0, 18);
  conv.updatedAt = Date.now();
  saveChatConvs();
  const pet = activePet();
  const basePrompt = pet.chatSystemPrompt ?? chatCfg.systemPrompt;
  const effectiveCfg = { ...chatCfg, systemPrompt: basePrompt ? `${basePrompt}${await memoryContextBlock(userText)}` : chatCfg.systemPrompt };
  const context = conv.messages.slice(-CHAT_CONTEXT_MESSAGES).map(({ role, content }) => ({ role, content }));
  try {
    const full = await streamChatReply(effectiveCfg, context, (delta) => {
      if (alive()) win.webContents.send('pet:chat-delta', { text: delta });
    });
    conv.messages.push({ role: 'assistant', content: full, ts: Date.now() });
    conv.updatedAt = Date.now();
    saveChatConvs();
    if (alive()) win.webContents.send('pet:chat-message-done', { text: full });
    // Fire-and-forget -- must not delay the reply the user is already
    // looking at, and a failed extraction shouldn't surface as a chat error.
    extractMemoryFacts(userText, full, chatCfg);
  } catch (err) {
    if (cfg.debug) console.error('[chat]', err.message);
    if (alive()) win.webContents.send('pet:chat-error', { message: err.message });
  } finally {
    chatRequestInFlight = false;
  }
});

app.whenReady().then(() => {
  createWindow();
  buildTray();


  if (cfg.companion?.enabled) {
    companion = createCompanionWatcher({
      scriptPath: join(root, 'tools', 'watch-companion.ps1'),
      intervalMs: cfg.companion.pollMs ?? 200,
      onError: (err) => console.error('[companion watcher]', err.message),
    });
  }

  if (cfg.musicNod?.enabled) {
    musicNodEnabled = true;
    startAudioNod();
  }

  if (cfg.screenTips?.enabled) startScreenTips();
  if (cfg.cameraSense?.enabled) startCameraSense();

  if (cfg.workSupervision?.enabled) startWorkSupervision();
  if (cfg.dailySummary?.enabled) startDailySummaryTimer();
  if (cfg.outlookSync?.enabled && cfg.outlookSync?.clientId) startOutlookSyncTimer();
  if (cfg.claudePermissionCards?.enabled || activityCfg.enabled) startPermissionCardServer();
  registerShortcuts();

  // Also run once shortly after boot rather than only on the (multi-hour)
  // daily-summary cadence -- activityMemoryStatePath's lastTs marker makes
  // this idempotent across restarts, so there's no duplicate-extraction
  // risk from also doing it here.
  setTimeout(() => {
    extractActivityMemoryFacts()
      .catch((err) => {
        if (cfg.debug) console.error('[memory-activity] boot run failed:', err.message);
      })
      .then(() => dedupeMemoryFacts())
      .then(() => reflectOnMemoryClusters())
      .catch((err) => {
        if (cfg.debug) console.error('[memory-reflection] boot run failed:', err.message);
      });
  }, 30000);

  setInterval(tickCursor, 1000 / CURSOR_HZ);
  setInterval(pollAiStatus, 750);
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    tickMove((now - last) / 1000);
    last = now;
  }, 16);

  screen.on('display-removed', () => {
    if (!win || win.isDestroyed()) return;
    const [wx, wy] = win.getPosition();
    const p = clampToDisplay(wx, wy);
    win.setPosition(Math.round(p.x), Math.round(p.y));
    wandering = false;
    wanderTarget = null;
  });
});

app.on('before-quit', () => {
  companion?.stop();
  screenTipWatcher?.stop();
  cameraSenseWatcher?.stop();
  workSupervisionWatcher?.stop();
  stopDailySummaryTimer();
  stopAudioNod();
  if (focusCheckTimer) clearInterval(focusCheckTimer);
  permissionServer?.close();
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
