import { ATLAS, BASE_ROWS, ROWS, ROW_FRAME_COUNTS, HEAD_FRAME_COUNT, frameRect, headFrameRect } from './atlas.js';
import { createGaze } from './head.js';
import { STATES, createBrain, allowsHeadFollow } from './brain.js';
import { createGreeter } from './companion.js';
import { aiActivityOverrideRow } from './claude-status.js';
import { isWithinSleepWindow, sleepRowFor } from './sleep.js';
import { pomodoroRemainingMs } from './pomodoro.js';
import { isOverdue, parseTodoInput } from './todos.js';
import { CLAUDE_SUN_RAY_COUNT, contextSunMotion } from './context-sun.js';

const CROSSFADE_MS = 140;
const TRANSFORM_MS = 420;
const PIVOT_Y = 0.92;

import { speak } from './voice-tts.js';

const cfg = await window.pet.getConfig();
if (!cfg) throw new Error('config unavailable');

const canvas = document.getElementById('stage');
const g = canvas.getContext('2d', { willReadFrequently: true });
const bubbleAreaEl = document.getElementById('bubbleArea');
const chatPanelEl = document.getElementById('chatPanel');
const chatMessagesEl = document.getElementById('chatMessages');
const chatPanelInputEl = document.getElementById('chatPanelInput');
const chatPanelSendEl = document.getElementById('chatPanelSend');
const chatPanelScreenshotEl = document.getElementById('chatPanelScreenshot');
const chatScreenshotChipEl = document.getElementById('chatScreenshotChip');
const chatScreenshotChipClearEl = document.getElementById('chatScreenshotChipClear');
const chatPanelCloseEl = document.getElementById('chatPanelClose');
const chatPanelHistEl = document.getElementById('chatPanelHist');
const chatPanelNewEl = document.getElementById('chatPanelNew');
const chatConvListEl = document.getElementById('chatConvList');
const chatInputRowEl = document.getElementById('chatInputRow');
const todoPanelEl = document.getElementById('todoPanel');
const todoPanelCloseEl = document.getElementById('todoPanelClose');
const todoTabTodoEl = document.getElementById('todoTabTodo');
const todoTabTasksEl = document.getElementById('todoTabTasks');
const todoTabReportEl = document.getElementById('todoTabReport');
const todoAddInputEl = document.getElementById('todoAddInput');
const todoAddBtnEl = document.getElementById('todoAddBtn');
const todoListEl = document.getElementById('todoList');
const tasksListEl = document.getElementById('tasksList');
const reportBodyEl = document.getElementById('reportBody');
const reportDayBtnEl = document.getElementById('reportDayBtn');
const reportWeekBtnEl = document.getElementById('reportWeekBtn');
const reportTextEl = document.getElementById('reportText');
const todoTabHistoryEl = document.getElementById('todoTabHistory');
const historyBodyEl = document.getElementById('historyBody');
const historyPrevBtnEl = document.getElementById('historyPrevBtn');
const historyNextBtnEl = document.getElementById('historyNextBtn');
const historyDateLabelEl = document.getElementById('historyDateLabel');
const historySummaryBtnEl = document.getElementById('historySummaryBtn');
const historySummaryTextEl = document.getElementById('historySummaryText');
const historySummaryListEl = document.getElementById('historySummaryList');
const historyListEl = document.getElementById('historyList');
const historyFilterTextEl = document.getElementById('historyFilterText');
const historyFilterCountEl = document.getElementById('historyFilterCount');
const historySourceChipEls = [...document.querySelectorAll('.history-source-chip')];
const todoAddRowEl = document.getElementById('todoAddRow');
const toolbarRingEl = document.getElementById('toolbarRing');
const ringGooLayerEl = document.getElementById('ringGooLayer');
const ringIconLayerEl = document.getElementById('ringIconLayer');

// Back the canvas with real device pixels. On a 1.5x display a 192-CSS-px
// canvas would otherwise be drawn at 192 and upscaled by the compositor,
// which visibly softens the crimson linework.
const dpr = window.devicePixelRatio || 1;
let cssW = 0;
let cssH = 0;

// Base size at scale=1, tuned against Codex's reference card -- bubbles
// were previously inheriting the browser's ~16px default (no explicit
// font-size was ever set), which reads as oversized against a window this
// small. Scales with cfg.scale so a bigger pet gets a proportionally
// bigger bubble, not a fixed size that looks mismatched.
const BUBBLE_BASE_FONT_PX = 11;
function updateBubbleFontSize(scale) {
  bubbleAreaEl.style.fontSize = `${Math.max(9, Math.round(BUBBLE_BASE_FONT_PX * scale))}px`;
}

function applyScale(scale) {
  cfg.scale = scale;
  cssW = Math.round(ATLAS.cellW * scale);
  cssH = Math.round(ATLAS.cellH * scale);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  updateBubbleFontSize(scale);
}
applyScale(cfg.scale);
window.pet.onScale(({ scale }) => applyScale(scale));

// The UI "skin" tone (bubbles, ring buttons, badge cards) as a single
// dashboard-editable colour instead of the hardcoded cream/"肉色" it shipped
// with. Stored as a hex string; translated to an R,G,B triplet here because
// every CSS usage needs to keep its own alpha (see --skin-rgb in
// index.html) and rgba() can't take a hex colour plus a separate alpha.
function applySkinColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  document.documentElement.style.setProperty('--skin-rgb', `${r}, ${g}, ${b}`);
}
if (cfg.theme?.skinColor) applySkinColor(cfg.theme.skinColor);
window.pet.onSkinColor((hex) => applySkinColor(hex));

let sheet = null;
let brain = null;
let gaze = null;
let currentPet = null;

async function loadPet(pet) {
  const img = new Image();
  img.src = pet.spritesheetUrl;
  await img.decode();
  // Not every pet has grown to the full ATLAS.rows yet (only sebastian-raven
  // has rows 11-12 so far) -- accept any whole number of rows from BASE_ROWS
  // up to ATLAS.rows rather than demanding an exact height match.
  const rowCount = img.naturalHeight / ATLAS.cellH;
  const validHeight = Number.isInteger(rowCount) && rowCount >= BASE_ROWS && rowCount <= ATLAS.rows;
  if (img.naturalWidth !== ATLAS.width || !validHeight) {
    window.pet.fatal(
      `${pet.displayName} 的图集尺寸不对：宽应为 ${ATLAS.width}，高应为 ${BASE_ROWS}~${ATLAS.rows} 行（每行 ${ATLAS.cellH}px）之间的整数倍，` +
        `实际为 ${img.naturalWidth}x${img.naturalHeight}`,
    );
    return false;
  }
  sheet = img;
  currentPet = pet;
  brain = createBrain({ profile: pet.profile });
  gaze = createGaze(pet.gaze);
  return true;
}

if (!(await loadPet(cfg.pet))) throw new Error('sprite sheet rejected');

if (cfg.debug) {
  console.log(
    `[diag] dpr=${dpr} inner=${window.innerWidth}x${window.innerHeight} ` +
      `canvasAttr=${canvas.width}x${canvas.height} canvasCss=${cssW}x${cssH}`,
  );
}

let animCol = 0;
let animAcc = 0;
let movingRight = true;
let arrived = false;
let pendingVisit = false;
let pendingPerch = false;
let pendingLieDown = false;
let cursor = { dx: 0, dy: 0, insideX: -1, insideY: -1, companion: null };
const companionCfg = cfg.companion ?? { enabled: false };
const greeter = createGreeter({
  nearDist: companionCfg.bowDistance ?? 420,
  cooldownMs: companionCfg.bowCooldownMs ?? 25000,
});
let cursorMoved = false;
let userIdleMs = 0;
let look = { frame: 0, tilt: 0, lean: 0, subFrameTilt: 0, showTurnFrame: false };
let watchingCompanion = false;
let speechLine = null;
let speechUntilMs = 0;
let prevRow = 0;
let lastLookLog = 0;
let claudeStatus = null;
let lastOverrideRow = null;
let lastCelebrateTs = 0;
const claudeStatusCfg = cfg.claudeStatus ?? { enabled: false };
const screenTipsCfg = cfg.screenTips ?? { enabled: false };
let sleepCfg = cfg.sleepSchedule ?? { enabled: false };
window.pet.onSleepSettings((settings) => {
  sleepCfg = settings;
});
let statusLightsEnabled = cfg.statusLights?.enabled ?? true;
window.pet.onStatusLightsEnabled((v) => {
  statusLightsEnabled = v;
});
// Independent of statusLightsEnabled on purpose -- the attention light/todo
// badge and the context ring answer different questions ("does Claude need
// you" vs "how full is this session's context"), so someone who wants one
// but not the other shouldn't have to choose. claudeStatus is passed
// through pet:config wholesale already, so this reads real config on first
// load rather than only updating live like statusLightsEnabled above does.
let contextRingEnabled = claudeStatusCfg.contextRingEnabled ?? true;
// One entry per active AI session with real context data -- one ring gets
// drawn per entry (see drawContextRings) rather than picking a single
// "best guess" session, so each window's badge always reflects that window.
let contextUsageList = [];
window.pet.onContextRingEnabled((v) => {
  contextRingEnabled = v;
});
window.pet.onContextUsage((list) => {
  contextUsageList = Array.isArray(list) ? list : [];
});
let rateLimits = null;
window.pet.onRateLimits((limits) => {
  rateLimits = limits;
});
let statusBubbleEnabled = cfg.toggles?.statusBubbleEnabled ?? true;
let tipBubbleEnabled = cfg.toggles?.tipBubbleEnabled ?? true;
let randomActionsEnabled = cfg.toggles?.randomActionsEnabled ?? true;
let wanderEnabled = cfg.toggles?.wanderEnabled ?? true;
window.pet.onToggles((t) => {
  statusBubbleEnabled = t.statusBubbleEnabled;
  tipBubbleEnabled = t.tipBubbleEnabled;
  randomActionsEnabled = t.randomActionsEnabled;
  wanderEnabled = t.wanderEnabled;
});

// --- notification sounds ----------------------------------------------
// Default: short tones generated on the fly with the Web Audio API -- no
// external audio files to source/license, nothing to ship. Each trigger
// can optionally be overridden with a real audio file picked in the
// dashboard (cfg.sounds.<slot>File) -- falls back to the built-in tone
// whenever no file is set for that slot.
let soundsEnabled = !!cfg.sounds?.enabled;
let soundFiles = { pomodoroUrl: cfg.sounds?.pomodoroUrl ?? null, alertUrl: cfg.sounds?.alertUrl ?? null, petUrl: cfg.sounds?.petUrl ?? null };
window.pet.onSoundsEnabled((v) => {
  soundsEnabled = !!v;
});
window.pet.onSoundsFilesChanged((d) => {
  soundFiles = { pomodoroUrl: d?.pomodoroUrl ?? null, alertUrl: d?.alertUrl ?? null, petUrl: d?.petUrl ?? null };
});

let audioCtx = null;
function playTone(freq, startDelay, durationMs, type = 'sine', gainPeak = 0.15) {
  if (!soundsEnabled) return;
  try {
    audioCtx = audioCtx ?? new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const t0 = audioCtx.currentTime + startDelay;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(gainPeak, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + durationMs / 1000);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + durationMs / 1000 + 0.05);
  } catch {
    // AudioContext can throw before any user gesture has reached the page,
    // or if unsupported -- a missed sound should never break anything else.
  }
}

function playCustomSound(url) {
  try {
    const audio = new Audio(url);
    audio.volume = 0.6;
    audio.play().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function playPomodoroDoneSound() {
  if (!soundsEnabled) return;
  if (soundFiles.pomodoroUrl && playCustomSound(soundFiles.pomodoroUrl)) return;
  playTone(660, 0, 160);
  playTone(880, 0.18, 220);
}

function playStatusAlertSound() {
  if (!soundsEnabled) return;
  if (soundFiles.alertUrl && playCustomSound(soundFiles.alertUrl)) return;
  playTone(520, 0, 130);
}

function playPetSound() {
  if (!soundsEnabled) return;
  if (soundFiles.petUrl && playCustomSound(soundFiles.petUrl)) return;
  playTone(740, 0, 90, 'triangle', 0.1);
}

// A real, persistent chat panel (see openChatPanel/closeChatPanel in
// main.js) -- much bigger than the reply box, stays open across multiple
// exchanges, shows real message history. `pendingBubbleEl` is the assistant
// message currently streaming in; deltas append straight to its
// textContent rather than rebuilding the whole list on every chunk.
let chatPanelOpen = false;
let pendingBubbleEl = null;
let chatHistView = false;

function appendChatMessage(role, text) {
  const div = document.createElement('div');
  div.className = `chat-msg ${role === 'user' ? 'user' : 'pet'}`;
  div.textContent = text;
  chatMessagesEl.appendChild(div);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  return div;
}

function showChatMessagesView() {
  chatHistView = false;
  chatConvListEl.style.display = 'none';
  chatMessagesEl.style.display = 'flex';
  chatInputRowEl.style.display = 'flex';
}

function showChatHistView() {
  chatHistView = true;
  chatMessagesEl.style.display = 'none';
  chatInputRowEl.style.display = 'none';
  chatConvListEl.style.display = 'block';
  window.pet.requestChatConvList();
}

function renderConvList(convs) {
  chatConvListEl.replaceChildren();
  if (!convs?.length) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = '还没有历史对话';
    chatConvListEl.appendChild(empty);
    return;
  }
  for (const c of convs) {
    const row = document.createElement('div');
    row.className = `conv-item${c.active ? ' active' : ''}`;
    const textWrap = document.createElement('div');
    textWrap.className = 'conv-item-text';
    const title = document.createElement('div');
    title.className = 'conv-item-title';
    title.textContent = c.title;
    const sub = document.createElement('div');
    sub.className = 'conv-item-sub';
    sub.textContent = c.subtitle;
    textWrap.appendChild(title);
    textWrap.appendChild(sub);
    const del = document.createElement('button');
    del.className = 'conv-item-del';
    del.textContent = '✕';
    del.title = '删除';
    row.appendChild(textWrap);
    row.appendChild(del);
    row.addEventListener('click', () => {
      window.pet.switchChatConv(c.id);
      showChatMessagesView();
    });
    // Two-step delete (click once to arm, click again within a couple
    // seconds to actually delete) -- no accidental loss, no modal dialog.
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!del.classList.contains('armed')) {
        del.classList.add('armed');
        del.textContent = '确删?';
        setTimeout(() => {
          del.classList.remove('armed');
          del.textContent = '✕';
        }, 2600);
        return;
      }
      window.pet.deleteChatConv(c.id);
    });
    chatConvListEl.appendChild(row);
  }
}

function closeChatPanel() {
  if (!chatPanelOpen) return;
  chatPanelOpen = false;
  chatPanelEl.style.display = 'none';
  resetCanvasPosition();
  pendingBubbleEl = null;
  clearPendingScreenshot();
  window.pet.closeChatPanel();
}

window.pet.onChatPanelReady(({ petH, chatPending }) => {
  chatPanelOpen = true;
  bubbleAreaEl.style.display = 'none';
  positionCanvasCentered();
  showChatMessagesView();
  chatMessagesEl.replaceChildren();
  pendingBubbleEl = null;
  clearPendingScreenshot();
  chatPanelEl.style.top = `${petH}px`;
  chatPanelEl.style.display = 'flex';
  chatPanelInputEl.value = '';
  chatPanelInputEl.focus();
  // main.js is the source of truth for whether a request is still
  // in-flight (e.g. the panel was closed mid-reply and just reopened) --
  // blindly resetting to "not pending" here would let a new send race the
  // still-running one, the exact bug this whole guard exists to prevent.
  setChatSendPending(!!chatPending);
  if (chatPending) {
    pendingBubbleEl = appendChatMessage('pet', '…');
    pendingBubbleEl.classList.add('pending');
  }
});

window.pet.onChatPanelClosed(() => {
  chatPanelOpen = false;
  chatPanelEl.style.display = 'none';
  resetCanvasPosition();
  pendingBubbleEl = null;
});

window.pet.onChatHistory(({ messages }) => {
  chatMessagesEl.replaceChildren();
  for (const m of messages ?? []) appendChatMessage(m.role, m.content);
  pendingBubbleEl = null;
});

window.pet.onChatConvList(({ convs }) => renderConvList(convs));

// Sending a second message while the first is still streaming used to
// silently reassign pendingBubbleEl to the new placeholder, losing the
// reference to the first one -- confirmed live: three messages sent in a
// row while the model (slow, ~40-70s/reply on this hardware) was still
// working produced replies that landed on the wrong bubble or never
// visibly resolved at all. Blocking send while one is in flight prevents
// the whole class of interleaving bugs, not just this specific report.
let chatSendPending = false;

function setChatSendPending(pending) {
  chatSendPending = pending;
  chatPanelInputEl.disabled = pending;
  chatPanelSendEl.disabled = pending;
}

// Set while a screenshot has been captured (see chatPanelScreenshotEl below)
// and is waiting to go out with the *next* message -- the image itself,
// not a pre-baked text description of it, so the model that answers is
// actually looking at the pixels rather than reasoning about someone
// else's (possibly wrong) summary of them.
let pendingScreenshotBase64 = null;

function clearPendingScreenshot() {
  pendingScreenshotBase64 = null;
  chatScreenshotChipEl.style.display = 'none';
}

function sendChatPanelMessage() {
  if (chatSendPending) return;
  const text = chatPanelInputEl.value.trim();
  if (!text) return;
  chatPanelInputEl.value = '';
  appendChatMessage('user', text);
  pendingBubbleEl = appendChatMessage('pet', '…');
  pendingBubbleEl.classList.add('pending');
  setChatSendPending(true);
  if (pendingScreenshotBase64) {
    window.pet.chatSendWithImage(text, pendingScreenshotBase64);
    clearPendingScreenshot();
  } else {
    window.pet.chatSend(text);
  }
}

chatPanelSendEl.addEventListener('click', sendChatPanelMessage);
chatPanelInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendChatPanelMessage();
  } else if (e.key === 'Escape') {
    closeChatPanel();
  }
  e.stopPropagation();
});
chatPanelCloseEl.addEventListener('click', closeChatPanel);

// "截屏问他" -- captures the raw screenshot and holds it (chip shown below
// the panel confirms it's attached) until the next send, which then routes
// through chatSendWithImage: a real vision-model call on the actual
// pixels, not a text description relayed through a second model. See the
// comment on pet:chat-send-with-image in main.js for why that intermediate
// step got removed.
chatPanelScreenshotEl.addEventListener('click', async () => {
  chatPanelScreenshotEl.disabled = true;
  chatPanelScreenshotEl.textContent = '…';
  try {
    const res = await window.pet.captureScreenshot();
    if (res.ok) {
      pendingScreenshotBase64 = res.imageBase64;
      chatScreenshotChipEl.style.display = 'flex';
      chatPanelInputEl.focus();
    } else {
      appendChatMessage('pet', `（截屏失败：${res.error}）`);
    }
  } finally {
    chatPanelScreenshotEl.disabled = false;
    chatPanelScreenshotEl.textContent = '📸';
  }
});
chatScreenshotChipClearEl.addEventListener('click', clearPendingScreenshot);

window.pet.onChatPrefill(({ text }) => {
  chatPanelInputEl.value = text;
  chatPanelInputEl.focus();
});
chatPanelHistEl.addEventListener('click', () => {
  if (chatHistView) showChatMessagesView();
  else showChatHistView();
});
chatPanelNewEl.addEventListener('click', () => {
  window.pet.newChatConv();
  showChatMessagesView();
});

// A real todo/report panel -- same growable-window pattern as the chat
// panel, replacing what used to be a native right-click submenu (no
// overview, no real way to add an item without a separate reply-box mode).
let todoPanelOpen = false;

function renderTodoList(items) {
  todoListEl.replaceChildren();
  if (!items?.length) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = '暂无待办，上面添加一条吧';
    todoListEl.appendChild(empty);
    return;
  }
  for (const t of items) {
    todoListEl.appendChild(renderTodoViewRow(t));
  }
}

// Re-editing goes through the same "#tag @date" shorthand as adding one --
// one input syntax to learn, and it reuses parseTodoInput (already tested)
// instead of a separate tag-chip/date-picker editor that wouldn't fit this
// panel's width anyway.
function todoRawInput(t) {
  const parts = [t.text];
  for (const tag of t.tags ?? []) parts.push(`#${tag}`);
  if (t.dueAt) {
    const d = new Date(t.dueAt);
    parts.push(`@${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
  }
  return parts.join(' ');
}

function renderTodoViewRow(t) {
  const row = document.createElement('div');
  row.className = 'todo-item';
  const check = document.createElement('div');
  check.className = 'todo-item-check';
  check.title = '完成';
  check.addEventListener('click', () => window.pet.todoComplete(t.id));
  const textWrap = document.createElement('div');
  textWrap.className = 'todo-item-textwrap';
  const text = document.createElement('div');
  text.className = 'todo-item-text';
  text.textContent = t.text;
  textWrap.appendChild(text);
  if (t.tags?.length || t.dueAt) {
    const meta = document.createElement('div');
    meta.className = 'todo-item-meta';
    for (const tag of t.tags ?? []) {
      const chip = document.createElement('span');
      chip.className = 'todo-tag-chip';
      chip.textContent = `#${tag}`;
      meta.appendChild(chip);
    }
    if (t.dueAt) {
      const due = document.createElement('span');
      due.className = isOverdue(t) ? 'todo-due-chip overdue' : 'todo-due-chip';
      due.textContent = new Date(t.dueAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
      meta.appendChild(due);
    }
    textWrap.appendChild(meta);
  }
  const editBtn = document.createElement('button');
  editBtn.className = 'todo-item-edit';
  editBtn.textContent = '✎';
  editBtn.title = '编辑';
  editBtn.addEventListener('click', () => row.replaceWith(renderTodoEditRow(t)));
  const delBtn = document.createElement('button');
  delBtn.className = 'todo-item-del';
  delBtn.textContent = '×';
  delBtn.title = '删除';
  delBtn.addEventListener('click', () => window.pet.todoRemove(t.id));
  row.appendChild(check);
  row.appendChild(textWrap);
  row.appendChild(editBtn);
  row.appendChild(delBtn);
  return row;
}

function renderTodoEditRow(t) {
  const row = document.createElement('div');
  row.className = 'todo-item todo-item-editing';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = todoRawInput(t);
  input.className = 'todo-edit-input';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'todo-item-edit';
  saveBtn.textContent = '✓';
  saveBtn.title = '保存';
  saveBtn.addEventListener('click', () => {
    const parsed = parseTodoInput(input.value);
    if (!parsed.text) return;
    window.pet.todoEdit({ id: t.id, text: parsed.text, tags: parsed.tags, dueAt: parsed.dueAt });
  });
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'todo-item-del';
  cancelBtn.textContent = '×';
  cancelBtn.title = '取消';
  cancelBtn.addEventListener('click', () => row.replaceWith(renderTodoViewRow(t)));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBtn.click();
    if (e.key === 'Escape') cancelBtn.click();
  });
  row.appendChild(input);
  row.appendChild(saveBtn);
  row.appendChild(cancelBtn);
  return row;
}

// Real Claude tasks currently working, click to jump to that window --
// replaces the old "type text, hope it lands in Claude's window" reply
// feature (confirmed via rigorous testing earlier in this project to not
// reliably deliver text at all). This works every time it has anything to
// show, because it never depends on synthetic input landing correctly.
const TASK_AGENT_LABEL = { claude: 'Claude', codex: 'Codex' };

function renderTaskList(sessions) {
  tasksListEl.replaceChildren();
  if (!sessions?.length) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = '目前没有正在跑的任务';
    tasksListEl.appendChild(empty);
    return;
  }
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'task-item';
    const title = document.createElement('div');
    title.className = 'task-item-title';
    title.textContent = `[${TASK_AGENT_LABEL[s.agent] ?? 'Claude'}] ${s.taskTitle || '（未命名任务）'}`;
    const detail = document.createElement('div');
    detail.className = 'task-item-detail';
    detail.textContent = s.detail || '';
    row.appendChild(title);
    row.appendChild(detail);
    row.addEventListener('click', () => window.pet.taskJump(s.sessionId));
    tasksListEl.appendChild(row);
  }
}

function hideAllTodoPanelTabs() {
  todoTabTodoEl.classList.remove('active');
  todoTabTasksEl.classList.remove('active');
  todoTabReportEl.classList.remove('active');
  todoTabHistoryEl.classList.remove('active');
  todoAddRowEl.style.display = 'none';
  todoListEl.style.display = 'none';
  tasksListEl.style.display = 'none';
  reportBodyEl.style.display = 'none';
  historyBodyEl.style.display = 'none';
}

function showTodoTab() {
  hideAllTodoPanelTabs();
  todoTabTodoEl.classList.add('active');
  todoAddRowEl.style.display = 'flex';
  todoListEl.style.display = 'block';
}

function showTasksTab() {
  hideAllTodoPanelTabs();
  todoTabTasksEl.classList.add('active');
  tasksListEl.style.display = 'block';
  window.pet.requestTaskList();
}

function showReportTab() {
  hideAllTodoPanelTabs();
  todoTabReportEl.classList.add('active');
  reportBodyEl.style.display = 'flex';
  reportBodyEl.style.flexDirection = 'column';
  loadPastReports();
}

const reportPastListEl = document.getElementById('reportPastList');
const REPORT_KIND_LABEL = { day: '今日报告', week: '本周报告' };

function renderPastReports(reports) {
  reportPastListEl.replaceChildren();
  if (!reports?.length) return;
  for (const r of reports) {
    const item = document.createElement('div');
    item.className = 'summary-item';
    const time = document.createElement('div');
    time.className = 'summary-item-time';
    time.textContent = `${REPORT_KIND_LABEL[r.kind] ?? r.kind} · ${new Date(r.ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}`;
    const text = document.createElement('div');
    text.className = 'summary-item-text';
    text.textContent = r.text;
    item.appendChild(time);
    item.appendChild(text);
    reportPastListEl.appendChild(item);
  }
}

async function loadPastReports() {
  renderPastReports(await window.pet.getReports());
}

// Screen-tip history -- browsable by date, replacing "the AI aside just
// vanishes after displayMs with no way to ever see it again" with a real
// record you can look back through, plus an on-demand AI daily summary.
function dateToKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
let historyDateKey = dateToKey(new Date());
let historyRawEntries = [];

const HISTORY_SOURCE_SEARCH_LABEL = { screenTip: '提示 屏幕提示', workSupervision: '监督 干活监督', manual: '截屏 手动截屏', chat: '问答 聊天问答' };

function applyHistoryFilter() {
  const q = historyFilterTextEl.value.trim().toLowerCase();
  const activeSources = new Set(historySourceChipEls.filter((el) => el.classList.contains('active')).map((el) => el.dataset.source));
  const filtered = historyRawEntries.filter((e) => {
    if (!activeSources.has(e.source ?? 'screenTip')) return false;
    // Also matches the source's own label ("监督"/"干活监督") -- typing the
    // category name into search is a reasonable thing to expect to work,
    // even though the checkboxes/chips are the more precise way to filter
    // by source.
    if (q) {
      const label = (HISTORY_SOURCE_SEARCH_LABEL[e.source] ?? '提示 屏幕提示').toLowerCase();
      if (!e.text.toLowerCase().includes(q) && !label.includes(q)) return false;
    }
    return true;
  });
  renderHistoryList(filtered);
  historyFilterCountEl.textContent = filtered.length === historyRawEntries.length ? `共 ${historyRawEntries.length} 条` : `${filtered.length} / ${historyRawEntries.length} 条`;
}
historyFilterTextEl.addEventListener('input', applyHistoryFilter);
for (const el of historySourceChipEls) {
  el.addEventListener('click', () => {
    el.classList.toggle('active');
    applyHistoryFilter();
  });
}

function renderHistoryDateLabel() {
  const d = keyToDate(historyDateKey);
  const todayKey = dateToKey(new Date());
  historyDateLabelEl.textContent = historyDateKey === todayKey ? `今天 ${historyDateKey}` : historyDateKey;
}

function renderHistoryList(entries) {
  historyListEl.replaceChildren();
  if (!entries?.length) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = '这天没有屏幕提示记录';
    historyListEl.appendChild(empty);
    return;
  }
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'history-item';
    if (e.imageUrl) {
      const img = document.createElement('img');
      img.src = e.imageUrl;
      row.appendChild(img);
    }
    const textWrap = document.createElement('div');
    textWrap.className = 'history-item-text';
    const time = document.createElement('div');
    time.className = 'history-item-time';
    time.textContent = new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const desc = document.createElement('div');
    desc.className = 'history-item-desc';
    desc.textContent = e.text;
    const askBtn = document.createElement('button');
    askBtn.className = 'history-item-ask';
    askBtn.textContent = '问问它';
    askBtn.addEventListener('click', () => window.pet.askAboutEntry(e.text));
    textWrap.appendChild(time);
    textWrap.appendChild(desc);
    textWrap.appendChild(askBtn);
    row.appendChild(textWrap);
    historyListEl.appendChild(row);
  }
}

// Past summaries (manual clicks + auto-summary timer both append here, see
// main.js's appendScreenTipSummary) are shown newest-first, separate from
// historySummaryTextEl which just echoes the most recent generation
// result right after a click so that feels immediate.
function renderSummaryList(summaries) {
  historySummaryListEl.replaceChildren();
  if (!summaries?.length) return;
  const sorted = [...summaries].sort((a, b) => b.ts - a.ts);
  for (const s of sorted) {
    const item = document.createElement('div');
    item.className = 'summary-item';
    const time = document.createElement('div');
    time.className = 'summary-item-time';
    time.textContent = new Date(s.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const text = document.createElement('div');
    text.className = 'summary-item-text';
    text.textContent = s.text;
    item.appendChild(time);
    item.appendChild(text);
    historySummaryListEl.appendChild(item);
  }
}

function loadHistoryForCurrentDate() {
  renderHistoryDateLabel();
  historySummaryTextEl.textContent = '';
  window.pet.requestScreenTipHistory(historyDateKey);
}

function showHistoryTab() {
  hideAllTodoPanelTabs();
  todoTabHistoryEl.classList.add('active');
  historyBodyEl.style.display = 'flex';
  loadHistoryForCurrentDate();
}

historyPrevBtnEl.addEventListener('click', () => {
  const d = keyToDate(historyDateKey);
  d.setDate(d.getDate() - 1);
  historyDateKey = dateToKey(d);
  loadHistoryForCurrentDate();
});
historyNextBtnEl.addEventListener('click', () => {
  const d = keyToDate(historyDateKey);
  d.setDate(d.getDate() + 1);
  historyDateKey = dateToKey(d);
  loadHistoryForCurrentDate();
});
historySummaryBtnEl.addEventListener('click', () => {
  historySummaryTextEl.textContent = '正在想……';
  window.pet.requestScreenTipSummary(historyDateKey);
});

window.pet.onScreentipHistoryResult(({ day, entries, summaries }) => {
  if (day !== historyDateKey) return; // a stale response from a since-changed date
  historyRawEntries = entries ?? [];
  applyHistoryFilter();
  renderSummaryList(summaries);
});

window.pet.onScreentipSummaryResult(({ day, text, summaries }) => {
  if (day !== historyDateKey) return;
  historySummaryTextEl.textContent = text;
  renderSummaryList(summaries);
});

function closeTodoPanel() {
  if (!todoPanelOpen) return;
  todoPanelOpen = false;
  todoPanelEl.style.display = 'none';
  resetCanvasPosition();
  window.pet.closeTodoPanel();
}

window.pet.onTodoPanelReady(({ petH, initialTab }) => {
  todoPanelOpen = true;
  bubbleAreaEl.style.display = 'none';
  positionCanvasCentered();
  if (initialTab === 'tasks') showTasksTab();
  else showTodoTab();
  reportTextEl.textContent = '点上面的按钮看看今天/本周做了什么。';
  todoPanelEl.style.top = `${petH}px`;
  todoPanelEl.style.display = 'flex';
  todoAddInputEl.value = '';
  todoAddInputEl.focus();
});

window.pet.onTodoPanelClosed(() => {
  todoPanelOpen = false;
  todoPanelEl.style.display = 'none';
  resetCanvasPosition();
});

window.pet.onTodos(({ active }) => {
  activeTodoCount = active.length;
  renderTodoList(active);
});

window.pet.onTaskListResult(({ sessions }) => renderTaskList(sessions));

window.pet.onReportResult(({ text }) => {
  reportTextEl.textContent = text;
  loadPastReports();
});

function submitTodoAdd() {
  const text = todoAddInputEl.value.trim();
  if (!text) return;
  todoAddInputEl.value = '';
  window.pet.todoAdd(text);
}

todoAddBtnEl.addEventListener('click', submitTodoAdd);
todoAddInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitTodoAdd();
  } else if (e.key === 'Escape') {
    closeTodoPanel();
  }
  e.stopPropagation();
});
todoPanelCloseEl.addEventListener('click', closeTodoPanel);
todoTabTodoEl.addEventListener('click', showTodoTab);
todoTabTasksEl.addEventListener('click', showTasksTab);
todoTabReportEl.addEventListener('click', showReportTab);
todoTabHistoryEl.addEventListener('click', showHistoryTab);
reportDayBtnEl.addEventListener('click', () => window.pet.requestReport('day'));
reportWeekBtnEl.addEventListener('click', () => window.pet.requestReport('week'));

// The hover toolbar ring -- a quick-access + status-at-a-glance menu that
// replaces the old "hover opens the reply box directly" gesture (see
// reportHit below). 'action' buttons close the ring and open their target
// panel; 'toggle' buttons flip a setting and stay open so several can be
// switched in one hover session, mirroring the ring geometry math in
// growBoundsForRing (geometry.js).
let toolbarOpen = false;
let toolbarDims = { petW: 0, petH: 0, petX: 0, petY: 0, windowW: 0, windowH: 0, ringExtra: 0 };
const RING_BUTTONS = [
  { key: 'chat', icon: '💬', label: '聊天', kind: 'action' },
  { key: 'todo', icon: '📝', label: '待办', kind: 'action' },
  { key: 'tasks', icon: '📋', label: '任务', kind: 'action' },
  { key: 'pomodoro', icon: '🍅', label: '番茄钟', kind: 'toggle' },
  { key: 'musicNod', icon: '🎵', label: '听歌', kind: 'toggle' },
  { key: 'wander', icon: '🚶', label: '闲逛', kind: 'toggle' },
  { key: 'settings', icon: '⚙️', label: '设置', kind: 'action' },
];

function ringButtonActive(key, state) {
  if (key === 'pomodoro') return !!state?.pomodoroActive;
  if (key === 'musicNod') return !!state?.musicNodEnabled;
  if (key === 'wander') return !state?.wanderPaused; // "lit up" = currently allowed to wander
  return false;
}

// A fan opening upward over the pet's head, not a full 360-degree ring --
// per feedback that a ring surrounding the sprite on every side didn't read
// as the "扇形" (fan/sector) shape asked for. RING_FAN_SPAN is the total
// angle the buttons arc across; centred on straight up (-90deg) so it
// spreads evenly left/right above the sprite regardless of which side of
// the screen the pet is currently on.
const RING_FAN_SPAN = Math.PI * 0.86; // ~155 degrees
const RING_FAN_CENTER = -Math.PI / 2;

function ringButtonPositions() {
  const { petW, petH, petX, petY, ringExtra } = toolbarDims;
  const cx = petX + petW / 2;
  const cy = petY + petH / 2;
  const radius = ringExtra * 0.82;
  const n = RING_BUTTONS.length;
  const start = RING_FAN_CENTER - RING_FAN_SPAN / 2;
  return RING_BUTTONS.map((b, i) => {
    const angle = n === 1 ? RING_FAN_CENTER : start + (i / (n - 1)) * RING_FAN_SPAN;
    return { button: b, angle, x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });
}

function renderToolbarRing(state) {
  const { windowW, windowH } = toolbarDims;
  ringGooLayerEl.replaceChildren();
  ringIconLayerEl.replaceChildren();
  const buttonMargin = 28;

  // Clamp first, then build everything else off the clamped points -- the
  // goo-layer links need to connect the *actual* (possibly edge-clamped)
  // blob positions, not the unclamped trig points, or a link would visibly
  // miss the blob it's supposed to fuse with whenever the ring gets
  // clamped near a screen edge.
  const positions = ringButtonPositions().map(({ button, x, y }) => ({
    button,
    x: Math.min(windowW - buttonMargin, Math.max(buttonMargin, x)),
    y: Math.min(windowH - buttonMargin, Math.max(buttonMargin, y)),
  }));

  // Chain-link capsules between consecutive blobs, drawn into the goo
  // layer where the SVG filter (see #ringGoo) blurs-then-resharpens
  // everything in it, melting each overlapping blob/link pair into one
  // continuous connected shape -- the "linked bubbles" look asked for,
  // not separate circles joined by a visibly thinner stick.
  for (let i = 1; i < positions.length; i++) {
    const a = positions[i - 1];
    const b = positions[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const linkAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
    const link = document.createElement('div');
    link.className = 'ring-link';
    link.style.width = `${length}px`;
    link.style.left = `${(a.x + b.x) / 2}px`;
    link.style.top = `${(a.y + b.y) / 2}px`;
    link.style.transform = `translate(-50%, -50%) rotate(${linkAngle}deg)`;
    ringGooLayerEl.appendChild(link);
  }

  positions.forEach(({ button: b, x, y }) => {
    const active = ringButtonActive(b.key, state);

    const blob = document.createElement('div');
    blob.className = `ring-blob${active ? ' active' : ''}`;
    blob.style.left = `${x}px`;
    blob.style.top = `${y}px`;
    ringGooLayerEl.appendChild(blob);

    const btn = document.createElement('div');
    btn.className = `ring-btn${active ? ' active' : ''}`;
    btn.style.left = `${x}px`;
    btn.style.top = `${y}px`;
    btn.textContent = b.icon;
    const label = document.createElement('span');
    label.className = 'ring-btn-label';
    label.textContent = b.label;
    btn.appendChild(label);
    btn.addEventListener('click', () => {
      if (b.kind === 'action') window.pet.toolbarAction(b.key);
      else window.pet.toolbarToggle(b.key);
    });
    ringIconLayerEl.appendChild(btn);
  });
}

window.pet.onToolbarReady(({ petW, petH, petX, petY, windowW, windowH, ringExtra, state }) => {
  toolbarOpen = true;
  toolbarDims = { petW, petH, petX, petY, windowW, windowH, ringExtra };
  bubbleAreaEl.style.display = 'none';
  positionCanvasForRing(petX, petY);
  renderToolbarRing(state);
  toolbarRingEl.style.display = 'block';
  cancelRingHide();
});

window.pet.onToolbarState((state) => renderToolbarRing(state));

window.pet.onToolbarClosed(() => {
  toolbarOpen = false;
  toolbarRingEl.style.display = 'none';
  ringGooLayerEl.replaceChildren();
  ringIconLayerEl.replaceChildren();
  resetCanvasPosition();
  cancelRingHide();
});

// #toolbarRing is a full-window overlay (inset:0) so its own `mouseleave`
// only fires when the cursor exits the OS window rectangle entirely -- it
// never fires just from drifting away from the ring into the dead space
// still inside that rectangle, which is what actually happens in normal
// use and was leaving the ring stuck open indefinitely. Track distance from
// the ring's own centre instead and auto-close after a lingering pause.
let ringHideTimer = null;
const RING_HIDE_MS = 900;
const RING_HIDE_BUFFER = 36;
function scheduleRingHide() {
  if (ringHideTimer) return;
  ringHideTimer = setTimeout(() => {
    ringHideTimer = null;
    if (toolbarOpen) window.pet.toolbarClose();
  }, RING_HIDE_MS);
}
function cancelRingHide() {
  if (ringHideTimer) {
    clearTimeout(ringHideTimer);
    ringHideTimer = null;
  }
}
toolbarRingEl.addEventListener('mousemove', (e) => {
  if (!toolbarOpen) return;
  const { petW, petH, petX, petY, ringExtra } = toolbarDims;
  const cx = petX + petW / 2;
  const cy = petY + petH / 2;
  const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
  const radius = ringExtra * 0.82 + RING_HIDE_BUFFER;
  if (dist > radius) scheduleRingHide();
  else cancelRingHide();
});
toolbarRingEl.addEventListener('mouseleave', () => scheduleRingHide());

// Model switching and every other settings-panel control now live in the
// full dashboard window (dashboard.html/dashboard-renderer.js) instead of a
// panel grown out of the pet -- opened via the ring's ⚙️ button, see
// main.js's openDashboard(). This renderer only still cares about
// statusLightsEnabled (declared up near the other cfg-derived state, see
// onStatusLightsEnabled), since that gates the canvas HUD drawn locally.

window.pet.onChatDelta(({ text }) => {
  if (!pendingBubbleEl) pendingBubbleEl = appendChatMessage('pet', '');
  pendingBubbleEl.classList.remove('pending');
  pendingBubbleEl.textContent = (pendingBubbleEl.textContent === '…' ? '' : pendingBubbleEl.textContent) + text;
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
});

window.pet.onChatMessageDone(({ text }) => {
  if (pendingBubbleEl) {
    pendingBubbleEl.textContent = text;
    pendingBubbleEl.classList.remove('pending');
  }
  pendingBubbleEl = null;
  setChatSendPending(false);
});

window.pet.onChatError(({ message }) => {
  if (pendingBubbleEl) {
    pendingBubbleEl.textContent = `没回上来：${message}`;
    pendingBubbleEl.classList.remove('pending');
  } else {
    appendChatMessage('pet', `没回上来：${message}`);
  }
  pendingBubbleEl = null;
  setChatSendPending(false);
});

let screenTipText = null;
let screenTipUntilMs = 0;
// "堆叠显示" -- keep the last few tips visible at once (each still expiring
// on its own displayMs timer) instead of always replacing with only the
// newest one. Off by default (matches the original single-bubble
// behavior); toggled from the dashboard, see onTipDisplayMode below.
let tipDisplayStacked = !!screenTipsCfg.stackedDisplay;
let screenTipQueue = []; // stacked mode only: [{ text, untilMs }]
const STACKED_TIP_MAX = 3;
window.pet.onTipDisplayMode((stacked) => {
  tipDisplayStacked = !!stacked;
  screenTipQueue = [];
});
let chatReplyText = null;
let chatReplyUntilMs = 0;
let nodPulseStartMs = null;
const NOD_PULSE_MS = 260;
const NOD_PULSE_PX = 5;
let fade = null; // { rect, ms, totalMs, kind, particles? }
let lastT = performance.now();

window.pet.onCursor((c) => {
  cursorMoved = c.dx !== cursor.dx || c.dy !== cursor.dy;
  if (cursorMoved) userIdleMs = 0;
  cursor = c;
});

window.pet.onMoving((d) => {
  movingRight = d.movingRight;
});

window.pet.onWanderArrived((info) => {
  arrived = true;
  pendingVisit = !!info?.visiting;
  pendingPerch = !!info?.perching;
  pendingLieDown = !!info?.lieDown;
});

// The user manually dropped the pet at a screen edge or against another
// window (see screenEdgeDropPose/windowEdgeDropPose in geometry.js, decided
// main-process-side since only main knows the screen/other-window rects).
// By the time this arrives the drag has already ended and brain is IDLE
// (see the pointerup handler below), so this forces straight into the pose
// rather than going through the pendingPerch/pendingLieDown+arrived path.
window.pet.onDragLanded(({ pose }) => {
  if (pose !== 'perch' && pose !== 'lieDown') return;
  const before = currentRect();
  const restRow = pose === 'perch' ? ROWS.PERCH : ROWS.LIE_DOWN;
  brain.forceState(STATES.REST, { restRow, ignoreCursorMoved: true });
  animCol = 0;
  animAcc = 0;
  // Raven form (drag always shows the raven walk) settling onto a branch is
  // still raven -- plain crossfade. Settling into a curled-up sleep is a
  // species change, so it gets the feather-burst fx, matching the same
  // split used for the autonomous wander-arrival case above.
  if (pose === 'perch') {
    beginFade(before);
  } else {
    beginTransformFx(before);
  }
  prevRow = restRow;
});

window.pet.onAiStatus((s) => {
  const wasAlerting = claudeStatus?.status === 'waiting' || claudeStatus?.status === 'error';
  const nowAlerting = s?.status === 'waiting' || s?.status === 'error';
  if (nowAlerting && !wasAlerting) playStatusAlertSound();
  claudeStatus = s;
});

// A real permission prompt is blocking in Claude's actual terminal right
// now -- this card is a shortcut, not a replacement (see
// ~/.claude/hooks/pet-permission.cjs): the terminal prompt only appears at
// all if this never resolves in time, so clicking here vs. answering in the
// terminal can never race each other. Queued (not just overwritten) because
// more than one session can hit a permission prompt at the same time.
let permissionQueue = [];
window.pet.onPermissionRequest((req) => {
  permissionQueue.push(req);
  // reportHit()'s own permissionQueue.length check only stops the ring from
  // opening *after* this point -- if it was already mid-hover-open right
  // when the request arrived (a real, common case: you were just looking at
  // the pet), that guard never fires and the window stays at its
  // ring-grown, possibly-clamped bounds while the card renders on top of
  // it, which is exactly the stale-position click-miss this was supposed to
  // prevent. Force it closed now so the card always lands on the pet's
  // normal resting position.
  if (toolbarOpen) window.pet.toolbarClose();
  playStatusAlertSound();
});
// Main process pushes this once its own timeout gives up on a request (see
// startPermissionCardServer in main.js) -- without it, a card the user
// never got to (or clicked after the window already closed server-side)
// would sit on screen forever with no way to know it's moot. Also swept by
// expiresAt below as a belt-and-suspenders check in case this push is ever
// missed (window not focused, IPC hiccup, etc).
window.pet.onPermissionResolved((requestId) => {
  permissionQueue = permissionQueue.filter((r) => r.requestId !== requestId);
});
function resolvePermission(requestId, decision) {
  permissionQueue = permissionQueue.filter((r) => r.requestId !== requestId);
  window.pet.permissionResponse(requestId, decision);
}

window.pet.onScreenTip((tip) => {
  if (!tip?.text) return;
  const untilMs = performance.now() + (screenTipsCfg.displayMs ?? 9000);
  if (tipDisplayStacked) {
    screenTipQueue.push({ text: tip.text, untilMs });
    if (screenTipQueue.length > STACKED_TIP_MAX) screenTipQueue.shift();
  } else {
    screenTipText = tip.text;
    screenTipUntilMs = untilMs;
  }
});

// Voice STT: push-to-talk key binding. F9 by default, configurable.
// On keydown, send START to the STT helper; on keyup, send STOP.
// Recognized transcripts are routed through the exact same
// window.pet.chatSend() path as typed input.
window.addEventListener('keydown', (e) => {
  const pttKey = cfg.voice?.pushToTalkKey ?? 'F9';
  if (e.key === pttKey && cfg.voice?.enabled && !e.repeat) {
    window.pet.voicePptStart();
  }
});
window.addEventListener('keyup', (e) => {
  const pttKey = cfg.voice?.pushToTalkKey ?? 'F9';
  if (e.key === pttKey && cfg.voice?.enabled) {
    window.pet.voicePptStop();
  }
});

// Voice transcript callback: treated identically to a typed message sent
// via Enter press. Routes through window.pet.chatSend() so it hits all
// the same downstream chat logic, history, bubble display, etc.
window.pet.onVoiceTranscript((text) => {
  if (text) window.pet.chatSend(text);
});

window.pet.onVoiceCallModeState(({ active }) => {
  if (cfg.debug) console.log('[voice] call-mode', active ? 'active' : 'inactive');
});

// Camera-sense: main process asks (over IPC) for one webcam frame at a
// time; only the renderer has getUserMedia. Stream is opened just long
// enough to grab a single frame, then immediately stopped -- never left
// running between captures.
window.pet.onCameraFrameRequest(async ({ requestId }) => {
  let base64 = null;
  let error = null;
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const track = stream.getVideoTracks()[0];
    const capture = new ImageCapture(track);
    const bitmap = await capture.grabFrame();
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    base64 = canvas.toDataURL('image/png').split(',')[1];
  } catch (err) {
    error = err.message;
  } finally {
    stream?.getTracks().forEach((t) => t.stop()); // never leave the camera open
  }
  window.pet.sendCameraFrameResponse({ requestId, base64, error });
});

const CHAT_REPLY_DISPLAY_MS = 12000;
window.pet.onChatReply((msg) => {
  const text = msg?.text || msg?.error;
  if (!text) return;
  chatReplyText = text;
  chatReplyUntilMs = performance.now() + CHAT_REPLY_DISPLAY_MS;
});

// Real WASAPI-detected beat (see main.js/startAudioNod + tools/audio-nod) --
// a brief transform pulse on the canvas itself, deliberately independent of
// the sprite-row state machine (brain.js) so it layers on top of whatever
// pose is already showing instead of competing for a row.
const NOTE_CHARS = ['♪', '♫', '♬'];
const NOTE_LIFE_MS = 1300;
let noteParticles = []; // { x, y, vx, vy, char, bornMs }

window.pet.onBeat(() => {
  nodPulseStartMs = performance.now();
  noteParticles.push({
    x: canvas.width * (0.3 + Math.random() * 0.4),
    y: canvas.height * 0.18,
    // px/ms, multiplied by elapsed age (up to NOTE_LIFE_MS) when drawing --
    // the original values (~0.3-0.5) worked out to 600-1000+px of total
    // drift over the note's life, more than 5x the canvas's own height, so
    // every note shot straight off the top and out of the (clipped) canvas
    // within ~40ms -- before even finishing its fade-in. Confirmed live:
    // beats were detecting and forwarding correctly the whole time (real
    // system audio, logged), the notes were just invisible in well under
    // one frame. This scale keeps total drift to a gentle ~40-70px.
    vx: (Math.random() - 0.5) * 0.006 * dpr,
    vy: -(0.028 + Math.random() * 0.018) * dpr,
    char: NOTE_CHARS[Math.floor(Math.random() * NOTE_CHARS.length)],
    bornMs: performance.now(),
  });
  if (noteParticles.length > 12) noteParticles.shift(); // safety cap regardless of lifetime
});

window.pet.onMusicComment(({ text } = {}) => {
  if (!text) return;
  speechLine = text;
  speak(speechLine, cfg.voice);
  speechUntilMs = performance.now() + 7000;
});

// A task finished and you haven't looked at the Claude window yet (see
// main.js's pollClaudeStatus/startFocusWatch) -- a small persistent marker
// drawn directly on the canvas, not a bubble, since it needs to survive
// regardless of whether any bubble is currently showing and shouldn't need
// window growth to display.
let unseenCompletion = false;
window.pet.onUnseenCompletion(({ unseen }) => {
  unseenCompletion = unseen;
});

// Tracks how many active todos exist, purely for the status-light todo-count
// badge below -- the panel's own list (renderTodoList) already re-renders
// from the same event, this just keeps a number around for the canvas HUD.
let activeTodoCount = 0;

let pomodoroActive = false;
let pomodoroEndsAt = null;
window.pet.onPomodoroState(({ active, endsAt }) => {
  pomodoroActive = active;
  pomodoroEndsAt = endsAt ?? null;
});

window.pet.onPomodoroDone(() => {
  speechLine = '番茄钟完成，歇一会儿吧。';
  speak(speechLine, cfg.voice);
  speechUntilMs = performance.now() + 8000;
  playPomodoroDoneSound();
});

function playAnimationRow(row) {
  const before = currentRect();
  brain.forceState(STATES.PERFORM, { performRow: row });
  animCol = 0;
  animAcc = 0;
  beginFade(before);
}

window.pet.onPlayRow(({ row }) => playAnimationRow(row));

window.pet.onPlaySpin(() => {
  const before = currentRect();
  brain.forceState(STATES.SPIN);
  animCol = 0;
  animAcc = 0;
  beginFade(before);
});

window.pet.onSwitch(async (pet) => {
  const outgoing = sheet ? currentRect() : null;
  if (!(await loadPet(pet))) return;
  animCol = 0;
  animAcc = 0;
  prevRow = 0;
  look = { frame: 0, tilt: 0, lean: 0, subFrameTilt: 0, showTurnFrame: false };
  if (outgoing) beginFade(outgoing);
});

// A right-click still opens the native menu by default -- but if a second
// right-click follows within DOUBLE_RIGHT_CLICK_MS, that's read as "double
// right-click" and opens the fan toolbar ring instead. The first click's
// menu popup has to be *delayed*, not shown immediately then closed, or a
// fast second right-click would just be clicking into an already-open
// native menu instead of reaching this detector at all -- the real
// trade-off is every single right-click now waits this long before the
// menu actually appears.
const DOUBLE_RIGHT_CLICK_MS = 400;
let lastContextMenuAt = 0;
let contextMenuTimer = null;
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const now = performance.now();
  if (now - lastContextMenuAt < DOUBLE_RIGHT_CLICK_MS) {
    if (contextMenuTimer) {
      clearTimeout(contextMenuTimer);
      contextMenuTimer = null;
    }
    lastContextMenuAt = 0; // consumed -- a third rapid click starts a fresh pair, not part of this one
    window.pet.openToolbar();
    return;
  }
  lastContextMenuAt = now;
  contextMenuTimer = setTimeout(() => {
    contextMenuTimer = null;
    window.pet.contextMenu();
  }, DOUBLE_RIGHT_CLICK_MS);
});

canvas.addEventListener('dblclick', () => {
  window.pet.activateClaudeWindow();
});

function beginFade(rect) {
  fade = { rect, ms: CROSSFADE_MS, totalMs: CROSSFADE_MS, kind: 'plain' };
}

// A longer transition with scattering feathers, used only when the pose
// change crosses between the human and raven forms.
function beginTransformFx(rect) {
  const particles = [];
  const n = 10;
  for (let i = 0; i < n; i++) {
    particles.push({
      angle: (i / n) * Math.PI * 2 + Math.random() * 0.5,
      dist: 0.15 + Math.random() * 0.25,
      size: 0.05 + Math.random() * 0.05,
      spin: (Math.random() - 0.5) * 6,
      delay: Math.random() * 0.3,
    });
  }
  fade = { rect, ms: TRANSFORM_MS, totalMs: TRANSFORM_MS, kind: 'transform', particles };
}

// What Claude Code is doing right now, if anything -- only ever preempts the
// pet's own idle behaviour (see claudeOverrideRow's brainIsIdle gate), so a
// wander/drag/visit/edge-perch already in progress is never interrupted.
function currentClaudeOverrideRow() {
  return aiActivityOverrideRow(claudeStatusCfg, claudeStatus, currentPet?.claudeStatusRows, brain.state === STATES.IDLE, Date.now());
}

// Late-night scheduled sleep pose -- lower priority than the Claude-status
// override (if Claude is actively doing something, that's more actionable
// information than "it's 3am"), but otherwise takes over whenever idle,
// the same non-interrupting pattern as claudeOverrideRow: only ever
// preempts idle, never a wander/drag/visit/edge-perch already in progress.
function currentSleepOverrideRow() {
  if (brain.state !== STATES.IDLE) return null;
  if (!isWithinSleepWindow(sleepCfg, new Date())) return null;
  return sleepRowFor(currentPet, ROWS);
}

// A personal pomodoro session is a deliberate user action -- more specific
// than the ambient sleep schedule, but less informative than Claude Code
// actually doing something right now, hence its slot between the two.
// Reuses the pet's own claudeStatusRows.working pose rather than adding a
// dedicated per-pet config field for a fourth pose slot.
function currentPomodoroOverrideRow() {
  if (brain.state !== STATES.IDLE) return null;
  if (!pomodoroActive) return null;
  return Number.isInteger(currentPet?.claudeStatusRows?.working) ? currentPet.claudeStatusRows.working : null;
}

function currentRect() {
  if (brain.state === STATES.SPIN) {
    return headFrameRect(animCol % HEAD_FRAME_COUNT);
  }
  if (allowsHeadFollow(brain.state) && look.showTurnFrame) {
    return headFrameRect(look.frame);
  }
  const overrideRow = currentClaudeOverrideRow();
  if (overrideRow !== null) {
    return frameRect(overrideRow, animCol % ROW_FRAME_COUNTS[overrideRow]);
  }
  const pomodoroRow = currentPomodoroOverrideRow();
  if (pomodoroRow !== null) {
    return frameRect(pomodoroRow, animCol % ROW_FRAME_COUNTS[pomodoroRow]);
  }
  const sleepRow = currentSleepOverrideRow();
  if (sleepRow !== null) {
    return frameRect(sleepRow, animCol % ROW_FRAME_COUNTS[sleepRow]);
  }
  const row = brain.currentRow({ movingRight });
  return frameRect(row, animCol % ROW_FRAME_COUNTS[row]);
}

function advance(dt) {
  const rectBefore = currentRect();
  const wasWander = brain.state === STATES.WANDER;
  const wasArrivedThisTick = arrived;

  userIdleMs += dt * 1000;
  // A panel (chat/todo) being open blocks main.js from
  // ever starting a wander/drag move (window repositioning would corrupt
  // the grown, panel-shaped bounds) -- excluding WANDER from the brain's
  // own weighted pick here is what actually prevents the "stuck showing a
  // walk frame forever" bug that would otherwise follow from asking to
  // move and silently being ignored, same reasoning as the wanderEnabled
  // toggle itself.
  const { state, changed } = brain.update(dt * 1000, {
    userIdleMs,
    cursorMoved,
    arrived,
    // Spontaneous perform/filler poses (waving, holding tea, ...) are also
    // suppressed while a panel is open -- not a window-corruption risk like
    // wander, just distracting when you're trying to focus on a chat.
    randomActionsEnabled: randomActionsEnabled && !chatPanelOpen && !todoPanelOpen,
    wanderEnabled: wanderEnabled && !chatPanelOpen && !todoPanelOpen,
  });
  cursorMoved = false;
  arrived = false;

  if (changed) {
    animCol = 0;
    animAcc = 0;
    if (!allowsHeadFollow(state)) gaze.reset();

    const ravenRows = currentPet?.ravenRows ?? [];
    const newRow = brain.currentRow({ movingRight });
    const crossesSpecies = ravenRows.length > 0 && ravenRows.includes(prevRow) !== ravenRows.includes(newRow);
    if (crossesSpecies) {
      beginTransformFx(rectBefore);
    } else {
      beginFade(rectBefore);
    }
    prevRow = newRow;

    if (state === STATES.WANDER && !wasWander) {
      const vc = brain.profile.visitChance ?? 0;
      const canVisit = companionCfg.enabled && !!cursor.companion && vc > 0 && Math.random() < vc;
      window.pet.wanderStart({ toCompanion: canVisit });
    }
  }

  // A wander that just arrived may need to hand off into a follow-up pose
  // (greeting the companion, settling at a screen edge) instead of the
  // ordinary random idle choice brain.update() would otherwise make.
  if (wasArrivedThisTick && state === STATES.IDLE) {
    if (pendingVisit) {
      pendingVisit = false;
      pendingPerch = false;
      pendingLieDown = false;
      const before = currentRect();
      const row = brain.profile.visitRow ?? 0;
      brain.forceState(STATES.PERFORM, { performRow: row });
      animCol = 0;
      animAcc = 0;
      beginFade(before);
      const lines = brain.profile.visitLines;
      if (lines?.length) {
        speechLine = lines[Math.floor(Math.random() * lines.length)];
        speak(speechLine, cfg.voice);
        speechUntilMs = performance.now() + (brain.profile.performMs ?? 2600);
      }
    } else if (pendingPerch) {
      // Arriving at a side/top edge as a raven and settling onto the branch
      // (row 11) is still raven form -- a plain crossfade, no transform fx.
      pendingPerch = false;
      pendingLieDown = false;
      const before = currentRect();
      if (cfg.debug) console.log('[pose] wander-arrival -> PERCH, brain.state before force =', brain.state);
      brain.forceState(STATES.REST, { restRow: ROWS.PERCH, ignoreCursorMoved: true });
      if (cfg.debug) console.log('[pose] after force: brain.state=', brain.state, 'currentRow=', brain.currentRow({}));
      animCol = 0;
      animAcc = 0;
      beginFade(before);
      // The generic changed-block above already advanced prevRow to the
      // transitional IDLE row before this forced override ran; correct it
      // so the *next* natural transition's species-crossing check (which
      // reads prevRow) sees what's actually on screen.
      prevRow = ROWS.PERCH;
    } else if (pendingLieDown) {
      // Row 12 is human Sebastian curled up asleep, not the raven -- this is
      // a species change like any other, so it gets the feather-burst fx.
      pendingLieDown = false;
      const before = currentRect();
      brain.forceState(STATES.REST, { restRow: ROWS.LIE_DOWN, ignoreCursorMoved: true });
      animCol = 0;
      animAcc = 0;
      beginTransformFx(before);
      prevRow = ROWS.LIE_DOWN;
    }
  }

  // A background task just finished (TaskCompleted hook -> status
  // "celebrate"): interrupt idle with the loudest thing this pet can do, so
  // it reads as a deliberate notification, not routine idle behaviour.
  // claudeStatus.ts !== lastCelebrateTs makes this fire once per event, not
  // once per frame while the file still says "celebrate".
  if (
    claudeStatusCfg.enabled &&
    claudeStatus?.status === 'celebrate' &&
    claudeStatus.ts !== lastCelebrateTs &&
    brain.state === STATES.IDLE
  ) {
    lastCelebrateTs = claudeStatus.ts;
    const before = currentRect();
    if (brain.profile.spinEnabled) {
      brain.forceState(STATES.SPIN);
    } else {
      const row = brain.profile.celebrateRow ?? brain.profile.performRows?.[0] ?? 0;
      brain.forceState(STATES.PERFORM, { performRow: row });
    }
    animCol = 0;
    animAcc = 0;
    beginFade(before);
    if (claudeStatus.detail) {
      speechLine = claudeStatus.detail;
      speak(speechLine, cfg.voice);
      speechUntilMs = performance.now() + 4000;
    }
  }

  // The master outranks the mouse: when the companion pet is in view, look at
  // him instead of the cursor. Only meaningful in states that actually look
  // at anything -- mid-drag or mid-wander there's no gaze to steal.
  const canGaze = allowsHeadFollow(state);
  const comp = canGaze && companionCfg.enabled ? cursor.companion : null;
  const compDist = comp ? Math.hypot(comp.dx, comp.dy) : Infinity;
  const watchCompanion =
    !!comp && companionCfg.gazePriority !== false && compDist <= (companionCfg.gazeRadius ?? 700);
  watchingCompanion = watchCompanion && companionCfg.indicator !== false;

  const gx = watchCompanion ? comp.dx : cursor.dx;
  const gy = watchCompanion ? comp.dy : cursor.dy;

  look = gaze.update(gx, gy, dt, cfg.headFollow && canGaze);
  if (!cfg.tiltEnabled) look.tilt = 0;
  if (cfg.debug && performance.now() - lastLookLog > 400) {
    lastLookLog = performance.now();
    console.log(
      '[look] gx=%d gy=%d yaw=%s frame=%d showTurnFrame=%s',
      Math.round(gx),
      Math.round(gy),
      look.yaw.toFixed(1),
      look.frame,
      look.showTurnFrame,
    );
  }

  // Claude's status can change the displayed pose without any brain state
  // transition (brain.state stays IDLE throughout), so it needs its own
  // transition detection, reusing rectBefore captured at the top of this
  // function -- still valid since nothing else has changed yet this tick.
  const overrideRowNow = currentClaudeOverrideRow();
  if (overrideRowNow !== lastOverrideRow) {
    const ravenRows = currentPet?.ravenRows ?? [];
    const wasRaven = lastOverrideRow !== null && ravenRows.includes(lastOverrideRow);
    const nowRaven = overrideRowNow !== null && ravenRows.includes(overrideRowNow);
    if (ravenRows.length > 0 && wasRaven !== nowRaven) {
      beginTransformFx(rectBefore);
    } else {
      beginFade(rectBefore);
    }
    animCol = 0;
    animAcc = 0;
    lastOverrideRow = overrideRowNow;
  }

  // Greet him on arrival -- only on entering range, and never mid-action.
  if (companionCfg.bow !== false) {
    const shouldBow = greeter.update(compDist, performance.now());
    if (shouldBow && brain.state === STATES.IDLE) {
      brain.forceState(STATES.PERFORM, { performRow: companionCfg.bowRow ?? ROWS.WAVING });
      animCol = 0;
      animAcc = 0;
      beginFade(currentRect());
    }
  }

  animAcc += dt;
  const step = 1 / cfg.fps;
  while (animAcc >= step) {
    animAcc -= step;
    animCol++;
  }

  if (fade) {
    fade.ms -= dt * 1000;
    if (fade.ms <= 0) fade = null;
  }
}

function drawRect(rect, alpha, nodOffsetPx = 0) {
  g.save();
  g.globalAlpha = alpha;
  g.translate(look.lean * cfg.scale * dpr, nodOffsetPx * dpr);
  g.translate(canvas.width / 2, canvas.height * PIVOT_Y);
  g.rotate(((look.tilt + (look.subFrameTilt ?? 0)) * Math.PI) / 180);
  g.translate(-canvas.width / 2, -canvas.height * PIVOT_Y);
  g.drawImage(sheet, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, canvas.width, canvas.height);
  g.restore();
}

function drawFeatherBurst(particles, t) {
  const cx = canvas.width / 2;
  const cy = canvas.height * 0.42;
  const R = Math.min(canvas.width, canvas.height);

  for (const p of particles) {
    const span = 1 - p.delay || 1;
    const localT = Math.max(0, Math.min(1, (t - p.delay) / span));
    if (localT <= 0) continue;

    const dist = p.dist * R * localT;
    const x = cx + Math.cos(p.angle) * dist;
    const y = cy + Math.sin(p.angle) * dist * 0.7;
    const alpha = Math.max(0, 1 - localT) * 0.9;
    const size = p.size * R * (0.6 + 0.4 * localT);

    g.save();
    g.globalAlpha = alpha;
    g.translate(x, y);
    g.rotate(p.spin * localT);
    g.fillStyle = 'rgba(10, 8, 10, 1)';
    g.beginPath();
    g.moveTo(0, -size);
    g.quadraticCurveTo(size * 0.6, 0, 0, size);
    g.quadraticCurveTo(-size * 0.6, 0, 0, -size);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(120, 24, 32, 0.85)';
    g.lineWidth = Math.max(1, size * 0.08);
    g.stroke();
    g.restore();
  }
}

// Status-colour dots, in the character's own crimson family rather than a
// generic traffic-light palette: working stays "on brand", waiting/error
// shift warmer/darker so they're distinguishable at a glance.
const STATUS_DOT_COLOR = {
  working: 'rgba(178, 44, 56, 0.9)',
  review: 'rgba(150, 96, 100, 0.9)',
  waiting: 'rgba(196, 138, 46, 0.9)',
  error: 'rgba(120, 18, 18, 0.95)',
};

// Bubbles are real DOM now (see #bubbleArea in index.html), not canvas-
// drawn -- they need to occupy screen space *outside* the sprite's own
// small canvas so they never cover the character, which means the window
// itself has to grow (same anchor-preserving trick as the reply box; see
// pickBubbleSide/growBoundsForBubble in geometry.js and the
// pet:bubble-space handler in main.js). Growth direction is decided
// main-process-side (only main knows the screen's work area), so this side
// only reports how much space its content needs and reacts to main's
// layout decision.
let bubbleSide = null;
let bubbleExtra = 0;
let lastSentBubbleNeeded = -1;

// Only ever called with `canvas`, whose CSS width/height is owned entirely
// by applyScale() -- must NOT touch them here. Clearing them (as an
// earlier version of this function did, copying the pattern from
// positionBubbleArea) makes the canvas fall back to rendering at its raw
// backing-store pixel size (already dpr-scaled, e.g. 245x266 instead of
// the intended 163x177 CSS px at 1.5x DPI) instead of its intended CSS
// size -- nearly 1.5x too big for its own window, which is what was
// clipping the sprite.
function positionForSide(el, side) {
  el.style.top = '';
  el.style.bottom = '';
  el.style.left = '';
  el.style.right = '';
  switch (side) {
    case 'top':
      el.style.left = '0';
      el.style.bottom = '0';
      break;
    case 'bottom':
      el.style.left = '0';
      el.style.top = '0';
      break;
    case 'left':
      el.style.right = '0';
      el.style.top = '0';
      break;
    case 'right':
      el.style.left = '0';
      el.style.top = '0';
      break;
    default:
      el.style.left = '0';
      el.style.bottom = '0';
  }
}

// Chat/todo panels center the canvas at the top of a much wider window,
// unlike positionForSide's edge-aligned bubble cases. Deliberately sets
// every offset inline (not a CSS class) -- a class rule cannot reliably
// beat a *stale* inline value left over from an earlier positionForSide
// call (inline style always wins over a stylesheet rule regardless of
// selector specificity), which is exactly what was cutting the sprite in
// half: leftover inline left:0 from a prior bubble session silently
// defeated the "canvas.chat-mode { left:50% }" class rule, so the canvas
// centered its transform against the wrong base position and landed half
// off the left edge of the window (confirmed via diagnostic logging:
// canvasRect.x was negative, exactly -half the canvas's own width).
function positionCanvasCentered() {
  canvas.style.top = '0';
  canvas.style.bottom = '';
  canvas.style.left = '50%';
  canvas.style.right = '';
  canvas.style.transform = 'translateX(-50%)';
}

function resetCanvasPosition() {
  canvas.style.top = '';
  canvas.style.bottom = '0';
  canvas.style.left = '0';
  canvas.style.right = '';
  canvas.style.transform = '';
}

// The ring grows the window symmetrically around the sprite's current
// centre (see growBoundsForRing in geometry.js) -- the sprite's *screen*
// position doesn't move, but relative to the new, bigger window's top-left
// corner it's now offset by ringExtra on every side, so the canvas needs
// repositioning to match or it would render in the wrong spot (the same
// class of bug as the chat/todo panel's stale-inline-style issue, just a
// different offset shape).
function positionCanvasForRing(petX, petY) {
  canvas.style.top = `${petY}px`;
  canvas.style.bottom = '';
  canvas.style.left = `${petX}px`;
  canvas.style.right = '';
  canvas.style.transform = '';
}

// Recovery path (see the "恢复正常大小" menu item in main.js) -- forces
// every panel closed unconditionally, not gated on this side's own
// chatPanelOpen/todoPanelOpen flags, since the whole point is
// to recover from those flags themselves being wrong/stuck.
window.pet.onReplyBoxCloseForced(() => {
  chatPanelOpen = false;
  todoPanelOpen = false;
  toolbarOpen = false;
  chatPanelEl.style.display = 'none';
  todoPanelEl.style.display = 'none';
  toolbarRingEl.style.display = 'none';
  ringGooLayerEl.replaceChildren();
  ringIconLayerEl.replaceChildren();
  bubbleAreaEl.style.display = 'none';
  pendingBubbleEl = null;
  resetCanvasPosition();
});

function positionBubbleArea(side, extra) {
  bubbleAreaEl.style.top = '';
  bubbleAreaEl.style.bottom = '';
  bubbleAreaEl.style.left = '';
  bubbleAreaEl.style.right = '';
  bubbleAreaEl.style.width = '';
  bubbleAreaEl.style.height = '';
  if (side === 'top') {
    bubbleAreaEl.style.top = '0';
    bubbleAreaEl.style.left = '0';
    bubbleAreaEl.style.width = '100%';
  } else if (side === 'bottom') {
    bubbleAreaEl.style.bottom = '0';
    bubbleAreaEl.style.left = '0';
    bubbleAreaEl.style.width = '100%';
  } else if (side === 'left') {
    bubbleAreaEl.style.left = '0';
    bubbleAreaEl.style.top = '0';
    bubbleAreaEl.style.width = `${extra}px`;
    bubbleAreaEl.style.height = '100%';
  } else if (side === 'right') {
    bubbleAreaEl.style.right = '0';
    bubbleAreaEl.style.top = '0';
    bubbleAreaEl.style.width = `${extra}px`;
    bubbleAreaEl.style.height = '100%';
  }
}

window.pet.onBubbleLayout(({ side, extra }) => {
  bubbleSide = side;
  bubbleExtra = extra;
  positionForSide(canvas, side ?? 'top');
  positionBubbleArea(side, extra);
});

// Defensive cap regardless of source: tool commands/paths can be
// arbitrarily long, and a local vision model can ramble well past the
// "one or two sentences" a prompt asks for. The CSS line-clamp on
// .bubble-text/.bubble-tip is the real ceiling on rendered height (what
// actually bounds the window-growth request); this just keeps the DOM
// from holding a wall of text no one will ever see past the clamp.
const BUBBLE_TEXT_MAX_CHARS = 320; // matches .bubble-tip's 8-line CSS ceiling (see index.html)
function capBubbleText(text) {
  return text.length > BUBBLE_TEXT_MAX_CHARS ? `${text.slice(0, BUBBLE_TEXT_MAX_CHARS - 1)}…` : text;
}

// `emoji`, when given, replaces the plain colour dot with an emoji marker
// -- used for the waiting status specifically (a lightbulb) so "Claude
// needs your input" reads as an actionable prompt, not just another status
// colour. It sticks around for exactly as long as the status card itself
// does, i.e. until the status actually changes away from 'waiting' -- there
// is no separate timer to fall out of sync with.
//
// `taskTitle`, when given, switches to a two-tier layout -- bold task
// title on top, the plain `text` (what Claude's doing right now, in
// service of that title) as a lighter line underneath. Falls back to the
// single-line layout without it (e.g. before the first UserPromptSubmit of
// a session has ever fired, so no title has been captured yet).
function bubbleCard(text, dotColor, emoji, taskTitle) {
  const card = document.createElement('div');
  card.className = 'bubble-card';
  if (emoji) {
    const marker = document.createElement('span');
    marker.className = 'bubble-emoji';
    marker.textContent = emoji;
    card.appendChild(marker);
  } else if (dotColor) {
    const dot = document.createElement('span');
    dot.className = 'bubble-dot';
    dot.style.background = dotColor;
    card.appendChild(dot);
  }
  if (taskTitle) {
    const wrap = document.createElement('div');
    wrap.className = 'bubble-status-text';
    const title = document.createElement('div');
    title.className = 'bubble-title';
    title.textContent = capBubbleText(taskTitle);
    const detail = document.createElement('div');
    detail.className = 'bubble-detail';
    detail.textContent = capBubbleText(text);
    wrap.appendChild(title);
    wrap.appendChild(detail);
    card.appendChild(wrap);
  } else {
    const span = document.createElement('span');
    span.className = 'bubble-text';
    span.textContent = capBubbleText(text);
    card.appendChild(span);
  }
  return card;
}

function bubblePermissionCard(req) {
  const card = document.createElement('div');
  card.className = 'bubble-permission-card';
  const text = document.createElement('div');
  text.className = 'bubble-permission-text';
  text.textContent = capBubbleText(req.summary || `等你批准：${req.toolName || '一个操作'}`);
  const actions = document.createElement('div');
  actions.className = 'bubble-permission-actions';
  const allowBtn = document.createElement('button');
  allowBtn.className = 'bubble-permission-allow';
  allowBtn.textContent = '批准';
  allowBtn.addEventListener('click', () => resolvePermission(req.requestId, 'allow'));
  const denyBtn = document.createElement('button');
  denyBtn.className = 'bubble-permission-deny';
  denyBtn.textContent = '拒绝';
  denyBtn.addEventListener('click', () => resolvePermission(req.requestId, 'deny'));
  actions.appendChild(allowBtn);
  actions.appendChild(denyBtn);
  card.appendChild(text);
  card.appendChild(actions);
  return card;
}

function bubbleTip(text) {
  const card = document.createElement('div');
  card.className = 'bubble-tip';
  card.textContent = capBubbleText(text);
  return card;
}

function bubbleAttention() {
  const card = document.createElement('div');
  card.className = 'bubble-card';
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('span');
    dot.className = 'bubble-dot bubble-attention-dot';
    dot.style.background = 'rgba(60, 20, 24, 1)';
    card.appendChild(dot);
  }
  return card;
}

// Rebuilds #bubbleArea's content every frame (cheap: a handful of DOM
// nodes, not a render-heavy operation) and tells main.js how much space
// that content needs whenever the total changes -- main.js owns the
// window-growth decision since only it knows the screen's work area.
function updateBubbles() {
  bubbleAreaEl.replaceChildren();
  let anyContent = false;

  // Belt-and-suspenders sweep for the main process's own "resolved" push
  // above -- if that ever gets missed, a card past its own expiresAt is
  // stale regardless (the real request fell through to the terminal prompt
  // long ago), so it shouldn't keep sitting on screen either way.
  if (permissionQueue.length) {
    const now = Date.now();
    permissionQueue = permissionQueue.filter((r) => !r.expiresAt || r.expiresAt > now);
  }

  if (permissionQueue.length) {
    // A blocking permission prompt outranks everything else in the slot --
    // it's the one bubble state where "ignore it" has a real cost (Claude
    // Code sits waiting until it times out or you go answer it manually in
    // the terminal instead), so it must never be buried under a chat reply
    // or status card.
    for (const req of permissionQueue) bubbleAreaEl.appendChild(bubblePermissionCard(req));
    anyContent = true;
  } else if (hoveredContextEntry) {
    // Deliberately hovering a small, out-of-the-way corner badge is a
    // direct request for detail -- takes the slot over whatever ambient
    // content was showing, same as the permission card's reasoning, just
    // one tier down since nothing is blocked on it.
    bubbleAreaEl.appendChild(bubbleUsageCard(hoveredContextEntry));
    anyContent = true;
  } else if (chatReplyText && performance.now() < chatReplyUntilMs) {
    // A reply you directly asked for outranks every ambient bubble --
    // status card, screen-tip aside, even the scripted visit lines.
    bubbleAreaEl.appendChild(bubbleTip(chatReplyText));
    anyContent = true;
  } else if (speechLine && performance.now() < speechUntilMs) {
    // A timed in-character line (e.g. arriving to visit the companion)
    // always wins the bubble slot over the live status/tip content.
    bubbleAreaEl.appendChild(bubbleCard(speechLine, null));
    anyContent = true;
  } else {
    chatReplyText = null;
    speechLine = null;
    // lastOverrideRow reflects the currently-active override (it's only
    // reassigned on a transition, so it holds steady while unchanged). The
    // Claude-status card and the screen-tip bubble are independent sources
    // of information and can be on screen together -- each has its own
    // toggle (right-click menu) and its own visual style so they're never
    // mistaken for one another.
    if (statusBubbleEnabled && lastOverrideRow !== null && claudeStatus?.detail) {
      bubbleAreaEl.appendChild(
        bubbleCard(
          claudeStatus.detail,
          STATUS_DOT_COLOR[claudeStatus.status] ?? STATUS_DOT_COLOR.working,
          claudeStatus.status === 'waiting' ? '💡' : null,
          claudeStatus.taskTitle || null,
        ),
      );
      anyContent = true;
    }
    if (pomodoroActive) {
      // A live countdown, not just a pose -- the pose override (see
      // currentPomodoroOverrideRow) only ever shows while idle and looks
      // identical to Claude's own "working" status, so without this you'd
      // have no reliable way to tell a pomodoro is running at all, let
      // alone how much is left. Recomputed fresh every frame straight from
      // endsAt (no local ticking timer to drift out of sync with main.js's
      // actual setTimeout).
      const remaining = pomodoroRemainingMs({ endsAt: pomodoroEndsAt }, Date.now());
      const totalSec = Math.ceil(remaining / 1000);
      const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
      const ss = String(totalSec % 60).padStart(2, '0');
      bubbleAreaEl.appendChild(bubbleCard(`番茄钟 ${mm}:${ss}`, null, '🍅', null));
      anyContent = true;
    }
    if (watchingCompanion) {
      // A real-time gaze indicator -- takes the tip bubble's slot rather
      // than stacking alongside it.
      bubbleAreaEl.appendChild(bubbleAttention());
      anyContent = true;
    } else if (tipDisplayStacked) {
      screenTipQueue = screenTipQueue.filter((t) => performance.now() < t.untilMs);
      if (tipBubbleEnabled && screenTipQueue.length) {
        for (const t of screenTipQueue) bubbleAreaEl.appendChild(bubbleTip(t.text));
        anyContent = true;
      }
    } else if (tipBubbleEnabled && screenTipText && performance.now() < screenTipUntilMs) {
      bubbleAreaEl.appendChild(bubbleTip(screenTipText));
      anyContent = true;
    } else if (!(screenTipText && performance.now() < screenTipUntilMs)) {
      screenTipText = null;
    }
  }

  bubbleAreaEl.style.display = anyContent ? 'flex' : 'none';

  // Measured assuming a width matching the sprite's own cell (the top/
  // bottom orientation) -- if main.js ends up picking left/right instead
  // (only happens when the pet is pinned to both the top and bottom of a
  // very short screen), the same budget gets reinterpreted as a width
  // there; #bubbleArea has overflow:hidden as a safety net for that rare
  // case rather than spilling outside the window.
  const needed = anyContent ? Math.ceil(bubbleAreaEl.scrollHeight) : 0;
  if (needed !== lastSentBubbleNeeded) {
    lastSentBubbleNeeded = needed;
    window.pet.bubbleSpace(needed);
  }
}

// A quick decaying down-then-up bob, independent of the sprite-row state
// machine -- it layers a small offset on top of whatever pose is already
// drawing rather than switching rows, so it never fights brain.js for which
// row is "current".
function currentNodOffsetPx() {
  if (nodPulseStartMs === null) return 0;
  const t = performance.now() - nodPulseStartMs;
  if (t >= NOD_PULSE_MS) {
    nodPulseStartMs = null;
    return 0;
  }
  return NOD_PULSE_PX * Math.sin((t / NOD_PULSE_MS) * Math.PI);
}

// Persistent status "light slot" (灯槽), drawn directly on the canvas --
// deliberately simple (no emoji font dependency, no window growth) so it's
// reliable wherever the pet is on screen and whatever pose it's in, and
// survives regardless of what bubble/panel is currently showing. Top-left:
// a pulsing red dot when Claude needs you -- a task finished and you
// haven't looked yet, Claude is waiting on your approval, or it errored.
// Top-right: how many todos are still open.
function attentionActive() {
  return unseenCompletion || claudeStatus?.status === 'waiting' || claudeStatus?.status === 'error';
}

function drawAttentionLight() {
  if (!statusLightsEnabled || !attentionActive()) return;
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
  const r = (2.2 + 1.1 * pulse) * dpr;
  const cx = r + 3 * dpr;
  const cy = r + 3 * dpr;
  g.save();
  g.fillStyle = claudeStatus?.status === 'error' ? STATUS_DOT_COLOR.error : 'rgba(214, 32, 40, 1)';
  g.globalAlpha = 0.75 + 0.25 * pulse;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

// Bottom-right ring: how full the freshest active AI context window is.
// Claude comes from its hook transcript reading, while Codex comes from
// rollout token-count events. Deliberately a different corner and shape (arc,
// not a filled dot) from the attention light and todo badge so the three
// never get confused for one another at a glance, and drawn straight on the
// canvas rather than in #bubbleArea so it can never end up sharing space
// with -- or getting pushed around by -- the speech bubble.
// Rate limits are official statusLine data (see
// ~/.claude/hooks/pet-statusline.cjs and https://code.claude.com/docs/en/statusline)
// pushed from main.js's pollAiStatus, not polled here.
// Visual, not text -- three bars, each one's *fill length* is how much of
// that window is still remaining (not used). Claude Code's statusLine only
// ever provides five_hour and seven_day (weekly) windows officially (see
// https://code.claude.com/docs/en/statusline) -- there's no "monthly"
// figure to show, so this deliberately doesn't invent a third row for one.
function bubbleUsageCard(entry) {
  const card = document.createElement('div');
  card.className = 'bubble-usage-card';
  const rows = [
    { icon: '💬', remaining: typeof entry?.contextPercent === 'number' ? 1 - entry.contextPercent : null },
    { icon: '⏱️', remaining: rateLimits?.fiveHourUsedPercent != null ? 1 - rateLimits.fiveHourUsedPercent / 100 : null },
    { icon: '📅', remaining: rateLimits?.weekUsedPercent != null ? 1 - rateLimits.weekUsedPercent / 100 : null },
  ];
  for (const r of rows) {
    if (r.remaining === null) continue;
    const row = document.createElement('div');
    row.className = 'bubble-usage-row';
    const icon = document.createElement('span');
    icon.className = 'bubble-usage-icon';
    icon.textContent = r.icon;
    const track = document.createElement('div');
    track.className = 'bubble-usage-track';
    const fill = document.createElement('div');
    fill.className = 'bubble-usage-fill';
    const pct = Math.round(Math.max(0, Math.min(1, r.remaining)) * 100);
    fill.style.width = `${pct}%`;
    track.appendChild(fill);
    const label = document.createElement('span');
    label.className = 'bubble-usage-pct';
    label.textContent = `${pct}%`;
    row.appendChild(icon);
    row.appendChild(track);
    row.appendChild(label);
    card.appendChild(row);
  }
  if (!card.children.length) {
    const empty = document.createElement('span');
    empty.style.cssText = 'font-size:0.85em; color:rgba(40,16,20,0.5);';
    empty.textContent = '暂无数据';
    card.appendChild(empty);
  }
  return card;
}

function contextRingColor(percent) {
  if (percent >= 0.85) return 'rgba(232, 52, 70, 0.98)';
  if (percent >= 0.6) return 'rgba(207, 42, 59, 0.96)';
  return 'rgba(174, 34, 49, 0.94)';
}

function fillClaudeBurst(r, rayWidth, coreR, fillStyle) {
  g.fillStyle = fillStyle;
  for (let i = 0; i < CLAUDE_SUN_RAY_COUNT; i++) {
    g.save();
    g.rotate((i / CLAUDE_SUN_RAY_COUNT) * Math.PI * 2 + Math.PI / CLAUDE_SUN_RAY_COUNT);
    g.beginPath();
    g.roundRect(-rayWidth / 2, -r, rayWidth, r - coreR * 0.08, rayWidth / 2);
    g.fill();
    g.restore();
  }
  g.beginPath();
  g.arc(0, 0, coreR, 0, Math.PI * 2);
  g.fill();
}

// Match the reference's Claude-like silhouette: ten thick, rounded lobes
// merge into one soft asterisk/sun body. A crimson silhouette underneath the
// near-black body creates one clean outer outline instead of the segmented
// flower lines from the previous version.
function drawContextSun(cx, cy, r, color, nowMs) {
  const motion = contextSunMotion(nowMs);
  const pulseR = r * (0.97 + motion.rayPulse * 0.06);
  const coreR = pulseR * 0.5;
  const rayWidth = pulseR * 0.38;
  const outline = 0.82 * dpr;

  g.save();
  g.translate(cx, cy);
  g.rotate(motion.rotation * 0.55);
  g.scale(motion.scale, motion.scale);
  fillClaudeBurst(pulseR + outline, rayWidth + outline * 1.65, coreR + outline, color);
  fillClaudeBurst(pulseR, rayWidth, coreR, 'rgba(18, 14, 17, 1)');
  g.restore();

  // The tiny sleepy face stays level while the Claude-like body breathes.
  g.save();
  g.translate(cx, cy);
  g.strokeStyle = 'rgba(247, 225, 215, 0.95)';
  g.fillStyle = 'rgba(247, 225, 215, 0.95)';
  g.lineWidth = 0.85 * dpr;
  g.lineCap = 'round';
  const eyeX = coreR * 0.38;
  const eyeY = -coreR * 0.08;
  if (motion.blink) {
    for (const x of [-eyeX, eyeX]) {
      g.beginPath();
      g.moveTo(x - 0.75 * dpr, eyeY);
      g.lineTo(x + 0.75 * dpr, eyeY);
      g.stroke();
    }
  } else {
    for (const x of [-eyeX, eyeX]) {
      g.beginPath();
      g.arc(x, eyeY, 0.72 * dpr, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.beginPath();
  g.arc(0, coreR * 0.16, coreR * 0.28, 0.18 * Math.PI, 0.82 * Math.PI);
  g.stroke();
  g.restore();
}

// Screen-space hit regions for the badges, refreshed every draw -- lets
// reportHit() below detect "cursor is over which badge" (for the 5h/weekly
// hover tooltip) without duplicating the geometry math. One entry per
// session currently being drawn, each tagged with that session's own data.
let contextBadgeHitRegions = [];
let hoveredContextEntry = null;

const CONTEXT_RING_OUTER_R = 15;
const CONTEXT_RING_INNER_R = 9; // annulus inner edge -- the flower sits inside this, untouched by the sector fill
const CONTEXT_RING_MARK_R = 7.8;
const CONTEXT_RING_GAP = 4; // vertical gap between stacked badges, one per session

// One ring per active session (see pickAllContextActivities in
// ai-activity.js and its own comment) instead of picking a single session
// to represent -- stacked upward from the sprite's bottom-right corner so
// however many windows are open, that many badges show up, each reflecting
// only its own window.
function drawContextRings(nowMs) {
  contextBadgeHitRegions = [];
  if (!contextRingEnabled) return;
  const rOuter = CONTEXT_RING_OUTER_R * dpr;
  const rInner = CONTEXT_RING_INNER_R * dpr;
  const rMark = CONTEXT_RING_MARK_R * dpr;
  const stepY = 2 * rOuter + CONTEXT_RING_GAP * dpr;
  const cx = canvas.width - rOuter - 3 * dpr;
  const baseCy = canvas.height - rOuter - 3 * dpr;

  contextUsageList.forEach((entry, i) => {
    const percent = entry?.contextPercent;
    if (typeof percent !== 'number' || Number.isNaN(percent)) return;
    const clamped = Math.max(0, Math.min(1, percent));
    const color = contextRingColor(clamped);
    const cy = baseCy - i * stepY;
    contextBadgeHitRegions.push({ cx, cy, r: rOuter + 2 * dpr, entry });

    g.save();

    // No backing plate on purpose -- just the flower and the ring floating
    // directly on the sprite, per feedback that the dark disc behind it read
    // as a separate blob rather than one badge.
    //
    // A segmented ring (equally divided into wedges, each with real
    // thickness) instead of one smooth pie sector -- reads more like a level
    // meter/dial than a hairline arc, and each lit segment is an unambiguous
    // "one more tenth used" step rather than an angle you have to eyeball.
    // At this badge's actual on-screen size (~30px across), thin wedges with
    // a hairline gap and a near-invisible dim colour just blurred into a
    // single blob with a red smear -- confirmed by zooming in on a real
    // screenshot. A thick band, a wide gap, and a clearly-visible (not
    // near-transparent) dim colour for the unlit wedges are what actually
    // separate them into distinct fan blades at this scale.
    const SEGMENTS = 10;
    const GAP_RAD = 0.16; // gap between segments, in radians of arc
    const segSpan = (Math.PI * 2) / SEGMENTS;
    const litCount = Math.round(clamped * SEGMENTS);
    for (let s = 0; s < SEGMENTS; s++) {
      const start = -Math.PI / 2 + s * segSpan + GAP_RAD / 2;
      const end = start + segSpan - GAP_RAD;
      g.fillStyle = s < litCount ? color : 'rgba(120, 24, 32, 0.32)';
      g.beginPath();
      g.arc(cx, cy, rOuter, start, end);
      g.arc(cx, cy, rInner, end, start, true);
      g.closePath();
      g.fill();
    }

    drawContextSun(cx, cy, rMark, color, nowMs);

    g.restore();
  });
}

function drawTodoBadge() {
  if (!statusLightsEnabled || activeTodoCount <= 0) return;
  const r = 6 * dpr;
  const cx = canvas.width - r - 3 * dpr;
  const cy = r + 3 * dpr;
  g.save();
  g.fillStyle = 'rgba(90, 60, 20, 0.92)';
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.font = `${Math.round(8 * dpr)}px "Microsoft YaHei", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(activeTodoCount > 9 ? '9+' : String(activeTodoCount), cx, cy + 0.5 * dpr);
  g.restore();
}

// Beat-triggered notes drifting up and fading, purely decorative feedback
// for music-nod mode -- independent of the nod pulse itself, drawn last so
// they float in front of the sprite rather than behind it.
function drawNoteParticles(now) {
  if (noteParticles.length === 0) return;
  noteParticles = noteParticles.filter((p) => now - p.bornMs < NOTE_LIFE_MS);
  g.save();
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `${Math.round(13 * dpr)}px "Segoe UI Symbol", "Microsoft YaHei", sans-serif`;
  for (const p of noteParticles) {
    const age = now - p.bornMs;
    const t = age / NOTE_LIFE_MS;
    const alpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
    g.globalAlpha = Math.max(0, Math.min(1, alpha));
    g.fillStyle = 'rgba(214, 178, 60, 0.95)';
    g.fillText(p.char, p.x + p.vx * age, p.y + p.vy * age);
  }
  g.restore();
}

function render() {
  const nowMs = performance.now();
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (!sheet) return;
  const rect = currentRect();
  const nodOffsetPx = currentNodOffsetPx();
  if (fade) {
    const t = 1 - fade.ms / fade.totalMs;
    drawRect(fade.rect, 1 - t, nodOffsetPx);
    drawRect(rect, t, nodOffsetPx);
    if (fade.kind === 'transform') drawFeatherBurst(fade.particles, t);
  } else {
    drawRect(rect, 1, nodOffsetPx);
  }
  drawAttentionLight();
  drawTodoBadge();
  drawContextRings(nowMs);
  drawNoteParticles(nowMs);

  updateBubbles();
}

let wasHit = null;
const RING_HOVER_MS = 500;
let ringHoverStartMs = null;
// Fires once per continuous hover, before the ring-opening threshold (a
// quick "hm?" as the cursor lands, distinct from the ring appearing) --
// resets the moment the cursor leaves so it can fire again next time.
const HOVER_REACT_MS = 350;
let hoverStartMs = null;
let hoverReacted = false;
function reportHit() {
  // insideX/Y arrive in CSS px relative to the *window*, not the canvas --
  // canvas is `position: fixed; bottom: 0` (see index.html), so the moment
  // any bubble grows the window taller than the canvas's own base height,
  // the canvas's actual top offset within the window is no longer 0. Confirmed
  // live: this silently broke the badge hover hit-test (and, latently, this
  // same sprite-alpha test below) any time a status/tip bubble was showing
  // above the sprite. getBoundingClientRect() gives the canvas's real
  // current on-screen position each frame, so this stays correct regardless
  // of how much the window has grown.
  const canvasRect = canvas.getBoundingClientRect();
  const x = Math.round((cursor.insideX - canvasRect.left) * dpr);
  const y = Math.round((cursor.insideY - canvasRect.top) * dpr);
  let hit = false;
  if (x >= 0 && y >= 0 && x < canvas.width && y < canvas.height) {
    hit = g.getImageData(x, y, 1, 1).data[3] > 16;
  }

  // Context-usage badge hover -- a tooltip, not a click target, so this
  // doesn't need to force window interactivity like the permission card
  // does; cursor position comes from main.js's own OS-level tracking
  // regardless of click-through state. Multiple badges can be stacked (one
  // per active session, see drawContextRings) -- whichever one the cursor
  // actually lands on wins.
  const hoveredRegion = contextBadgeHitRegions.find((r) => (x - r.cx) ** 2 + (y - r.cy) ** 2 <= r.r ** 2);
  hoveredContextEntry = hoveredRegion?.entry ?? null;
  const contextBadgeHovered = !!hoveredContextEntry;
  // Same bug class already fixed once for the chat panel (see main.js's
  // pet:interactive handler comment): sprite-alpha hit-testing has no idea
  // #bubbleArea's permission card exists, so the instant the cursor left
  // the actual sprite pixels the window went click-through and silently
  // swallowed clicks on the 批准/拒绝 buttons -- confirmed the reported "点了
  // 没反应" symptom. The card sits above the sprite, not on it, so while
  // one is showing the window must stay fully interactive regardless of
  // where over the card the cursor actually is.
  if (permissionQueue.length) hit = true;
  if (hit !== wasHit) {
    wasHit = hit;
    window.pet.setInteractive(hit);
  }

  // Sustained hover (not a drag, not while any panel is already open) opens
  // the toolbar ring. Any gap in hovering resets the timer -- deliberately
  // a "linger" gesture, not a quick pass-through. The context-usage badge
  // sits directly on top of the sprite's own opaque pixels in the corner,
  // so `hit` (sprite-alpha test) is true there too -- without excluding it,
  // hovering the badge to read usage also silently starts the ring-open
  // timer underneath, popping the toolbar mid-hover. The ring is a
  // sprite-body-only gesture; the badge has its own dedicated hover (the
  // usage card).
  if (hit && !contextBadgeHovered && permissionQueue.length === 0 && !chatPanelOpen && !todoPanelOpen && !toolbarOpen && brain.state !== STATES.DRAG) {
    if (ringHoverStartMs === null) ringHoverStartMs = performance.now();
    else if (performance.now() - ringHoverStartMs >= RING_HOVER_MS) {
      ringHoverStartMs = null;
      window.pet.openToolbar();
    }
    if (hoverStartMs === null) hoverStartMs = performance.now();
    else if (!hoverReacted && performance.now() - hoverStartMs >= HOVER_REACT_MS) {
      hoverReacted = true;
      triggerGesture('hover');
    }
  } else {
    ringHoverStartMs = null;
    hoverStartMs = null;
    hoverReacted = false;
  }
}

// Pointer capture guarantees we still get the release even if the cursor
// outruns the window during a drag.
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return; // right-click is the context menu, not a drag
  canvas.setPointerCapture(e.pointerId);
  brain.forceState(STATES.DRAG);
  window.pet.dragStart();
  gestureDownMs = performance.now();
});

// Long-press ("annoyed") vs rapid quick-click ("petting") -- both reuse the
// existing drag pointerdown/up, classified purely by hold duration (the
// window itself moves under the cursor during a real drag, so local
// clientX/clientY can't reliably tell "dragged" from "held still" here).
const LONG_PRESS_MS = 600;
const QUICK_CLICK_MAX_MS = 250;
const PET_CLICK_WINDOW_MS = 1500;
const PET_CLICK_COUNT = 3;
let gestureDownMs = null;
let recentQuickClicks = [];

// Lines (and, optionally, which sprite row to force-play) for each gesture
// come from config.json's cfg.gestures -- editable in the dashboard's
// "手势" page -- with these as the fallback if a pack/config predates that
// field. row === null/undefined means "just the speech bubble + sound,
// don't interrupt whatever pose is already showing" (the original,
// pre-customization behaviour).
const GESTURES_DEFAULT = {
  annoyedLines: ['……有话好好说，不必如此。', '这般无礼，可不像一位主人该有的样子。', '……需要我退下吗？'],
  annoyedRow: null,
  petLines: ['嗯……这样也不是不可以。', '……仅此一次。', '难得的殊荣，好好珍惜。'],
  petRow: null,
  hoverLines: ['嗯？', '……怎么了？', '有何吩咐？'],
  hoverRow: null,
};
let gesturesCfg = { ...GESTURES_DEFAULT, ...(cfg.gestures ?? {}) };
window.pet.onGesturesChanged((g) => {
  gesturesCfg = { ...GESTURES_DEFAULT, ...(g ?? {}) };
});

function triggerGesture(kind) {
  const lines = gesturesCfg[`${kind}Lines`];
  const row = gesturesCfg[`${kind}Row`];
  if (!lines?.length) return;
  speechLine = lines[Math.floor(Math.random() * lines.length)];
  speechUntilMs = performance.now() + 4000;
  playPetSound();
  if (row !== null && row !== undefined && row !== '') playAnimationRow(Number(row));
}

canvas.addEventListener('pointerup', (e) => {
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  if (brain.state === STATES.DRAG) brain.forceState(STATES.IDLE);
  window.pet.dragEnd();

  const heldMs = gestureDownMs === null ? null : performance.now() - gestureDownMs;
  gestureDownMs = null;
  if (heldMs === null) return;
  const now = performance.now();
  if (heldMs >= LONG_PRESS_MS) {
    recentQuickClicks = [];
    triggerGesture('annoyed');
  } else if (heldMs <= QUICK_CLICK_MAX_MS) {
    recentQuickClicks = recentQuickClicks.filter((ts) => now - ts < PET_CLICK_WINDOW_MS);
    recentQuickClicks.push(now);
    if (recentQuickClicks.length >= PET_CLICK_COUNT) {
      recentQuickClicks = [];
      triggerGesture('pet');
    }
  }
});

function loop(t) {
  const dt = Math.min((t - lastT) / 1000, 0.1);
  lastT = t;
  advance(dt);
  render();
  reportHit();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
