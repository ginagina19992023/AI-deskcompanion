// Dashboard: a normal resizable window, independent of the pet's own tiny
// frameless one. Talks to main.js purely over request/response ("dash.*",
// see dashboard-preload.cjs) rather than push events -- every mutating
// action just re-fetches afterward, which keeps this file simple since the
// window is opened deliberately and briefly, not something that needs to
// track live state the whole time it's open.

import { ATLAS, BASE_ROWS } from './atlas.js';
import { isOverdue, parseTodoInput } from './todos.js';
import { speak } from './voice-tts.js';

// Sprite-sheet dimension check for imported character packs -- the exact
// same rule renderer.js's loadPet() applies to the two shipped pets, run
// here (not in main.js) because Electron's nativeImage can't decode these
// files reliably in the main process (measured: getSize() returns {0,0}
// for the real, working sebastian-raven spritesheet.webp) while a plain
// <img> element, same as this, always has.
function checkPackImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const rowCount = img.naturalHeight / ATLAS.cellH;
      const validHeight = Number.isInteger(rowCount) && rowCount >= BASE_ROWS && rowCount <= ATLAS.rows;
      if (img.naturalWidth !== ATLAS.width || !validHeight) {
        resolve({
          ok: false,
          error: `图集尺寸不对：宽应为 ${ATLAS.width}，高应为 ${BASE_ROWS}~${ATLAS.rows} 行（每行 ${ATLAS.cellH}px）之间的整数倍，实际为 ${img.naturalWidth}x${img.naturalHeight}`,
        });
        return;
      }
      resolve({ ok: true, rowCount });
    };
    img.onerror = () => resolve({ ok: false, error: '图片文件读取失败或格式不支持' });
    img.src = url;
  });
}

const STATUS_LABEL = {
  working: '在动手做',
  review: '在看/审阅',
  waiting: '在等你批准',
  error: '出错了',
  celebrate: '刚完成',
  idle: '空闲',
};
const STATUS_COLOR = {
  working: 'rgba(178, 44, 56, 0.9)',
  review: 'rgba(150, 96, 100, 0.9)',
  waiting: 'rgba(196, 138, 46, 0.9)',
  error: 'rgba(120, 18, 18, 0.95)',
  celebrate: 'rgba(70, 140, 70, 0.9)',
  idle: 'rgba(120, 120, 120, 0.6)',
};

// --- nav -------------------------------------------------------------
const navBtns = [...document.querySelectorAll('.nav-btn')];
const sections = Object.fromEntries(
  [...document.querySelectorAll('.section')].map((el) => [el.id.replace('section-', ''), el]),
);

function showSection(name) {
  for (const btn of navBtns) btn.classList.toggle('active', btn.dataset.section === name);
  for (const [key, el] of Object.entries(sections)) el.classList.toggle('active', key === name);
  if (name === 'todos') {
    refreshTodosAndTasks();
    refreshOutlookStatus();
  }
  if (name === 'tasks') refreshTodosAndTasks();
  if (name === 'history') loadHistory();
  if (name === 'overview') refreshOverview();
  if (name === 'characters') refreshCharacters();
  if (name === 'memory') refreshMemory();
  if (name === 'report') {
    refreshReportList();
    loadFocusHeatmap();
    loadPomodoroList();
  }
  if (name === 'gestures') loadGestures();
  if (name === 'automation') refreshAutomationOutlookStatus();
  if (name === 'chat') loadChatTab();
}
for (const btn of navBtns) btn.addEventListener('click', () => showSection(btn.dataset.section));

// --- overview ----------------------------------------------------------
const overviewCardsEl = document.getElementById('overviewCards');
const overviewClaudeDetailEl = document.getElementById('overviewClaudeDetail');

function renderOverview(data) {
  overviewCardsEl.replaceChildren();
  const cards = [
    { label: '待办', value: String(data.todos.length), detail: data.todos.length ? data.todos.slice(0, 3).map((t) => t.text).join('、') : '没有待办' },
    { label: '番茄钟', value: data.pomodoro.active ? '进行中' : '未开始', detail: data.pomodoro.active ? `结束于 ${new Date(data.pomodoro.endsAt).toLocaleTimeString('zh-CN')}` : '' },
    { label: 'AI 任务', value: String(data.sessions.length), detail: data.sessions.length ? '点「AI 任务」页查看' : '目前没有在跑的会话' },
    { label: '屏幕提示', value: data.settings.screenTipsPaused ? '已暂停' : '开启中', detail: '' },
  ];
  for (const c of cards) {
    const card = document.createElement('div');
    card.className = 'card';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = c.label;
    const value = document.createElement('div');
    value.className = 'value';
    value.textContent = c.value;
    card.append(label, value);
    if (c.detail) {
      const detail = document.createElement('div');
      detail.className = 'detail';
      detail.textContent = c.detail;
      card.appendChild(detail);
    }
    overviewCardsEl.appendChild(card);
  }

  if (!data.aiStatus) {
    overviewClaudeDetailEl.textContent = '暂无数据';
    return;
  }
  const s = data.aiStatus;
  const color = STATUS_COLOR[s.status] ?? STATUS_COLOR.idle;
  const label = STATUS_LABEL[s.status] ?? s.status;
  overviewClaudeDetailEl.innerHTML =
    `<span class="dot" style="background:${color}"></span><strong>${escapeHtml(s.providerLabel || 'AI')} · ${label}</strong>` +
    (s.taskTitle ? ` — ${escapeHtml(s.taskTitle)}` : '') +
    (s.detail ? `<div class="detail">${escapeHtml(s.detail)}</div>` : '');
}

async function refreshOverview() {
  const data = await window.dash.getData();
  renderOverview(data);
  loadClaudeUsage();
}

// --- Claude usage (context per session + account-wide 5h/weekly limits) --
// Data comes entirely from Claude Code's own official statusLine hook (see
// ~/.claude/hooks/pet-statusline.cjs and https://code.claude.com/docs/en/statusline)
// -- context_window and rate_limits are both documented fields.
const claudeUsageSessionsEl = document.getElementById('claudeUsageSessions');
const claudeUsageLimitsEl = document.getElementById('claudeUsageLimits');

function usageBarClass(pct) {
  if (pct >= 90) return 'hot';
  if (pct >= 70) return 'warn';
  return 'ok';
}

function formatTokenCount(n) {
  if (typeof n !== 'number') return '?';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatResetIn(resetsAtMs) {
  if (!resetsAtMs) return '';
  const diffMs = resetsAtMs - Date.now();
  if (diffMs <= 0) return '即将重置';
  const hours = Math.floor(diffMs / 3600000);
  const mins = Math.round((diffMs % 3600000) / 60000);
  if (hours >= 24) return `${Math.floor(hours / 24)} 天后重置`;
  if (hours > 0) return `${hours} 小时 ${mins} 分钟后重置`;
  return `${mins} 分钟后重置`;
}

function renderUsageBar(container, label, sub, valueText, pct) {
  const row = document.createElement('div');
  row.className = 'usage-row';
  const head = document.createElement('div');
  head.className = 'usage-row-head';
  const left = document.createElement('div');
  const labelEl = document.createElement('div');
  labelEl.className = 'usage-row-label';
  labelEl.textContent = label;
  left.appendChild(labelEl);
  if (sub) {
    const subEl = document.createElement('div');
    subEl.className = 'usage-row-sub';
    subEl.textContent = sub;
    left.appendChild(subEl);
  }
  const value = document.createElement('div');
  value.className = 'usage-row-value';
  value.textContent = valueText;
  head.appendChild(left);
  head.appendChild(value);
  const track = document.createElement('div');
  track.className = 'usage-bar-track';
  const fill = document.createElement('div');
  fill.className = `usage-bar-fill ${usageBarClass(pct)}`;
  fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  track.appendChild(fill);
  row.appendChild(head);
  row.appendChild(track);
  container.appendChild(row);
}

async function loadClaudeUsage() {
  const { sessions, accountRateLimits } = await window.dash.getClaudeUsage();

  claudeUsageSessionsEl.replaceChildren();
  if (!sessions?.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '还没有会话上报过数据——正常聊几句 Claude Code 就会有';
    claudeUsageSessionsEl.appendChild(empty);
  } else {
    for (const s of sessions) {
      const pct = s.contextUsedPercent ?? 0;
      const label = s.taskTitle || s.sessionName || (s.cwd ? s.cwd.split(/[\\/]/).pop() : s.model || '会话');
      const valueText =
        typeof s.totalInputTokens === 'number' && typeof s.contextWindowSize === 'number'
          ? `${formatTokenCount(s.totalInputTokens)} / ${formatTokenCount(s.contextWindowSize)} (${pct}%)`
          : `${pct}%`;
      renderUsageBar(claudeUsageSessionsEl, label, s.model, valueText, pct);
    }
  }

  claudeUsageLimitsEl.replaceChildren();
  if (accountRateLimits && (accountRateLimits.fiveHourUsedPercent != null || accountRateLimits.weekUsedPercent != null)) {
    const title = document.createElement('div');
    title.style.cssText = 'font-size:11px; font-weight:700; color:rgba(40,16,20,0.5); margin-bottom:8px;';
    title.textContent = 'Plan usage limits';
    claudeUsageLimitsEl.appendChild(title);
    if (accountRateLimits.fiveHourUsedPercent != null) {
      renderUsageBar(
        claudeUsageLimitsEl,
        '5 小时额度',
        null,
        `${formatResetIn(accountRateLimits.fiveHourResetsAt)} · ${Math.round(accountRateLimits.fiveHourUsedPercent)}%`,
        accountRateLimits.fiveHourUsedPercent,
      );
    }
    if (accountRateLimits.weekUsedPercent != null) {
      renderUsageBar(
        claudeUsageLimitsEl,
        '每周额度 · 全部模型',
        null,
        `${formatResetIn(accountRateLimits.weekResetsAt)} · ${Math.round(accountRateLimits.weekUsedPercent)}%`,
        accountRateLimits.weekUsedPercent,
      );
    }
  }
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// --- models --------------------------------------------------------------
// Free-text model name (not a closed <select>) since a cloud provider's
// model name ("deepseek-chat") isn't one of the locally-pulled Ollama
// names -- a <datalist> still offers the local ones as suggestions when
// provider is 'ollama'. The baseUrl/apiKeyEnv rows only matter for
// 'openai-compatible' so they're dimmed (not hidden -- still visible/
// editable in advance) when provider is 'ollama'.
const dashScreenTipModelEl = document.getElementById('dashScreenTipModel');
const dashScreenTipProviderEl = document.getElementById('dashScreenTipProvider');
const dashScreenTipBaseUrlEl = document.getElementById('dashScreenTipBaseUrl');
const dashScreenTipApiKeyEnvEl = document.getElementById('dashScreenTipApiKeyEnv');
const dashScreenTipCloudRowEl = document.getElementById('dashScreenTipCloudRow');
const dashScreenTipKeyRowEl = document.getElementById('dashScreenTipKeyRow');
const dashChatModelEl = document.getElementById('dashChatModel');
const dashChatProviderEl = document.getElementById('dashChatProvider');
const dashChatBaseUrlEl = document.getElementById('dashChatBaseUrl');
const dashChatApiKeyEnvEl = document.getElementById('dashChatApiKeyEnv');
const dashChatCloudRowEl = document.getElementById('dashChatCloudRow');
const dashChatKeyRowEl = document.getElementById('dashChatKeyRow');
const ollamaModelListEl = document.getElementById('ollamaModelList');

function updateCloudRowVisibility() {
  const stEnabled = dashScreenTipProviderEl.value === 'openai-compatible';
  dashScreenTipCloudRowEl.style.opacity = stEnabled ? '1' : '0.4';
  dashScreenTipKeyRowEl.style.opacity = stEnabled ? '1' : '0.4';
  const chatEnabled = dashChatProviderEl.value === 'openai-compatible';
  dashChatCloudRowEl.style.opacity = chatEnabled ? '1' : '0.4';
  dashChatKeyRowEl.style.opacity = chatEnabled ? '1' : '0.4';
}

function populateModelDatalist(models) {
  ollamaModelListEl.replaceChildren();
  for (const name of models ?? []) {
    const opt = document.createElement('option');
    opt.value = name;
    ollamaModelListEl.appendChild(opt);
  }
}

dashScreenTipModelEl.addEventListener('change', () => window.dash.setSetting('screenTipsModel', dashScreenTipModelEl.value));
dashScreenTipProviderEl.addEventListener('change', () => {
  window.dash.setSetting('screenTipsProvider', dashScreenTipProviderEl.value);
  updateCloudRowVisibility();
});
dashScreenTipBaseUrlEl.addEventListener('change', () => window.dash.setSetting('screenTipsBaseUrl', dashScreenTipBaseUrlEl.value));
dashScreenTipApiKeyEnvEl.addEventListener('change', () => window.dash.setSetting('screenTipsApiKeyEnv', dashScreenTipApiKeyEnvEl.value));
dashChatModelEl.addEventListener('change', () => window.dash.setSetting('chatModel', dashChatModelEl.value));
dashChatProviderEl.addEventListener('change', () => {
  window.dash.setSetting('chatProvider', dashChatProviderEl.value);
  updateCloudRowVisibility();
});
dashChatBaseUrlEl.addEventListener('change', () => window.dash.setSetting('chatBaseUrl', dashChatBaseUrlEl.value));
dashChatApiKeyEnvEl.addEventListener('change', () => window.dash.setSetting('chatApiKeyEnv', dashChatApiKeyEnvEl.value));

// --- toggles ---------------------------------------------------------
const dashScreenTipsPausedEl = document.getElementById('dashScreenTipsPaused');
const dashWorkSupervisionEnabledEl = document.getElementById('autoWorkSupervisionEnabled');
const dashWorkSupervisionIntervalEl = document.getElementById('autoWorkSupervisionInterval');
const dashSleepEnabledEl = document.getElementById('dashSleepEnabled');
const dashSleepStartEl = document.getElementById('dashSleepStart');
const dashSleepEndEl = document.getElementById('dashSleepEnd');
const dashDailySummaryEnabledEl = document.getElementById('autoDailySummaryEnabled');
const dashDailySummaryIntervalEl = document.getElementById('autoDailySummaryInterval');
const dashScreenTipsAutoIntervalEl = document.getElementById('autoScreenTipsInterval');
const dashStatusLightsEnabledEl = document.getElementById('dashStatusLightsEnabled');
const dashContextRingEnabledEl = document.getElementById('dashContextRingEnabled');
const dashPanelAlphaEl = document.getElementById('dashPanelAlpha');
const dashPanelAlphaValueEl = document.getElementById('dashPanelAlphaValue');

function applyPanelAlpha(v) {
  document.documentElement.style.setProperty('--panel-alpha', v);
  dashPanelAlphaValueEl.textContent = `${Math.round(v * 100)}%`;
}
// Live preview while dragging (no disk write on every pixel of movement),
// persisted once the user actually lets go of the slider.
dashPanelAlphaEl.addEventListener('input', () => {
  const value = Number(dashPanelAlphaEl.value);
  applyPanelAlpha(value);
  window.dash.previewOpacity(value);
});
dashPanelAlphaEl.addEventListener('change', () => window.dash.setSetting('dashboardPanelAlpha', Number(dashPanelAlphaEl.value)));

const DEFAULT_SKIN_COLOR = '#faf0e4';
const dashSkinColorEl = document.getElementById('dashSkinColor');
const dashSkinColorResetEl = document.getElementById('dashSkinColorReset');
dashSkinColorEl.addEventListener('input', () => window.dash.setSetting('petSkinColor', dashSkinColorEl.value));
dashSkinColorResetEl.addEventListener('click', () => {
  dashSkinColorEl.value = DEFAULT_SKIN_COLOR;
  window.dash.setSetting('petSkinColor', DEFAULT_SKIN_COLOR);
});

const dashMusicCommentChanceEl = document.getElementById('dashMusicCommentChance');
const dashMusicCommentChanceValueEl = document.getElementById('dashMusicCommentChanceValue');
dashMusicCommentChanceEl.addEventListener('input', () => {
  dashMusicCommentChanceValueEl.textContent = `${Math.round(Number(dashMusicCommentChanceEl.value) * 100)}%`;
});
dashMusicCommentChanceEl.addEventListener('change', () => window.dash.setSetting('musicCommentChance', Number(dashMusicCommentChanceEl.value)));

const dashMusicCommentCooldownEl = document.getElementById('dashMusicCommentCooldown');
const dashMusicCommentCooldownValueEl = document.getElementById('dashMusicCommentCooldownValue');
dashMusicCommentCooldownEl.addEventListener('input', () => {
  dashMusicCommentCooldownValueEl.textContent = `${dashMusicCommentCooldownEl.value} 秒`;
});
dashMusicCommentCooldownEl.addEventListener('change', () => window.dash.setSetting('musicCommentCooldownMs', Number(dashMusicCommentCooldownEl.value) * 1000));

const dashMemoryEnabledEl = document.getElementById('dashMemoryEnabled');
const dashScreenTipsEnabledEl = document.getElementById('autoScreenTipsEnabled');
const dashCameraSenseEnabledEl = document.getElementById('autoCameraSenseEnabled');
const dashCameraSenseIntervalEl = document.getElementById('autoCameraSenseInterval');
const dashChatEnabledEl = document.getElementById('dashChatEnabled');
const dashMusicNodEnabledEl = document.getElementById('dashMusicNodEnabled');
const dashPomodoroDurationEl = document.getElementById('dashPomodoroDuration');
const dashCompanionEnabledEl = document.getElementById('dashCompanionEnabled');
const dashTipDisplayStackedEl = document.getElementById('dashTipDisplayStacked');
const dashSoundsEnabledEl = document.getElementById('dashSoundsEnabled');

const SOUND_SLOT_ELS = {
  pomodoro: { name: document.getElementById('soundFilePomodoroName'), pick: document.getElementById('soundFilePomodoroPick'), clear: document.getElementById('soundFilePomodoroClear') },
  alert: { name: document.getElementById('soundFileAlertName'), pick: document.getElementById('soundFileAlertPick'), clear: document.getElementById('soundFileAlertClear') },
  pet: { name: document.getElementById('soundFilePetName'), pick: document.getElementById('soundFilePetPick'), clear: document.getElementById('soundFilePetClear') },
};
async function refreshSoundFileNames() {
  const data = await window.dash.getData();
  renderSettings(data.settings);
}
for (const [slot, els] of Object.entries(SOUND_SLOT_ELS)) {
  els.pick.addEventListener('click', async () => {
    const res = await window.dash.pickSoundFile(slot);
    if (res.ok) await refreshSoundFileNames();
  });
  els.clear.addEventListener('click', async () => {
    await window.dash.clearSoundFile(slot);
    await refreshSoundFileNames();
  });
}
function renderSoundFileNames(names) {
  for (const [slot, els] of Object.entries(SOUND_SLOT_ELS)) {
    els.name.textContent = names?.[slot] ? `已选择：${names[slot]}` : '（内置音效）';
  }
}

function populateHourSelect(selectEl, current) {
  if (!selectEl.childElementCount) {
    for (let h = 0; h < 24; h++) {
      const opt = document.createElement('option');
      opt.value = String(h);
      opt.textContent = String(h);
      selectEl.appendChild(opt);
    }
  }
  selectEl.value = String(current);
}

dashScreenTipsPausedEl.addEventListener('change', () => window.dash.toggleScreenTips(dashScreenTipsPausedEl.checked));
dashWorkSupervisionEnabledEl.addEventListener('change', () => window.dash.setSetting('workSupervisionEnabled', dashWorkSupervisionEnabledEl.checked));
dashWorkSupervisionIntervalEl.addEventListener('change', () => window.dash.setSetting('workSupervisionIntervalMs', Number(dashWorkSupervisionIntervalEl.value)));
dashSleepEnabledEl.addEventListener('change', () => window.dash.setSetting('sleepEnabled', dashSleepEnabledEl.checked));
dashSleepStartEl.addEventListener('change', () => window.dash.setSetting('sleepStartHour', Number(dashSleepStartEl.value)));
dashSleepEndEl.addEventListener('change', () => window.dash.setSetting('sleepEndHour', Number(dashSleepEndEl.value)));
dashDailySummaryEnabledEl.addEventListener('change', () => window.dash.setSetting('dailySummaryEnabled', dashDailySummaryEnabledEl.checked));
dashDailySummaryIntervalEl.addEventListener('change', () => window.dash.setSetting('dailySummaryIntervalMs', Number(dashDailySummaryIntervalEl.value)));
dashStatusLightsEnabledEl.addEventListener('change', () => window.dash.setSetting('statusLightsEnabled', dashStatusLightsEnabledEl.checked));
dashContextRingEnabledEl.addEventListener('change', () => window.dash.setSetting('contextRingEnabled', dashContextRingEnabledEl.checked));
dashMemoryEnabledEl.addEventListener('change', () => window.dash.setSetting('memoryEnabled', dashMemoryEnabledEl.checked));
dashScreenTipsEnabledEl.addEventListener('change', () => window.dash.setSetting('screenTipsEnabled', dashScreenTipsEnabledEl.checked));
dashScreenTipsAutoIntervalEl.addEventListener('change', () => window.dash.setSetting('screenTipsIntervalMs', Number(dashScreenTipsAutoIntervalEl.value)));
dashCameraSenseEnabledEl.addEventListener('change', () => window.dash.setSetting('cameraSenseEnabled', dashCameraSenseEnabledEl.checked));
dashCameraSenseIntervalEl.addEventListener('change', () => window.dash.setSetting('cameraSenseIntervalMs', Number(dashCameraSenseIntervalEl.value)));
dashChatEnabledEl.addEventListener('change', () => window.dash.setSetting('chatEnabled', dashChatEnabledEl.checked));
dashMusicNodEnabledEl.addEventListener('change', () => window.dash.setSetting('musicNodEnabled', dashMusicNodEnabledEl.checked));
dashPomodoroDurationEl.addEventListener('change', () => window.dash.setSetting('pomodoroDurationMin', Number(dashPomodoroDurationEl.value)));
dashCompanionEnabledEl.addEventListener('change', () => window.dash.setSetting('companionEnabled', dashCompanionEnabledEl.checked));
dashTipDisplayStackedEl.addEventListener('change', () => window.dash.setSetting('tipDisplayStacked', dashTipDisplayStackedEl.checked));
dashSoundsEnabledEl.addEventListener('change', () => window.dash.setSetting('soundsEnabled', dashSoundsEnabledEl.checked));

// Voice settings handlers
const voiceEnabledEl = document.getElementById('voiceEnabled');
const voiceVolumeEl = document.getElementById('voiceVolume');
const voiceRateEl = document.getElementById('voiceRate');
const voicePitchEl = document.getElementById('voicePitch');
const voicePushToTalkKeyEl = document.getElementById('voicePushToTalkKey');
const voiceSettingsGroups = [
  document.getElementById('voiceSettingsGroup'),
  document.getElementById('voiceSettingsGroup2'),
  document.getElementById('voiceSettingsGroup3'),
  document.getElementById('voiceSettingsGroup4'),
];

voiceEnabledEl.addEventListener('change', (e) => {
  window.dash.setSetting('voiceEnabled', e.target.checked);
  for (const group of voiceSettingsGroups) {
    group.style.display = e.target.checked ? 'block' : 'none';
  }
});

voiceVolumeEl.addEventListener('input', (e) => {
  window.dash.setSetting('voiceVolume', parseFloat(e.target.value));
  document.getElementById('voiceVolumeValue').textContent = parseFloat(e.target.value).toFixed(1);
});

voiceRateEl.addEventListener('input', (e) => {
  window.dash.setSetting('voiceRate', parseFloat(e.target.value));
  document.getElementById('voiceRateValue').textContent = parseFloat(e.target.value).toFixed(1);
});

voicePitchEl.addEventListener('input', (e) => {
  window.dash.setSetting('voicePitch', parseFloat(e.target.value));
  document.getElementById('voicePitchValue').textContent = parseFloat(e.target.value).toFixed(1);
});

voicePushToTalkKeyEl.addEventListener('change', (e) => {
  window.dash.setSetting('voicePushToTalkKey', e.target.value || 'F9');
});

// Chat settings handlers
const chatEnabledEl = document.getElementById('chatEnabled');
const chatVoiceModeEl = document.getElementById('chatVoiceMode');
const chatProviderEl = document.getElementById('chatProvider');
const chatOllamaUrlEl = document.getElementById('chatOllamaUrl');
const chatModelEl = document.getElementById('chatModel');
const chatSettingsGroups = [
  document.getElementById('chatSettingsGroup'),
  document.getElementById('chatSettingsGroup2'),
];
const chatOllamaGroup = document.getElementById('chatOllamaGroup');
const chatModelGroup = document.getElementById('chatModelGroup');
const chatVoiceModeHint = document.getElementById('chatVoiceModeHint');

chatEnabledEl.addEventListener('change', (e) => {
  window.dash.setSetting('chatEnabled', e.target.checked);
  for (const group of chatSettingsGroups) {
    group.style.display = e.target.checked ? 'block' : 'none';
  }
  chatVoiceModeHint.style.display = e.target.checked ? 'block' : 'none';
  chatOllamaGroup.style.display = e.target.checked && chatProviderEl.value === 'ollama' ? 'block' : 'none';
  chatModelGroup.style.display = e.target.checked ? 'block' : 'none';
});

chatVoiceModeEl.addEventListener('change', (e) => {
  window.dash.setSetting('chatVoiceMode', e.target.checked);
});

chatProviderEl.addEventListener('change', (e) => {
  window.dash.setSetting('chatProvider', e.target.value);
  chatOllamaGroup.style.display = e.target.value === 'ollama' ? 'block' : 'none';
});

chatOllamaUrlEl.addEventListener('change', (e) => {
  window.dash.setSetting('chatOllamaUrl', e.target.value);
});

chatModelEl.addEventListener('change', (e) => {
  window.dash.setSetting('chatModel', e.target.value);
});

function renderSettings(settings) {
  dashScreenTipModelEl.value = settings.screenTipsModel ?? '';
  dashScreenTipProviderEl.value = settings.screenTipsProvider ?? 'ollama';
  dashScreenTipBaseUrlEl.value = settings.screenTipsBaseUrl ?? '';
  dashScreenTipApiKeyEnvEl.value = settings.screenTipsApiKeyEnv ?? '';
  dashChatModelEl.value = settings.chatModel ?? '';
  dashChatProviderEl.value = settings.chatProvider ?? 'ollama';
  dashChatBaseUrlEl.value = settings.chatBaseUrl ?? '';
  dashChatApiKeyEnvEl.value = settings.chatApiKeyEnv ?? '';
  updateCloudRowVisibility();
  dashScreenTipsPausedEl.checked = !!settings.screenTipsPaused;
  dashWorkSupervisionEnabledEl.checked = !!settings.workSupervisionEnabled;
  dashWorkSupervisionIntervalEl.value = String(settings.workSupervisionIntervalMs ?? 180000);
  dashSleepEnabledEl.checked = !!settings.sleepEnabled;
  populateHourSelect(dashSleepStartEl, settings.sleepStartHour ?? 1);
  populateHourSelect(dashSleepEndEl, settings.sleepEndHour ?? 6);
  dashDailySummaryEnabledEl.checked = !!settings.dailySummaryEnabled;
  dashDailySummaryIntervalEl.value = String(settings.dailySummaryIntervalMs ?? 21600000);
  dashStatusLightsEnabledEl.checked = !!settings.statusLightsEnabled;
  dashContextRingEnabledEl.checked = settings.contextRingEnabled ?? true;
  dashPanelAlphaEl.value = settings.dashboardPanelAlpha ?? 0.92;
  applyPanelAlpha(Number(dashPanelAlphaEl.value));
  dashSkinColorEl.value = settings.petSkinColor ?? DEFAULT_SKIN_COLOR;
  dashMusicCommentChanceEl.value = String(settings.musicCommentChance ?? 0.08);
  dashMusicCommentChanceValueEl.textContent = `${Math.round(Number(dashMusicCommentChanceEl.value) * 100)}%`;
  dashMusicCommentCooldownEl.value = String(Math.round((settings.musicCommentCooldownMs ?? 120000) / 1000));
  dashMusicCommentCooldownValueEl.textContent = `${dashMusicCommentCooldownEl.value} 秒`;
  dashMemoryEnabledEl.checked = !!settings.memoryEnabled;
  dashScreenTipsEnabledEl.checked = !!settings.screenTipsEnabled;
  dashScreenTipsAutoIntervalEl.value = String(settings.screenTipsIntervalMs ?? 180000);
  dashCameraSenseEnabledEl.checked = !!settings.cameraSenseEnabled;
  dashCameraSenseIntervalEl.value = String(settings.cameraSenseIntervalMs ?? 120000);
  dashChatEnabledEl.checked = !!settings.chatEnabled;
  dashMusicNodEnabledEl.checked = !!settings.musicNodEnabled;
  dashPomodoroDurationEl.value = String(settings.pomodoroDurationMin ?? 25);
  dashCompanionEnabledEl.checked = !!settings.companionEnabled;
  dashTipDisplayStackedEl.checked = !!settings.tipDisplayStacked;
  dashSoundsEnabledEl.checked = !!settings.soundsEnabled;
  renderSoundFileNames(settings.soundFileNames);

  // Populate voice settings
  voiceEnabledEl.checked = !!settings.voiceEnabled;
  voiceVolumeEl.value = settings.voiceVolume ?? 1.0;
  document.getElementById('voiceVolumeValue').textContent = (settings.voiceVolume ?? 1.0).toFixed(1);
  voiceRateEl.value = settings.voiceRate ?? 1.0;
  document.getElementById('voiceRateValue').textContent = (settings.voiceRate ?? 1.0).toFixed(1);
  voicePitchEl.value = settings.voicePitch ?? 1.0;
  document.getElementById('voicePitchValue').textContent = (settings.voicePitch ?? 1.0).toFixed(1);
  voicePushToTalkKeyEl.value = settings.voicePushToTalkKey ?? 'F9';
  for (const group of voiceSettingsGroups) {
    group.style.display = !!settings.voiceEnabled ? 'block' : 'none';
  }

  // Populate chat settings
  chatEnabledEl.checked = !!settings.chatEnabled;
  chatVoiceModeEl.checked = !!settings.chatVoiceMode;
  chatProviderEl.value = settings.chatProvider ?? 'ollama';
  chatOllamaUrlEl.value = settings.chatOllamaUrl ?? 'http://localhost:11434';
  chatModelEl.value = settings.chatModel ?? 'gemma4:12b';
  for (const group of chatSettingsGroups) {
    group.style.display = !!settings.chatEnabled ? 'block' : 'none';
  }
  chatVoiceModeHint.style.display = !!settings.chatEnabled ? 'block' : 'none';
  chatOllamaGroup.style.display = !!settings.chatEnabled && (settings.chatProvider ?? 'ollama') === 'ollama' ? 'block' : 'none';
  chatModelGroup.style.display = !!settings.chatEnabled ? 'block' : 'none';
}

window.dash.getModels().then(({ models }) => populateModelDatalist(models));

// --- chat tab ------------------------------------------------------
const chatTabMessagesEl = document.getElementById('chatTabMessages');
const chatTabInputEl = document.getElementById('chatTabInput');
const chatTabSendEl = document.getElementById('chatTabSend');
const chatTabVoiceBtnEl = document.getElementById('chatTabVoiceBtn');

let chatTabPendingBubble = null;
let chatTabSpeechBuffer = '';
let chatTabVoiceConfig = null;
let chatTabLoaded = false;

function appendChatTabMessage(role, text) {
  const div = document.createElement('div');
  div.className = `chat-tab-msg ${role}`;
  div.textContent = text;
  chatTabMessagesEl.appendChild(div);
  chatTabMessagesEl.scrollTop = chatTabMessagesEl.scrollHeight;
  return div;
}

async function loadChatTab() {
  if (chatTabLoaded) return;
  chatTabLoaded = true;
  const { messages } = await window.dash.chatGetHistory();
  chatTabMessagesEl.replaceChildren();
  for (const m of messages ?? []) {
    if (m.role === 'user' || m.role === 'assistant') appendChatTabMessage(m.role, m.content);
  }
}

function sendChatTabMessage() {
  const text = chatTabInputEl.value.trim();
  if (!text) return;
  appendChatTabMessage('user', text);
  chatTabInputEl.value = '';
  chatTabPendingBubble = null;
  window.dash.chatSend(text);
}

chatTabSendEl.addEventListener('click', sendChatTabMessage);
chatTabInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChatTabMessage();
});

window.dash.onChatDelta(({ text }) => {
  if (!chatTabPendingBubble) chatTabPendingBubble = appendChatTabMessage('assistant', '');
  chatTabPendingBubble.textContent += text;
  chatTabMessagesEl.scrollTop = chatTabMessagesEl.scrollHeight;
});

window.dash.onChatMessageDone(() => {
  chatTabPendingBubble = null;
});

window.dash.onChatError(({ message }) => {
  appendChatTabMessage('error', message);
  chatTabPendingBubble = null;
});

window.dash.onChatSpeakDelta(({ delta, voiceConfig }) => {
  chatTabVoiceConfig = voiceConfig;
  chatTabSpeechBuffer += delta;
  if (/[。！？\n]$/.test(chatTabSpeechBuffer)) {
    speak(chatTabSpeechBuffer, voiceConfig);
    chatTabSpeechBuffer = '';
  }
});

window.dash.onChatComplete(() => {
  if (chatTabSpeechBuffer && chatTabVoiceConfig) {
    speak(chatTabSpeechBuffer, chatTabVoiceConfig);
  }
  chatTabSpeechBuffer = '';
});

chatTabVoiceBtnEl.addEventListener('mousedown', () => {
  chatTabVoiceBtnEl.classList.add('listening');
  window.dash.voicePptStart();
});
chatTabVoiceBtnEl.addEventListener('mouseup', () => {
  chatTabVoiceBtnEl.classList.remove('listening');
  window.dash.voicePptStop();
});
chatTabVoiceBtnEl.addEventListener('mouseleave', () => {
  if (chatTabVoiceBtnEl.classList.contains('listening')) {
    chatTabVoiceBtnEl.classList.remove('listening');
    window.dash.voicePptStop();
  }
});

window.dash.onVoiceTranscript((text) => {
  if (!text) return;
  const current = chatTabInputEl.value.trim();
  chatTabInputEl.value = current ? `${current} ${text}` : text;
  chatTabInputEl.focus();
});
window.dash.onVoiceError(({ message }) => {
  appendChatTabMessage('error', `语音识别出错：${message}`);
});

// --- todos -------------------------------------------------------------
const dashTodoListEl = document.getElementById('dashTodoList');
const dashTodoInputEl = document.getElementById('dashTodoInput');
const dashTodoAddBtnEl = document.getElementById('dashTodoAddBtn');

function renderTodos(todos) {
  dashTodoListEl.replaceChildren();
  if (!todos.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '没有待办';
    dashTodoListEl.appendChild(empty);
    return;
  }
  for (const t of todos) {
    dashTodoListEl.appendChild(renderDashTodoViewRow(t));
  }
}

// Same "#tag @date" shorthand as adding a todo, reused for editing too
// (via the already-tested parseTodoInput) instead of a separate
// tag-chip/date-picker editor.
function todoRawInput(t) {
  const parts = [t.text];
  for (const tag of t.tags ?? []) parts.push(`#${tag}`);
  if (t.dueAt) {
    const d = new Date(t.dueAt);
    parts.push(`@${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
  }
  return parts.join(' ');
}

function renderDashTodoViewRow(t) {
  const row = document.createElement('div');
  row.className = 'list-item';
  const textWrap = document.createElement('div');
  textWrap.style.cssText = 'flex:1;min-width:0;';
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = t.text;
  textWrap.appendChild(text);
  if (t.tags?.length || t.dueAt) {
    const meta = document.createElement('div');
    meta.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;';
    for (const tag of t.tags ?? []) {
      const chip = document.createElement('span');
      chip.className = 'memory-source-badge';
      chip.textContent = `#${tag}`;
      meta.appendChild(chip);
    }
    if (t.dueAt) {
      const due = document.createElement('span');
      due.className = isOverdue(t) ? 'memory-source-badge uncertain' : 'memory-source-badge';
      due.textContent = new Date(t.dueAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
      meta.appendChild(due);
    }
    textWrap.appendChild(meta);
  }
  const editBtn = document.createElement('button');
  editBtn.className = 'btn';
  editBtn.textContent = '编辑';
  editBtn.addEventListener('click', () => row.replaceWith(renderDashTodoEditRow(t)));
  const done = document.createElement('button');
  done.className = 'btn';
  done.textContent = '完成';
  done.addEventListener('click', async () => {
    window.dash.todoComplete(t.id);
    await refreshTodosAndTasks();
  });
  const delBtn = document.createElement('button');
  delBtn.className = 'btn';
  delBtn.textContent = '删除';
  delBtn.addEventListener('click', async () => {
    window.dash.todoRemove(t.id);
    await refreshTodosAndTasks();
  });
  row.appendChild(textWrap);
  row.appendChild(editBtn);
  row.appendChild(done);
  row.appendChild(delBtn);
  return row;
}

// Real labeled fields (title / due date picker / tags), not the "#tag
// @date" shorthand -- the shorthand exists for fast one-line quick-add
// everywhere, but editing an existing item is exactly where a native date
// picker beats retyping "@2026-12-31" from memory.
function dashDateInputValue(dueAt) {
  if (!dueAt) return '';
  const d = new Date(dueAt);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function renderDashTodoEditRow(t) {
  const row = document.createElement('div');
  row.className = 'list-item todo-edit-form';

  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.value = t.text;
  textInput.placeholder = '标题';
  textInput.className = 'todo-edit-title';

  const fieldsRow = document.createElement('div');
  fieldsRow.className = 'todo-edit-fields';

  const dateLabel = document.createElement('label');
  dateLabel.textContent = '截止日期';
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.value = dashDateInputValue(t.dueAt);
  dateLabel.appendChild(dateInput);

  const tagsLabel = document.createElement('label');
  tagsLabel.textContent = '标签（逗号分隔）';
  const tagsInput = document.createElement('input');
  tagsInput.type = 'text';
  tagsInput.value = (t.tags ?? []).join(', ');
  tagsInput.placeholder = '例如：work, urgent';
  tagsLabel.appendChild(tagsInput);

  fieldsRow.appendChild(dateLabel);
  fieldsRow.appendChild(tagsLabel);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex; gap:8px; margin-top:8px;';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn active';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', async () => {
    const text = textInput.value.trim();
    if (!text) return;
    const tags = tagsInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    // dateInput.value is "" or "YYYY-MM-DD" -- local midnight of that date,
    // matching how parseTodoInput/isOverdue treat dueAt elsewhere.
    const dueAt = dateInput.value ? new Date(`${dateInput.value}T00:00:00`).getTime() : null;
    window.dash.todoEdit({ id: t.id, text, tags, dueAt });
    await refreshTodosAndTasks();
  });
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', () => row.replaceWith(renderDashTodoViewRow(t)));
  btnRow.appendChild(saveBtn);
  btnRow.appendChild(cancelBtn);

  row.appendChild(textInput);
  row.appendChild(fieldsRow);
  row.appendChild(btnRow);
  return row;
}

async function addDashTodo() {
  const text = dashTodoInputEl.value.trim();
  if (!text) return;
  window.dash.todoAdd(text);
  dashTodoInputEl.value = '';
  await refreshTodosAndTasks();
}
dashTodoAddBtnEl.addEventListener('click', addDashTodo);
dashTodoInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addDashTodo();
});

// --- AI tasks ------------------------------------------------------------
const dashTaskListEl = document.getElementById('dashTaskList');

// Multiple concurrent Claude sessions across projects is the normal case
// this dashboard should support -- so beyond just listing them, sessions
// that need you (error/waiting) float to the top ahead of ones quietly
// still working, using the same status vocabulary/colors as the overview
// card's Claude status readout above. Array.prototype.sort is stable, so
// within the same priority the existing most-recent-first order (from
// main.js's readActiveSessions) is preserved.
const TASK_STATUS_PRIORITY = { error: 0, waiting: 1, working: 2, review: 2, celebrate: 3, idle: 4 };
const AGENT_LABEL = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek', kimi: 'Kimi', openai: 'OpenAI', ollama: 'Ollama', custom: 'AI' };

function renderTasks(sessions) {
  dashTaskListEl.replaceChildren();
  if (!sessions?.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '目前没有正在跑的任务';
    dashTaskListEl.appendChild(empty);
    return;
  }
  const sorted = [...sessions].sort(
    (a, b) => (TASK_STATUS_PRIORITY[a.status] ?? 5) - (TASK_STATUS_PRIORITY[b.status] ?? 5),
  );
  for (const s of sorted) {
    const row = document.createElement('div');
    row.className = 'task-item';
    const title = document.createElement('div');
    title.className = 'task-item-title';
    const agentTag = document.createElement('span');
    agentTag.className = 'memory-category-badge';
    agentTag.style.marginRight = '6px';
    agentTag.textContent = s.providerLabel || AGENT_LABEL[s.provider || s.agent] || 'AI';
    title.appendChild(agentTag);
    title.appendChild(document.createTextNode(s.taskTitle || '（未命名任务）'));
    const statusRow = document.createElement('div');
    statusRow.className = 'task-item-status';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = STATUS_COLOR[s.status] ?? STATUS_COLOR.idle;
    statusRow.appendChild(dot);
    statusRow.appendChild(document.createTextNode(STATUS_LABEL[s.status] ?? s.status ?? ''));
    const detail = document.createElement('div');
    detail.className = 'task-item-detail';
    detail.textContent = s.detail || '';
    row.appendChild(title);
    row.appendChild(statusRow);
    row.appendChild(detail);
    row.addEventListener('click', () => window.dash.taskJump(s.sessionId));
    dashTaskListEl.appendChild(row);
  }
}

async function refreshTodosAndTasks() {
  const data = await window.dash.getData();
  renderTodos(data.todos);
  renderTasks(data.sessions);
}

// --- Outlook sync ----------------------------------------------------
const outlookClientIdEl = document.getElementById('outlookClientId');
const outlookTenantIdEl = document.getElementById('outlookTenantId');
const outlookSaveIdBtnEl = document.getElementById('outlookSaveIdBtn');
const outlookConnectBtnEl = document.getElementById('outlookConnectBtn');
const outlookDisconnectBtnEl = document.getElementById('outlookDisconnectBtn');
const outlookSyncNowBtnEl = document.getElementById('outlookSyncNowBtn');
const outlookStatusTextEl = document.getElementById('outlookStatusText');

const autoOutlookStatusEl = document.getElementById('autoOutlookStatus');
async function refreshAutomationOutlookStatus() {
  const status = await window.dash.outlookStatus();
  autoOutlookStatusEl.textContent = status.connected
    ? `已连接：${status.account}${status.enabled ? '（同步中）' : '（已暂停，去「待办」页重新连接）'}`
    : '未连接——去「待办」页设置';
}

async function refreshOutlookStatus() {
  if (!outlookClientIdEl.value && !outlookTenantIdEl.value) {
    const { outlookSync } = await window.dash.getData();
    if (outlookSync) {
      outlookClientIdEl.value = outlookSync.clientId ?? '';
      outlookTenantIdEl.value = outlookSync.tenantId ?? '';
    }
  }
  const status = await window.dash.outlookStatus();
  if (status.connected) {
    outlookStatusTextEl.textContent = `已连接：${status.account}${status.enabled ? '（同步中）' : '（已暂停）'}`;
    outlookConnectBtnEl.style.display = 'none';
    outlookDisconnectBtnEl.style.display = '';
    outlookSyncNowBtnEl.style.display = '';
  } else {
    outlookStatusTextEl.textContent = status.error ? `未连接（${status.error}）` : '未连接';
    outlookConnectBtnEl.style.display = '';
    outlookDisconnectBtnEl.style.display = 'none';
    outlookSyncNowBtnEl.style.display = 'none';
  }
}

outlookSaveIdBtnEl.addEventListener('click', async () => {
  await window.dash.outlookSetClientId({ clientId: outlookClientIdEl.value.trim(), tenantId: outlookTenantIdEl.value.trim() || 'common' });
  outlookStatusTextEl.textContent = '已保存 ID，点「连接账号」登录';
});

outlookConnectBtnEl.addEventListener('click', async () => {
  outlookConnectBtnEl.disabled = true;
  outlookStatusTextEl.textContent = '正在打开浏览器登录……';
  try {
    const res = await window.dash.outlookConnect();
    if (!res.ok) {
      outlookStatusTextEl.textContent = `连接失败：${res.error}`;
    } else {
      await refreshOutlookStatus();
    }
  } finally {
    outlookConnectBtnEl.disabled = false;
  }
});

outlookDisconnectBtnEl.addEventListener('click', async () => {
  await window.dash.outlookDisconnect();
  await refreshOutlookStatus();
});

outlookSyncNowBtnEl.addEventListener('click', async () => {
  outlookSyncNowBtnEl.disabled = true;
  outlookSyncNowBtnEl.textContent = '同步中……';
  try {
    const res = await window.dash.outlookSyncNow();
    if (res.ok) {
      outlookStatusTextEl.textContent = `上次同步：拉取 ${res.summary.pulled} 条，推送 ${res.summary.pushed} 条`;
      await refreshTodosAndTasks();
    } else {
      outlookStatusTextEl.textContent = `同步失败：${res.error}`;
    }
  } finally {
    outlookSyncNowBtnEl.disabled = false;
    outlookSyncNowBtnEl.textContent = '立即同步';
  }
});

// --- history -------------------------------------------------------------
const dashHistoryDateLabelEl = document.getElementById('dashHistoryDateLabel');
const dashHistoryListEl = document.getElementById('dashHistoryList');
const dashSummaryListEl = document.getElementById('dashSummaryList');
const dashHistoryPrevEl = document.getElementById('dashHistoryPrev');
const dashHistoryNextEl = document.getElementById('dashHistoryNext');
const dashHistorySummaryBtnEl = document.getElementById('dashHistorySummaryBtn');
const dashTriggerScreenTipBtnEl = document.getElementById('dashTriggerScreenTipBtn');
const dashTriggerScreenTipErrorEl = document.getElementById('dashTriggerScreenTipError');

function dateToKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
let historyDateKey = dateToKey(new Date());

function renderHistoryDateLabel() {
  const todayKey = dateToKey(new Date());
  dashHistoryDateLabelEl.textContent = historyDateKey === todayKey ? `今天 ${historyDateKey}` : historyDateKey;
}

const HISTORY_SOURCE_LABEL = { screenTip: '屏幕提示', workSupervision: '干活监督', manual: '手动截屏', chat: '聊天问答' };

const imageLightboxEl = document.getElementById('imageLightbox');
const imageLightboxImgEl = document.getElementById('imageLightboxImg');
const imageLightboxCaptionEl = document.getElementById('imageLightboxCaption');
document.getElementById('imageLightboxClose').addEventListener('click', () => {
  imageLightboxEl.style.display = 'none';
});
imageLightboxEl.addEventListener('click', (e) => {
  if (e.target === imageLightboxEl) imageLightboxEl.style.display = 'none'; // click on the dim backdrop, not the image itself
});
function openImageLightbox(url, caption) {
  imageLightboxImgEl.src = url;
  imageLightboxCaptionEl.textContent = caption ?? '';
  imageLightboxEl.style.display = 'flex';
}

function renderHistoryEntries(entries) {
  dashHistoryListEl.replaceChildren();
  if (!entries?.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '没有符合条件的记录';
    dashHistoryListEl.appendChild(empty);
    return;
  }
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'history-item';
    row.dataset.ts = String(e.ts);
    if (e.imageUrl) {
      const img = document.createElement('img');
      img.src = e.imageUrl;
      img.addEventListener('click', () => openImageLightbox(e.imageUrl, `${HISTORY_SOURCE_LABEL[e.source] ?? '屏幕提示'} · ${new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}\n${e.text}`));
      row.appendChild(img);
    }
    const wrap = document.createElement('div');
    const source = document.createElement('span');
    source.className = 'history-item-source';
    source.textContent = HISTORY_SOURCE_LABEL[e.source] ?? '屏幕提示';
    const time = document.createElement('div');
    time.className = 'history-item-time';
    time.textContent = new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const desc = document.createElement('div');
    desc.className = 'history-item-desc';
    desc.textContent = e.text;
    const askBtn = document.createElement('button');
    askBtn.className = 'btn';
    askBtn.style.cssText = 'font-size:10.5px;padding:2px 8px;margin-top:4px;';
    askBtn.textContent = '问问它';
    askBtn.addEventListener('click', () => window.dash.askAboutEntry(e.text));
    wrap.appendChild(source);
    wrap.appendChild(time);
    wrap.appendChild(desc);
    wrap.appendChild(askBtn);
    row.appendChild(wrap);
    dashHistoryListEl.appendChild(row);
  }
}

// Image-first alternative to the list view -- same filtered entries, just a
// bigger-tile grid layout for browsing what a stretch of screenshots
// actually looked like rather than reading their descriptions. Entries with
// no screenshot (e.g. a chat Q&A record) are skipped here since there's
// nothing to show a tile for; they still appear in the list view.
function renderHistoryGallery(entries) {
  dashHistoryGalleryEl.replaceChildren();
  const withImages = (entries ?? []).filter((e) => e.imageUrl);
  if (!withImages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '这天没有带截图的记录';
    dashHistoryGalleryEl.appendChild(empty);
    return;
  }
  for (const e of withImages) {
    const tile = document.createElement('div');
    tile.className = 'gallery-item';
    const img = document.createElement('img');
    img.src = e.imageUrl;
    const time = document.createElement('div');
    time.className = 'gallery-item-time';
    time.textContent = `${HISTORY_SOURCE_LABEL[e.source] ?? '屏幕提示'} · ${new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    const caption = document.createElement('div');
    caption.className = 'gallery-item-caption';
    caption.textContent = e.text;
    tile.addEventListener('click', () => openImageLightbox(e.imageUrl, `${time.textContent}\n${e.text}`));
    tile.appendChild(img);
    tile.appendChild(time);
    tile.appendChild(caption);
    dashHistoryGalleryEl.appendChild(tile);
  }
}

let historyViewMode = 'list'; // 'list' | 'gallery'
const historyViewListBtnEl = document.getElementById('historyViewListBtn');
const historyViewGalleryBtnEl = document.getElementById('historyViewGalleryBtn');
const dashHistoryGalleryEl = document.getElementById('dashHistoryGallery');
function setHistoryViewMode(mode) {
  historyViewMode = mode;
  historyViewListBtnEl.classList.toggle('active', mode === 'list');
  historyViewGalleryBtnEl.classList.toggle('active', mode === 'gallery');
  dashHistoryListEl.style.display = mode === 'list' ? '' : 'none';
  dashHistoryGalleryEl.style.display = mode === 'gallery' ? 'grid' : 'none';
}
historyViewListBtnEl.addEventListener('click', () => setHistoryViewMode('list'));
historyViewGalleryBtnEl.addEventListener('click', () => setHistoryViewMode('gallery'));

// --- history filter (text + source) --------------------------------------
let historyRawEntries = [];
const historyFilterTextEl = document.getElementById('historyFilterText');
const historyFilterCountEl = document.getElementById('historyFilterCount');
const historySourceFilterEls = [...document.querySelectorAll('.history-source-filter')];

function applyHistoryFilter() {
  const q = historyFilterTextEl.value.trim().toLowerCase();
  const activeSources = new Set(historySourceFilterEls.filter((el) => el.checked).map((el) => el.value));
  const filtered = historyRawEntries.filter((e) => {
    if (!activeSources.has(e.source ?? 'screenTip')) return false;
    // Search matches the source label too ("干活监督"), not just the entry
    // text -- typing the category name into the search box is a reasonable
    // thing to expect to work, and the raw text often never contains it
    // (e.g. a work-supervision entry's saved text is the model's 专注/摸鱼
    // commentary, not the literal word "监督").
    if (q) {
      const label = (HISTORY_SOURCE_LABEL[e.source] ?? '屏幕提示').toLowerCase();
      if (!e.text.toLowerCase().includes(q) && !label.includes(q)) return false;
    }
    return true;
  });
  renderHistoryEntries(filtered);
  renderHistoryGallery(filtered);
  historyFilterCountEl.textContent = filtered.length === historyRawEntries.length ? `共 ${historyRawEntries.length} 条` : `${filtered.length} / ${historyRawEntries.length} 条`;
}
historyFilterTextEl.addEventListener('input', applyHistoryFilter);
for (const el of historySourceFilterEls) el.addEventListener('change', applyHistoryFilter);

function renderSummaries(summaries) {
  dashSummaryListEl.replaceChildren();
  if (!summaries?.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '这天还没有总结';
    dashSummaryListEl.appendChild(empty);
    return;
  }
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
    dashSummaryListEl.appendChild(item);
  }
}

async function loadHistory() {
  renderHistoryDateLabel();
  const { entries, summaries } = await window.dash.getHistory(historyDateKey);
  historyRawEntries = entries ?? [];
  applyHistoryFilter();
  renderSummaries(summaries);
}

dashHistoryPrevEl.addEventListener('click', () => {
  const d = keyToDate(historyDateKey);
  d.setDate(d.getDate() - 1);
  historyDateKey = dateToKey(d);
  loadHistory();
});
dashHistoryNextEl.addEventListener('click', () => {
  const d = keyToDate(historyDateKey);
  d.setDate(d.getDate() + 1);
  historyDateKey = dateToKey(d);
  loadHistory();
});
dashHistorySummaryBtnEl.addEventListener('click', async () => {
  dashHistorySummaryBtnEl.disabled = true;
  dashHistorySummaryBtnEl.textContent = '正在想……';
  try {
    const { summaries } = await window.dash.getSummary(historyDateKey);
    renderSummaries(summaries);
  } finally {
    dashHistorySummaryBtnEl.disabled = false;
    dashHistorySummaryBtnEl.textContent = '生成这天的总结';
  }
});

function highlightHistoryEntry(ts) {
  const row = dashHistoryListEl.querySelector(`[data-ts="${ts}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('highlight');
  setTimeout(() => row.classList.remove('highlight'), 2500);
}

dashTriggerScreenTipBtnEl.addEventListener('click', async () => {
  dashTriggerScreenTipErrorEl.textContent = '';
  dashTriggerScreenTipBtnEl.disabled = true;
  dashTriggerScreenTipBtnEl.textContent = '分析中……';
  try {
    const res = await window.dash.triggerScreenTip();
    if (!res.ok) {
      dashTriggerScreenTipErrorEl.textContent = res.error;
      return;
    }
    if (res.day !== historyDateKey) {
      historyDateKey = res.day;
      await loadHistory();
    } else {
      const { entries, summaries } = await window.dash.getHistory(historyDateKey);
      historyRawEntries = entries ?? [];
      applyHistoryFilter();
      renderSummaries(summaries);
    }
    highlightHistoryEntry(res.ts);
  } finally {
    dashTriggerScreenTipBtnEl.disabled = false;
    dashTriggerScreenTipBtnEl.textContent = '📸 立即分析一次';
  }
});

// --- report --------------------------------------------------------------
// The report is an AI synthesis now (see main.js buildReport), so it takes
// real seconds -- disable both buttons and say so rather than leaving the
// old text sitting there looking like nothing happened.
const reportTextEl = document.getElementById('reportText');
const reportDayBtnEl = document.getElementById('dashReportDayBtn');
const reportWeekBtnEl = document.getElementById('dashReportWeekBtn');

async function runReport(kind) {
  reportDayBtnEl.disabled = true;
  reportWeekBtnEl.disabled = true;
  reportTextEl.textContent = '正在综合待办、番茄钟、AI 任务和屏幕记录……';
  try {
    reportTextEl.textContent = await window.dash.getReport(kind);
    await refreshReportList();
  } finally {
    reportDayBtnEl.disabled = false;
    reportWeekBtnEl.disabled = false;
  }
}

reportDayBtnEl.addEventListener('click', () => runReport('day'));
reportWeekBtnEl.addEventListener('click', () => runReport('week'));

// --- past reports ------------------------------------------------------
// Reports used to be pure IPC round-trips (generated, shown once, gone the
// moment you navigated away) -- now persisted server-side (main.js
// saveReport), this just lists what's been kept.
const dashReportListEl = document.getElementById('dashReportList');
const REPORT_KIND_LABEL = { day: '今日报告', week: '本周报告' };

function renderReportList(reports) {
  dashReportListEl.replaceChildren();
  if (!reports?.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '还没有生成过报告';
    dashReportListEl.appendChild(empty);
    return;
  }
  for (const r of reports) {
    const item = document.createElement('div');
    item.className = 'summary-item';
    const time = document.createElement('div');
    time.className = 'summary-item-time';
    time.textContent = `${REPORT_KIND_LABEL[r.kind] ?? r.kind} · ${new Date(r.ts).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    const text = document.createElement('div');
    text.className = 'summary-item-text';
    text.textContent = r.text;
    const delBtn = document.createElement('button');
    delBtn.className = 'btn';
    delBtn.style.cssText = 'font-size:10.5px;padding:2px 8px;margin-top:6px;';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', async () => {
      await window.dash.deleteReport(r.id);
      await refreshReportList();
    });
    item.appendChild(time);
    item.appendChild(text);
    item.appendChild(delBtn);
    dashReportListEl.appendChild(item);
  }
}

async function refreshReportList() {
  renderReportList(await window.dash.getReports());
}

// --- focus/slack heatmap ---------------------------------------------------
// Day x hour-of-day grid built from main.js's dashboard:focus-heatmap, which
// re-derives 专注/摸鱼/不确定 per workSupervision entry from the same
// verdict-line convention handleSupervisionResult reacts to live -- nothing
// new is tracked, this is just a different view onto the existing history.
const focusHeatmapSummaryEl = document.getElementById('focusHeatmapSummary');
const focusHeatmapGridEl = document.getElementById('focusHeatmapGrid');
const focusHeatmapDetailEl = document.getElementById('focusHeatmapDetail');
const HEATMAP_DAYS = 14;

function heatmapCellColor(bucket) {
  if (!bucket) return 'rgba(120, 24, 32, 0.06)'; // no supervision data this hour
  const { focus, slack, uncertain } = bucket;
  const total = focus + slack + uncertain;
  if (total === 0) return 'rgba(120, 24, 32, 0.06)';
  const ratio = (focus + uncertain * 0.5) / total; // uncertain counts as half-credit, not ignored entirely
  // More samples -> more saturated/confident color; 1 sample stays pale so a
  // single stray reading doesn't look as certain as a dozen consistent ones.
  const confidence = Math.min(1, total / 4);
  const r = ratio < 0.5 ? 196 : Math.round(196 - (ratio - 0.5) * 2 * 122);
  const g = ratio > 0.5 ? 140 : Math.round(42 + ratio * 2 * 98);
  const alpha = 0.18 + confidence * 0.72;
  return `rgba(${r}, ${g}, 46, ${alpha.toFixed(2)})`;
}

function showHeatmapDetail(day, hour, bucket, pomodorosHere) {
  focusHeatmapDetailEl.style.display = 'block';
  focusHeatmapDetailEl.innerHTML = '';
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:700; margin-bottom:6px;';
  title.textContent = `${day} ${String(hour).padStart(2, '0')}:00 - ${String(hour).padStart(2, '0')}:59`;
  focusHeatmapDetailEl.appendChild(title);
  if (bucket) {
    const line = document.createElement('div');
    line.className = 'hint';
    line.style.margin = '0';
    line.textContent = `监督判断：专注 ${bucket.focus} 次 · 摸鱼 ${bucket.slack} 次 · 不确定 ${bucket.uncertain} 次`;
    focusHeatmapDetailEl.appendChild(line);
  }
  if (pomodorosHere?.length) {
    const pline = document.createElement('div');
    pline.className = 'hint';
    pline.style.margin = '4px 0 0';
    pline.textContent = `番茄钟完成：${pomodorosHere.map((p) => new Date(p.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })).join('、')}`;
    focusHeatmapDetailEl.appendChild(pline);
  }
}

function renderFocusHeatmap(data) {
  const { days, cells, pomodoros, totals } = data;
  const totalSamples = totals.focus + totals.slack + totals.uncertain;
  focusHeatmapSummaryEl.textContent = totalSamples
    ? `近 ${days.length} 天：专注 ${totals.focus} 次 · 摸鱼 ${totals.slack} 次 · 不确定 ${totals.uncertain} 次 · 专注占比 ${Math.round((totals.focus / totalSamples) * 100)}%（不含不确定）`
    : `近 ${days.length} 天还没有干活监督记录——开一次番茄钟并打开「干活监督」就会开始有数据`;

  const pomodorosByCell = new Map();
  for (const p of pomodoros) {
    const key = `${p.day}-${p.hour}`;
    if (!pomodorosByCell.has(key)) pomodorosByCell.set(key, []);
    pomodorosByCell.get(key).push(p);
  }

  focusHeatmapGridEl.replaceChildren();
  // Header row: a blank corner cell (aligns with the day-label column), then one label per hour.
  focusHeatmapGridEl.appendChild(document.createElement('div'));
  for (let h = 0; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'heatmap-hour-label';
    label.textContent = h % 3 === 0 ? String(h) : '';
    focusHeatmapGridEl.appendChild(label);
  }
  for (const day of days) {
    const dayLabel = document.createElement('div');
    dayLabel.className = 'heatmap-day-label';
    dayLabel.textContent = day.slice(5); // MM-DD, the year is implied by "近 N 天"
    focusHeatmapGridEl.appendChild(dayLabel);
    for (let h = 0; h < 24; h++) {
      const key = `${day}-${h}`;
      const bucket = cells[key];
      const pomodorosHere = pomodorosByCell.get(key);
      const cell = document.createElement('div');
      cell.className = 'heatmap-cell';
      if (bucket) cell.classList.add('has-data');
      if (pomodorosHere) cell.classList.add('has-pomodoro');
      cell.style.background = heatmapCellColor(bucket);
      cell.title = bucket
        ? `${day} ${h}:00 -- 专注${bucket.focus}/摸鱼${bucket.slack}/不确定${bucket.uncertain}`
        : pomodorosHere
          ? `${day} ${h}:00 -- 番茄钟完成，无监督数据`
          : '';
      if (bucket || pomodorosHere) {
        cell.addEventListener('click', () => showHeatmapDetail(day, h, bucket, pomodorosHere));
      }
      focusHeatmapGridEl.appendChild(cell);
    }
  }
}

async function loadFocusHeatmap() {
  const data = await window.dash.getFocusHeatmap(HEATMAP_DAYS);
  renderFocusHeatmap(data);
}

// --- per-pomodoro focus timeline -------------------------------------------
const pomodoroTimelineListEl = document.getElementById('pomodoroTimelineList');

function renderPomodoroTimeline(session) {
  const { startedAt, completedAt, samples } = session;
  const total = Math.max(1, completedAt - startedAt);
  const bar = document.createElement('div');
  bar.className = 'pomo-timeline';
  if (!samples.length) {
    const seg = document.createElement('div');
    seg.className = 'pomo-seg pomo-seg-none';
    seg.style.width = '100%';
    seg.title = '这段时间没有监督样本';
    bar.appendChild(seg);
    return bar;
  }
  // A leading gap before the first sample (supervision started partway into
  // the pomodoro, e.g. its own check interval hadn't elapsed yet) stays
  // uncolored rather than silently attributed to whatever the first sample
  // happened to be.
  if (samples[0].ts > startedAt) {
    const gap = document.createElement('div');
    gap.className = 'pomo-seg pomo-seg-none';
    gap.style.width = `${((samples[0].ts - startedAt) / total) * 100}%`;
    bar.appendChild(gap);
  }
  for (let i = 0; i < samples.length; i++) {
    const segStart = samples[i].ts;
    const segEnd = i + 1 < samples.length ? samples[i + 1].ts : completedAt;
    const widthPct = Math.max(0, ((segEnd - segStart) / total) * 100);
    const seg = document.createElement('div');
    seg.className = `pomo-seg pomo-seg-${samples[i].kind}`;
    seg.style.width = `${widthPct}%`;
    seg.title = `${new Date(segStart).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} ${POMO_KIND_LABEL[samples[i].kind]}`;
    bar.appendChild(seg);
  }
  return bar;
}

const POMO_KIND_LABEL = { focus: '专注', slack: '摸鱼', uncertain: '不确定' };

function renderPomodoroList(sessions) {
  pomodoroTimelineListEl.replaceChildren();
  if (!sessions?.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '还没有完成过番茄钟';
    pomodoroTimelineListEl.appendChild(empty);
    return;
  }
  for (const s of sessions) {
    const item = document.createElement('div');
    item.className = 'pomo-item';
    const head = document.createElement('div');
    head.className = 'pomo-item-head';
    const timeLabel = document.createElement('span');
    const dateStr = new Date(s.completedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const minutes = Math.round(s.durationMs / 60000);
    timeLabel.textContent = `${dateStr} 完成 · ${minutes} 分钟${s.hasWindow ? '' : '（旧记录，时间区间是估的）'}`;
    const focusCount = s.samples.filter((x) => x.kind === 'focus').length;
    const slackCount = s.samples.filter((x) => x.kind === 'slack').length;
    const rated = focusCount + slackCount;
    const ratio = document.createElement('span');
    ratio.className = 'pomo-item-ratio';
    ratio.textContent = rated ? `专注 ${Math.round((focusCount / rated) * 100)}%` : '无监督样本';
    head.appendChild(timeLabel);
    head.appendChild(ratio);
    item.appendChild(head);
    item.appendChild(renderPomodoroTimeline(s));
    pomodoroTimelineListEl.appendChild(item);
  }
}

async function loadPomodoroList() {
  renderPomodoroList(await window.dash.getPomodoroList(20));
}

// --- gestures ------------------------------------------------------------
const gestureAnnoyedLinesEl = document.getElementById('gestureAnnoyedLines');
const gestureAnnoyedRowEl = document.getElementById('gestureAnnoyedRow');
const gesturePetLinesEl = document.getElementById('gesturePetLines');
const gesturePetRowEl = document.getElementById('gesturePetRow');
const gestureHoverLinesEl = document.getElementById('gestureHoverLines');
const gestureHoverRowEl = document.getElementById('gestureHoverRow');
const gestureSaveBtnEl = document.getElementById('gestureSaveBtn');
const gestureSaveHintEl = document.getElementById('gestureSaveHint');

async function loadGestures() {
  const { gestures, actionMapping } = await window.dash.getData();
  const g = gestures ?? {};
  for (const el of [gestureAnnoyedRowEl, gesturePetRowEl, gestureHoverRowEl]) populateRowSelect(el, actionMapping, true);
  gestureAnnoyedLinesEl.value = (g.annoyedLines ?? []).join('\n');
  gestureAnnoyedRowEl.value = g.annoyedRow ?? '';
  gesturePetLinesEl.value = (g.petLines ?? []).join('\n');
  gesturePetRowEl.value = g.petRow ?? '';
  gestureHoverLinesEl.value = (g.hoverLines ?? []).join('\n');
  gestureHoverRowEl.value = g.hoverRow ?? '';
}

gestureSaveBtnEl.addEventListener('click', () => {
  const splitLines = (el) => el.value.split('\n').map((l) => l.trim()).filter(Boolean);
  const rowOrNull = (el) => (el.value === '' ? null : Number(el.value));
  window.dash.setSetting('gestures', {
    annoyedLines: splitLines(gestureAnnoyedLinesEl),
    annoyedRow: rowOrNull(gestureAnnoyedRowEl),
    petLines: splitLines(gesturePetLinesEl),
    petRow: rowOrNull(gesturePetRowEl),
    hoverLines: splitLines(gestureHoverLinesEl),
    hoverRow: rowOrNull(gestureHoverRowEl),
  });
  gestureSaveHintEl.textContent = '已保存';
  setTimeout(() => {
    gestureSaveHintEl.textContent = '';
  }, 2000);
});

// --- shortcuts -------------------------------------------------------
const SHORTCUT_ACTIONS = [
  { key: 'chat', label: '打开聊天' },
  { key: 'todo', label: '打开待办' },
  { key: 'tasks', label: '打开任务列表' },
  { key: 'settings', label: '打开控制面板' },
  { key: 'resetSize', label: '恢复正常大小' },
  { key: 'pomodoro', label: '切换番茄钟' },
  { key: 'musicNod', label: '切换听歌点头' },
  { key: 'wander', label: '切换到处走' },
];
const shortcutListEl = document.getElementById('shortcutList');
let currentShortcuts = {};
let recordingKey = null;

// Modifier-only keydowns (Control alone, etc.) aren't a complete combo yet --
// keep listening until a real key comes down alongside them, then read the
// modifier flags off *that* event.
const SHORTCUT_NAMED_KEYS = {
  ' ': 'Space',
  Escape: 'Escape',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
};

function mapShortcutKey(e) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
  if (SHORTCUT_NAMED_KEYS[e.key]) return SHORTCUT_NAMED_KEYS[e.key];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) return e.key;
  if (/^[a-zA-Z]$/.test(e.key)) return e.key.toUpperCase();
  if (/^[0-9]$/.test(e.key)) return e.key;
  return e.key.length === 1 ? e.key : null;
}

function eventToAccelerator(e) {
  const key = mapShortcutKey(e);
  if (!key) return null;
  const parts = [];
  if (e.ctrlKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  parts.push(key);
  return parts.join('+');
}

function renderShortcuts() {
  shortcutListEl.replaceChildren();
  for (const { key, label } of SHORTCUT_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'shortcut-row';
    const labelEl = document.createElement('div');
    labelEl.className = 'shortcut-label';
    labelEl.textContent = label;
    const kbd = document.createElement('kbd');
    kbd.id = `shortcut-kbd-${key}`;
    const current = currentShortcuts[key];
    kbd.textContent = recordingKey === key ? '按下组合键…(Esc取消)' : current || '未设置';
    kbd.classList.toggle('empty', !current && recordingKey !== key);
    kbd.classList.toggle('recording', recordingKey === key);
    const recordBtn = document.createElement('button');
    recordBtn.className = 'btn';
    recordBtn.textContent = '录制';
    recordBtn.addEventListener('click', () => startRecording(key));
    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn';
    clearBtn.textContent = '清除';
    clearBtn.addEventListener('click', () => applyShortcut(key, ''));
    row.appendChild(labelEl);
    row.appendChild(kbd);
    row.appendChild(recordBtn);
    row.appendChild(clearBtn);
    shortcutListEl.appendChild(row);
  }
}

async function applyShortcut(key, accelerator) {
  const { ok } = await window.dash.setShortcut(key, accelerator);
  currentShortcuts[key] = accelerator;
  renderShortcuts();
  if (!ok && accelerator) {
    const kbd = document.getElementById(`shortcut-kbd-${key}`);
    if (kbd) {
      const err = document.createElement('span');
      err.className = 'shortcut-error';
      err.textContent = '注册失败(可能被占用)';
      kbd.after(err);
    }
  }
}

function startRecording(key) {
  if (recordingKey) return; // one at a time
  recordingKey = key;
  renderShortcuts();
  const onKeydown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      recordingKey = null;
      window.removeEventListener('keydown', onKeydown, true);
      renderShortcuts();
      return;
    }
    const accelerator = eventToAccelerator(e);
    if (!accelerator) return; // modifier-only so far, keep listening
    recordingKey = null;
    window.removeEventListener('keydown', onKeydown, true);
    applyShortcut(key, accelerator);
  };
  window.addEventListener('keydown', onKeydown, true);
}

// --- characters (pet packs) ---------------------------------------------
const petPackGridEl = document.getElementById('petPackGrid');
const importPackBtnEl = document.getElementById('importPackBtn');
const importPackErrorEl = document.getElementById('importPackError');

function renderPetPacks(pets, activePetId) {
  petPackGridEl.replaceChildren();
  for (const p of pets) {
    const card = document.createElement('div');
    card.className = 'card pet-card';
    const isActive = p.id === activePetId;
    card.innerHTML =
      `<div class="pet-name">${escapeHtml(p.displayName)}</div>` +
      `<div class="pet-id">${escapeHtml(p.id)}</div>` +
      (isActive ? '<span class="pet-badge">当前使用</span>' : '');
    const actions = document.createElement('div');
    actions.className = 'pet-actions';
    if (!isActive) {
      const useBtn = document.createElement('button');
      useBtn.className = 'btn primary';
      useBtn.textContent = '切换到此形象';
      useBtn.addEventListener('click', async () => {
        if (!confirm(`切换到「${p.displayName}」需要重启一下小工具，确定吗？`)) return;
        await window.dash.setActivePet(p.id);
      });
      actions.appendChild(useBtn);
    }
    if (pets.length > 1) {
      const delBtn = document.createElement('button');
      delBtn.className = 'btn';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`删除形象「${p.displayName}」？（不会删掉原始图片文件，只是从列表移除）`)) return;
        const res = await window.dash.deletePetPack(p.id);
        if (!res.ok) {
          alert(res.error || '删除失败');
          return;
        }
        if (!res.restarted) await refreshCharacters();
      });
      actions.appendChild(delBtn);
    }
    card.appendChild(actions);
    petPackGridEl.appendChild(card);
  }
}

// "不同动作适配不同状态" -- which atlas row plays for each Claude Code
// status, for the currently-active pet. rowLabels (when the pack/pet
// defines them) give each row a human name in the dropdown instead of just
// a bare number, matching how config.json's own rowLabels comments read.
const ACTION_MAPPING_STATUSES = [
  { key: 'working', label: '在动手做（working）' },
  { key: 'review', label: '只是在看（review）' },
  { key: 'waiting', label: '等你批准（waiting）' },
  { key: 'error', label: '出错了（error）' },
];
const actionMappingListEl = document.getElementById('actionMappingList');

// Shared by the Claude-status action mapping above and the gesture row
// pickers below -- both let you choose a sprite row by its human label
// ("持餐刀"/"端茶托盘"/...) instead of a bare number nobody could place
// without opening the spritesheet themselves. `allowNone` adds a leading
// "不强制播放" option whose value is the empty string, for pickers where
// "don't force a row" is itself a valid, commonly-wanted choice.
function populateRowSelect(select, mapping, allowNone) {
  select.replaceChildren();
  if (allowNone) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '不强制播放（只显示台词+音效）';
    select.appendChild(opt);
  }
  for (let i = 0; i < (mapping?.rowCount ?? 0); i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = mapping.rowLabels?.[i] ? `第${i}行 · ${mapping.rowLabels[i]}` : `第${i}行`;
    select.appendChild(opt);
  }
}

function renderActionMapping(mapping) {
  actionMappingListEl.replaceChildren();
  if (!mapping) return;
  for (const { key, label } of ACTION_MAPPING_STATUSES) {
    const row = document.createElement('div');
    row.className = 'field-row';
    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    const select = document.createElement('select');
    populateRowSelect(select, mapping, false);
    select.value = String(mapping.claudeStatusRows?.[key] ?? 0);
    select.addEventListener('change', async () => {
      const res = await window.dash.setActionMapping(key, select.value);
      if (!res.ok) alert(res.error || '保存失败');
    });
    row.appendChild(labelEl);
    row.appendChild(select);
    actionMappingListEl.appendChild(row);
  }
}

async function refreshCharacters() {
  const data = await window.dash.getData();
  renderPetPacks(data.pets, data.activePet);
  renderActionMapping(data.actionMapping);
}

importPackBtnEl.addEventListener('click', async () => {
  importPackErrorEl.textContent = '';
  importPackBtnEl.disabled = true;
  importPackBtnEl.textContent = '导入中…';
  try {
    const picked = await window.dash.pickPetPackFolder();
    if (picked.cancelled) return;
    if (!picked.ok) {
      importPackErrorEl.textContent = picked.error || '导入失败';
      return;
    }
    const check = await checkPackImage(picked.imageUrl);
    if (!check.ok) {
      importPackErrorEl.textContent = check.error;
      return;
    }
    const res = await window.dash.commitPetPack({
      dir: picked.dir,
      imagePath: picked.imagePath,
      packJson: picked.packJson,
      rowCount: check.rowCount,
    });
    if (!res.ok) {
      importPackErrorEl.textContent = res.error || '导入失败';
      return;
    }
    await refreshCharacters();
  } finally {
    importPackBtnEl.disabled = false;
    importPackBtnEl.textContent = '＋ 导入角色包';
  }
});

// --- memory ---------------------------------------------------------
const memoryListEl = document.getElementById('memoryList');
const clearMemoryBtnEl = document.getElementById('clearMemoryBtn');

// The unfiltered set -- kept separate from whatever renderMemoryList()
// currently shows because a reflection fact's "依据" sources may belong to
// a category/source/time-range the active filter just excluded; resolving
// reflectsIds must always search the full set, not the filtered view.
let allMemoryFacts = [];
let allMemoryGraphFacts = [];
let allMemoryEdges = [];

const memoryFilterEls = {
  search: document.getElementById('memoryFilterSearch'),
  source: document.getElementById('memoryFilterSource'),
  category: document.getElementById('memoryFilterCategory'),
  time: document.getElementById('memoryFilterTime'),
  single: document.getElementById('memoryFilterSingle'),
  from: document.getElementById('memoryFilterFrom'),
  to: document.getElementById('memoryFilterTo'),
  timeSep: document.getElementById('memoryFilterTimeSep'),
  reset: document.getElementById('memoryFilterResetBtn'),
  count: document.getElementById('memoryFilterCount'),
};

function memoryTimeRangeBounds() {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  switch (memoryFilterEls.time.value) {
    case 'today': {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return { from: start.getTime(), to: now };
    }
    case 'week':
      return { from: now - 7 * dayMs, to: now };
    case 'month':
      return { from: now - 30 * dayMs, to: now };
    case 'single': {
      if (!memoryFilterEls.single.value) return null;
      const from = new Date(`${memoryFilterEls.single.value}T00:00:00`).getTime();
      return { from, to: from + dayMs - 1 };
    }
    case 'custom': {
      const from = memoryFilterEls.from.value ? new Date(memoryFilterEls.from.value + 'T00:00:00').getTime() : -Infinity;
      const to = memoryFilterEls.to.value ? new Date(memoryFilterEls.to.value + 'T23:59:59').getTime() : Infinity;
      return { from, to };
    }
    default:
      return null;
  }
}

function memoryMatchesActiveFilters(m) {
  const source = memoryFilterEls.source.value;
  const category = memoryFilterEls.category.value;
  const query = memoryFilterEls.search.value.trim().toLowerCase();
  const range = memoryTimeRangeBounds();
  const members = m.clusterMembers ?? [m];
  if (source !== 'all' && !members.some((member) => member.source === source)) return false;
  if (category !== 'all' && !members.some((member) => (member.category || '其他') === category)) return false;
  const searchable = members.map((member) => member.text).join(' ').toLowerCase();
  if (query && !searchable.includes(query)) return false;
  if (range && !members.some((member) => member.ts >= range.from && member.ts <= range.to)) return false;
  return true;
}

function applyMemoryFilters() {
  const filtered = allMemoryFacts.filter(memoryMatchesActiveFilters);
  const filteredGraph = allMemoryGraphFacts.filter(memoryMatchesActiveFilters);
  renderMemoryList(filtered);
  memoryFilterEls.count.textContent = graphRunning
    ? `${filteredGraph.length} 个主题 / ${filtered.length} 条原始记忆`
    : filtered.length === allMemoryFacts.length
      ? `共 ${allMemoryFacts.length} 条`
      : `${filtered.length} / ${allMemoryFacts.length} 条`;
  // The graph is a separate view onto the same data -- same filters apply.
  // buildGraph already drops any edge whose endpoint got filtered out (see
  // its own nodeById lookup), so passing the full unfiltered edge list here
  // is safe and simpler than pre-filtering it ourselves.
  if (graphRunning) buildGraph(filteredGraph, allMemoryEdges);
}

memoryFilterEls.search.addEventListener('input', applyMemoryFilters);
memoryFilterEls.source.addEventListener('change', applyMemoryFilters);
memoryFilterEls.category.addEventListener('change', applyMemoryFilters);
memoryFilterEls.single.addEventListener('change', applyMemoryFilters);
memoryFilterEls.from.addEventListener('change', applyMemoryFilters);
memoryFilterEls.to.addEventListener('change', applyMemoryFilters);
memoryFilterEls.time.addEventListener('change', () => {
  const mode = memoryFilterEls.time.value;
  memoryFilterEls.single.style.display = mode === 'single' ? '' : 'none';
  const isCustom = mode === 'custom';
  memoryFilterEls.from.style.display = isCustom ? '' : 'none';
  memoryFilterEls.timeSep.style.display = isCustom ? '' : 'none';
  memoryFilterEls.to.style.display = isCustom ? '' : 'none';
  applyMemoryFilters();
});
memoryFilterEls.reset.addEventListener('click', () => {
  memoryFilterEls.search.value = '';
  memoryFilterEls.source.value = 'all';
  memoryFilterEls.category.value = 'all';
  memoryFilterEls.time.value = 'all';
  memoryFilterEls.single.value = '';
  memoryFilterEls.from.value = '';
  memoryFilterEls.to.value = '';
  memoryFilterEls.single.style.display = 'none';
  memoryFilterEls.from.style.display = 'none';
  memoryFilterEls.timeSep.style.display = 'none';
  memoryFilterEls.to.style.display = 'none';
  applyMemoryFilters();
});

// Grouped by category, most-important-then-most-recent within each group --
// same ranking main.js's memoryContextBlock() uses to decide what actually
// gets fed back to the model, so what you see here is what it's using.
const MEMORY_CATEGORY_ORDER = ['身份', '项目', '喜好', '习惯', '事件', '其他'];

function importanceDots(importance) {
  const n = Math.min(3, Math.max(1, importance ?? 1));
  return '●'.repeat(n) + '○'.repeat(3 - n);
}

// Every fact is tagged with which pipeline produced it (see main.js's
// parseAndStoreMemoryFacts) -- 'chat' from things explicitly said in
// conversation, 'activity' from Claude-task/screen-observation mining
// (extractActivityMemoryFacts). Surfaced as a badge so "where did this
// come from" is answered without opening the graph detail panel.
const MEMORY_SOURCE_LABEL = { chat: '聊天', activity: '日常观察', 'screen-observation': '截屏猜测', manual: '手动添加', reflection: '归纳总结' };
const MEMORY_CATEGORIES_LIST = ['身份', '喜好', '项目', '习惯', '事件', '其他'];

function renderMemoryList(entries) {
  memoryListEl.replaceChildren();
  if (!entries?.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '还没有记住任何事——多聊几句，或者让它跑几个 AI 任务/攒点屏幕记录，它会自己记下来';
    memoryListEl.appendChild(empty);
    return;
  }
  const groups = new Map();
  for (const m of entries) {
    const cat = m.category || '其他';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(m);
  }
  const orderedCats = [...MEMORY_CATEGORY_ORDER.filter((c) => groups.has(c)), ...[...groups.keys()].filter((c) => !MEMORY_CATEGORY_ORDER.includes(c))];
  for (const cat of orderedCats) {
    const items = groups.get(cat).sort((a, b) => (b.importance ?? 1) - (a.importance ?? 1) || b.ts - a.ts);
    const group = document.createElement('div');
    group.className = 'memory-category-group';
    const title = document.createElement('div');
    title.className = 'memory-category-title';
    title.append(document.createTextNode(`${cat} `));
    const badge = document.createElement('span');
    badge.className = 'memory-category-badge';
    badge.textContent = String(items.length);
    title.appendChild(badge);
    group.appendChild(title);
    for (const m of items) {
      group.appendChild(renderMemoryItemRow(m, allMemoryFacts));
    }
    memoryListEl.appendChild(group);
  }
}

// Shown in both the list row and the graph detail panel -- prior versions
// kept on edit (see main.js's dashboard:edit-memory), most recent first.
// Matters most for a fact that started as source: 'screen-observation' /
// uncertain: true (a vision-model guess): the original guess and the
// human-corrected version both stay visible instead of the correction
// silently erasing what it replaced.
function renderMemoryHistoryPanel(history) {
  const panel = document.createElement('div');
  panel.className = 'memory-history-panel';
  const sorted = [...history].sort((a, b) => b.editedAt - a.editedAt);
  for (const h of sorted) {
    const item = document.createElement('div');
    item.className = 'memory-history-item';
    const time = document.createElement('span');
    time.className = 'memory-history-time';
    time.textContent = new Date(h.editedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const text = document.createElement('span');
    text.className = 'memory-history-text';
    text.textContent = h.uncertain ? `${h.text}（当时标记为「不确定」）` : h.text;
    item.appendChild(time);
    item.appendChild(text);
    panel.appendChild(item);
  }
  return panel;
}

// A 'reflection' fact has no edit history of its own (it's freshly
// synthesized) -- what "history" means for it is the raw facts it was
// distilled FROM (m.reflectsIds), which still live on in the list tagged
// reflectedInto. Reuses the same panel look as edit history.
function renderReflectionSourcesPanel(sourceFacts) {
  const panel = document.createElement('div');
  panel.className = 'memory-history-panel';
  const sorted = [...sourceFacts].sort((a, b) => b.ts - a.ts);
  for (const f of sorted) {
    const item = document.createElement('div');
    item.className = 'memory-history-item';
    const time = document.createElement('span');
    time.className = 'memory-history-time';
    time.textContent = new Date(f.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const text = document.createElement('span');
    text.className = 'memory-history-text';
    text.textContent = f.uncertain ? `${f.text}（不确定）` : f.text;
    item.appendChild(time);
    item.appendChild(text);
    panel.appendChild(item);
  }
  return panel;
}

function renderMemoryItemRow(m, allFacts) {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'memory-item';
  const importance = document.createElement('div');
  importance.className = 'memory-importance';
  importance.textContent = importanceDots(m.importance);
  importance.title = `重要性 ${m.importance ?? 1}/3`;
  const text = document.createElement('div');
  text.className = 'memory-text';
  text.textContent = m.text;
  const source = document.createElement('div');
  const sourceClasses = ['memory-source-badge'];
  if (m.uncertain) sourceClasses.push('uncertain');
  if (m.source === 'reflection') sourceClasses.push('reflection');
  source.className = sourceClasses.join(' ');
  source.textContent = MEMORY_SOURCE_LABEL[m.source] ?? '聊天';
  source.title =
    m.source === 'reflection'
      ? `从 ${m.reflectsIds?.length ?? '多'} 条相关事实归纳出的更高层结论`
      : m.reflectedInto
        ? '这条已经被归纳进了一条更高层的总结'
        : m.uncertain
          ? '视觉模型看截图猜的，可能不准'
          : '';
  const time = document.createElement('div');
  time.className = 'memory-time';
  time.textContent = new Date(m.ts).toLocaleDateString('zh-CN');
  row.appendChild(importance);
  row.appendChild(text);
  row.appendChild(source);
  row.appendChild(time);
  let historyPanel = null;
  if (m.history?.length) {
    historyPanel = renderMemoryHistoryPanel(m.history);
    historyPanel.style.display = 'none';
    const historyBtn = document.createElement('button');
    historyBtn.className = 'btn';
    historyBtn.textContent = `历史(${m.history.length})`;
    historyBtn.addEventListener('click', () => {
      historyPanel.style.display = historyPanel.style.display === 'none' ? 'flex' : 'none';
    });
    row.appendChild(historyBtn);
  }
  let sourcesPanel = null;
  if (m.source === 'reflection' && m.reflectsIds?.length) {
    const sourceFacts = allFacts ? m.reflectsIds.map((id) => allFacts.find((f) => f.id === id)).filter(Boolean) : [];
    sourcesPanel = renderReflectionSourcesPanel(sourceFacts);
    sourcesPanel.style.display = 'none';
    const sourcesBtn = document.createElement('button');
    sourcesBtn.className = 'btn';
    sourcesBtn.textContent = `依据(${m.reflectsIds.length})`;
    sourcesBtn.addEventListener('click', () => {
      sourcesPanel.style.display = sourcesPanel.style.display === 'none' ? 'flex' : 'none';
    });
    row.appendChild(sourcesBtn);
  }
  const editBtn = document.createElement('button');
  editBtn.className = 'btn';
  editBtn.textContent = '编辑';
  editBtn.addEventListener('click', () => row.replaceWith(renderMemoryEditRow(m)));
  const delBtn = document.createElement('button');
  delBtn.className = 'btn';
  delBtn.textContent = '删除';
  delBtn.addEventListener('click', async () => {
    await window.dash.deleteMemory(m.id);
    await refreshMemory();
  });
  row.appendChild(editBtn);
  row.appendChild(delBtn);
  wrap.appendChild(row);
  if (historyPanel) wrap.appendChild(historyPanel);
  if (sourcesPanel) wrap.appendChild(sourcesPanel);
  return wrap;
}

function renderMemoryEditRow(m) {
  const row = document.createElement('div');
  row.className = 'memory-item';
  row.style.flexWrap = 'wrap';
  const catSelect = document.createElement('select');
  for (const c of MEMORY_CATEGORIES_LIST) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    if (c === (m.category || '其他')) opt.selected = true;
    catSelect.appendChild(opt);
  }
  const impSelect = document.createElement('select');
  for (const n of [1, 2, 3]) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = `重要性 ${n}`;
    if (n === (m.importance ?? 1)) opt.selected = true;
    impSelect.appendChild(opt);
  }
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.value = m.text;
  textInput.style.cssText = 'flex:1; min-width:180px;';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn active';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', async () => {
    await window.dash.editMemory({ id: m.id, category: catSelect.value, importance: Number(impSelect.value), text: textInput.value });
    await refreshMemory();
  });
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', () => row.replaceWith(renderMemoryItemRow(m, allMemoryFacts)));
  row.appendChild(catSelect);
  row.appendChild(impSelect);
  row.appendChild(textInput);
  row.appendChild(saveBtn);
  row.appendChild(cancelBtn);
  return row;
}

async function refreshMemory() {
  const { facts, graphFacts, edges } = await window.dash.getMemory();
  allMemoryFacts = facts;
  allMemoryGraphFacts = graphFacts ?? facts;
  allMemoryEdges = edges;
  applyMemoryFilters();
}

clearMemoryBtnEl.addEventListener('click', async () => {
  if (!confirm('清空全部记忆？这个操作不能撤销。')) return;
  await window.dash.clearMemory();
  await refreshMemory();
});

const memoryAddCategoryEl = document.getElementById('memoryAddCategory');
const memoryAddImportanceEl = document.getElementById('memoryAddImportance');
const memoryAddTextEl = document.getElementById('memoryAddText');
const memoryAddBtnEl = document.getElementById('memoryAddBtn');

async function submitMemoryAdd() {
  const text = memoryAddTextEl.value.trim();
  if (!text) return;
  const res = await window.dash.addMemory({ category: memoryAddCategoryEl.value, importance: Number(memoryAddImportanceEl.value), text });
  if (!res.ok) {
    alert(res.error || '添加失败');
    return;
  }
  memoryAddTextEl.value = '';
  await refreshMemory();
}
memoryAddBtnEl.addEventListener('click', submitMemoryAdd);
memoryAddTextEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitMemoryAdd();
});

// --- memory graph ("网状视图") -------------------------------------------
// A small self-contained force-directed layout, not a canned library --
// nodes are memory facts (colour = category, radius = importance), edges
// are computed server-side (main.js's computeMemoryEdges) from cosine
// similarity between local Ollama embeddings (nomic-embed-text) of each
// fact's text -- top-K neighbours per node above a similarity threshold,
// the same "relevance" signal generative-agents-style memory systems use
// for retrieval, repurposed here to explain what's actually related.
const MEMORY_CATEGORY_COLOR = {
  身份: '#c44a30',
  项目: '#4a7fc4',
  喜好: '#8a4ac4',
  习惯: '#4ac48a',
  事件: '#c4a04a',
  其他: '#888888',
};

const memoryViewListBtnEl = document.getElementById('memoryViewListBtn');
const memoryViewGraphBtnEl = document.getElementById('memoryViewGraphBtn');
const memoryGraphWrapEl = document.getElementById('memoryGraphWrap');
const memoryGraphCanvasEl = document.getElementById('memoryGraphCanvas');
const memoryGraphDetailEl = document.getElementById('memoryGraphDetail');
const memoryGraphCtx = memoryGraphCanvasEl.getContext('2d');

let graphNodes = [];
let graphEdges = [];
let graphRunning = false;
let graphDrag = null; // { node } while mouse is down on a node
let graphHoverId = null;

function buildGraph(entries, edges = []) {
  graphSettled = false; // new/changed data -- let the layout re-settle
  const desiredHeight = Math.min(900, Math.max(480, 360 + entries.length * 9));
  if (memoryGraphCanvasEl.height !== desiredHeight) {
    memoryGraphCanvasEl.height = desiredHeight;
    graphBgGradient = null;
  }
  const W = memoryGraphCanvasEl.width;
  const H = memoryGraphCanvasEl.height;
  const prevById = new Map(graphNodes.map((n) => [n.id, n]));
  graphNodes = entries.map((m) => {
    const prev = prevById.get(m.id);
    return {
      id: m.id,
      text: m.text,
      category: m.category || '其他',
      importance: m.importance ?? 1,
      groupId: m.groupId,
      source: m.source,
      uncertain: m.uncertain,
      history: m.history,
      memberCount: m.memberCount ?? 1,
      memberIds: m.memberIds ?? [m.id],
      clusterMembers: m.clusterMembers ?? [m],
      ts: m.ts,
      x: prev?.x ?? W / 2 + (Math.random() - 0.5) * 200,
      y: prev?.y ?? H / 2 + (Math.random() - 0.5) * 200,
      vx: 0,
      vy: 0,
    };
  });
  const nodeById = new Map(graphNodes.map((n) => [n.id, n]));
  graphEdges = edges
    .map((e) => [nodeById.get(e.a), nodeById.get(e.b), e.weight])
    .filter(([a, b]) => a && b);
}

function stepGraph() {
  const W = memoryGraphCanvasEl.width;
  const H = memoryGraphCanvasEl.height;
  const REPULSION = 2200;
  const SPRING = 0.02;
  const SPRING_LEN = 90;
  const CENTER = 0.008;
  const DAMPING = 0.85;

  for (let i = 0; i < graphNodes.length; i++) {
    const a = graphNodes[i];
    if (graphDrag?.node === a) continue;
    let fx = 0;
    let fy = 0;
    for (let j = 0; j < graphNodes.length; j++) {
      if (i === j) continue;
      const b = graphNodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distSq = Math.max(100, dx * dx + dy * dy);
      const force = REPULSION / distSq;
      const dist = Math.sqrt(distSq);
      fx += (dx / dist) * force;
      fy += (dy / dist) * force;
    }
    fx += (W / 2 - a.x) * CENTER;
    fy += (H / 2 - a.y) * CENTER;
    a.vx = (a.vx + fx) * DAMPING;
    a.vy = (a.vy + fy) * DAMPING;
  }
  for (const [a, b] of graphEdges) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const force = (dist - SPRING_LEN) * SPRING;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    if (graphDrag?.node !== a) {
      a.vx += fx;
      a.vy += fy;
    }
    if (graphDrag?.node !== b) {
      b.vx -= fx;
      b.vy -= fy;
    }
  }
  const R = 28;
  let totalSpeed = 0;
  for (const n of graphNodes) {
    if (graphDrag?.node === n) continue;
    n.x += n.vx;
    n.y += n.vy;
    n.x = Math.max(R, Math.min(W - R, n.x));
    n.y = Math.max(R, Math.min(H - R, n.y));
    totalSpeed += Math.abs(n.vx) + Math.abs(n.vy);
  }
  return totalSpeed;
}

function nodeRadius(n) {
  return 10 + (n.importance ?? 1) * 4 + Math.min(7, Math.log2(Math.max(1, n.memberCount ?? 1)) * 2);
}

// Text goes in a pill drawn *below* each node, not crammed inside the
// small colored circle -- cramming a label inside a ~25px circle meant it
// was both unreadable and uninformative (this is exactly the complaint a
// real screenshot of the first version surfaced: tiny, illegible labels,
// no legend, no way to tell what a color meant or where a fact came from).
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Cached once -- recreating a canvas-sized gradient every frame is wasted
// work when the canvas itself never resizes.
let graphBgGradient = null;
function graphBackground(ctx, W, H) {
  if (!graphBgGradient) {
    graphBgGradient = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) / 1.3);
    graphBgGradient.addColorStop(0, 'rgba(250, 244, 241, 1)');
    graphBgGradient.addColorStop(1, 'rgba(238, 226, 220, 1)');
  }
  ctx.fillStyle = graphBgGradient;
  ctx.fillRect(0, 0, W, H);
}

function drawGraph() {
  const W = memoryGraphCanvasEl.width;
  const H = memoryGraphCanvasEl.height;
  const ctx = memoryGraphCtx;
  graphBackground(ctx, W, H);

  // Edges: a soft gradient between each pair's own category colours (rather
  // than one flat line colour for everything) so the connection itself
  // hints at what's being related, and weight modulates thickness/opacity
  // so a strong semantic match reads as a stronger line, not the same as a
  // borderline one.
  for (const [a, b, weight] of graphEdges) {
    const w = weight ?? 0.6;
    const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    const colorA = MEMORY_CATEGORY_COLOR[a.category] ?? MEMORY_CATEGORY_COLOR.其他;
    const colorB = MEMORY_CATEGORY_COLOR[b.category] ?? MEMORY_CATEGORY_COLOR.其他;
    grad.addColorStop(0, colorA);
    grad.addColorStop(1, colorB);
    ctx.strokeStyle = grad;
    ctx.globalAlpha = Math.min(0.55, Math.max(0.12, (w - 0.5) * 1.1));
    ctx.lineWidth = Math.min(3, 1 + w * 2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Nodes first (plain circles, no inner text -- illegible at this size),
  // then every label pill in a second pass so labels always draw on top of
  // every circle/edge, never hidden behind a neighboring node.
  for (const n of graphNodes) {
    const r = nodeRadius(n);
    const baseColor = MEMORY_CATEGORY_COLOR[n.category] ?? MEMORY_CATEGORY_COLOR.其他;
    const isHover = n.id === graphHoverId;

    // A gentle glow behind hovered/important nodes rather than a flat
    // silhouette -- reads as "alive", not a static diagram.
    if (isHover || (n.importance ?? 1) >= 3) {
      ctx.save();
      ctx.shadowColor = baseColor;
      ctx.shadowBlur = isHover ? 18 : 10;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = baseColor;
      ctx.fill(); // fully covered by the real fill drawn right after -- only the shadow bleeding past the circle's edge is visible
      ctx.restore();
    }

    const fillGrad = ctx.createRadialGradient(n.x - r * 0.3, n.y - r * 0.35, r * 0.1, n.x, n.y, r);
    fillGrad.addColorStop(0, lightenColor(baseColor, 0.35));
    fillGrad.addColorStop(1, baseColor);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = fillGrad;
    ctx.globalAlpha = isHover ? 1 : 0.92;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = isHover ? 3 : 1.5;
    ctx.strokeStyle = isHover ? 'rgba(40, 16, 20, 0.7)' : 'rgba(255, 255, 255, 0.85)';
    if (n.uncertain) ctx.setLineDash([3, 3]); // dashed ring = a guess, not a confirmed fact
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.font = '11.5px "Microsoft YaHei", sans-serif';
  for (const n of graphNodes) {
    const r = nodeRadius(n);
    const countSuffix = (n.memberCount ?? 1) > 1 ? ` ×${n.memberCount}` : '';
    const baseLabel = n.text.length > 14 ? `${n.text.slice(0, 14)}…` : n.text;
    const label = `${baseLabel}${countSuffix}`;
    const textWidth = ctx.measureText(label).width;
    const boxW = textWidth + 14;
    const boxH = 19;
    const boxX = Math.max(2, Math.min(W - boxW - 2, n.x - boxW / 2));
    const boxY = Math.min(H - boxH - 2, n.y + r + 5);
    ctx.save();
    ctx.shadowColor = 'rgba(40, 16, 20, 0.15)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.97)';
    roundRectPath(ctx, boxX, boxY, boxW, boxH, 5);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(40, 16, 20, 0.15)';
    ctx.lineWidth = 1;
    roundRectPath(ctx, boxX, boxY, boxW, boxH, 5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(40, 16, 20, 0.92)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, boxX + boxW / 2, boxY + boxH / 2 + 1);
  }
}

// Blends a #rrggbb colour toward white by `amount` (0-1) -- used for the
// node fill's highlight stop, avoiding a full second colour palette just
// for gradient endpoints.
function lightenColor(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const mix = (c) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

// Once the layout has settled (total node velocity below the threshold),
// stop running the O(n^2) force simulation every frame -- otherwise nodes
// never fully stop drifting, which makes them small moving targets that
// are genuinely hard to click precisely (a real contributor to "clicking
// a circle does nothing"), on top of burning CPU in an always-running
// rAF loop for a graph nobody's currently dragging.
const GRAPH_SETTLE_SPEED = 0.6;
let graphSettled = false;

function graphLoop() {
  if (!graphRunning) return;
  if (graphDrag || !graphSettled) {
    const totalSpeed = stepGraph();
    if (!graphDrag && totalSpeed < GRAPH_SETTLE_SPEED) graphSettled = true;
  }
  drawGraph();
  requestAnimationFrame(graphLoop);
}

function canvasPointFromEvent(e) {
  const rect = memoryGraphCanvasEl.getBoundingClientRect();
  const scaleX = memoryGraphCanvasEl.width / rect.width;
  const scaleY = memoryGraphCanvasEl.height / rect.height;
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}

// A few px of forgiveness beyond the drawn circle -- nodes are small
// (~20-30px) and constantly drifting from the force layout, so a click
// that's a hair off the visible edge is a real, common miss, not user
// error. The mismatch is invisible (nothing happens, no error) unless the
// hover cursor already changed to 'pointer', so err toward "did you mean
// this node" rather than pixel-perfect precision.
const NODE_HIT_PADDING = 8;

function nodeAtPoint(pt) {
  for (let i = graphNodes.length - 1; i >= 0; i--) {
    const n = graphNodes[i];
    const r = nodeRadius(n) + NODE_HIT_PADDING;
    if ((n.x - pt.x) ** 2 + (n.y - pt.y) ** 2 <= r * r) return n;
  }
  return null;
}

function showGraphDetail(n) {
  memoryGraphDetailEl.style.display = 'block';
  renderGraphDetailView(n);
}

function renderGraphDetailView(n) {
  memoryGraphDetailEl.innerHTML = '';
  const cat = document.createElement('div');
  cat.innerHTML = `<span class="memory-category-badge" style="background:${MEMORY_CATEGORY_COLOR[n.category]};color:#fff;">${escapeHtml(n.category)}</span> 重要性 ${importanceDots(n.importance)}`;
  const text = document.createElement('div');
  text.style.margin = '8px 0';
  text.textContent = n.text;
  const source = document.createElement('div');
  source.className = 'graph-detail-source';
  const groupSize = graphNodes.filter((x) => x.groupId && x.groupId === n.groupId).length;
  const dateStr = n.ts ? new Date(n.ts).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未知时间';
  const SOURCE_VERB = { activity: '从 AI 任务记录里提炼', 'screen-observation': '视觉模型看截图猜', chat: '跟他聊天时记下', manual: '手动添加', reflection: '从相关事实归纳' };
  const sourceVerb = SOURCE_VERB[n.source] ?? SOURCE_VERB.chat;
  const uncertainNote = n.uncertain ? '（不确定，可能不准）' : '';
  source.textContent =
    n.source === 'reflection'
      ? `来源：${dateStr}，${sourceVerb}出的更高层结论`
      : groupSize > 1
        ? `来源：${dateStr}，${sourceVerb}的${uncertainNote}，一次提炼了 ${groupSize} 件事`
        : `来源：${dateStr}，${sourceVerb}的${uncertainNote}`;
  if ((n.memberCount ?? 1) > 1) source.textContent += `；已按语义折叠 ${n.memberCount} 条相关记忆`;
  memoryGraphDetailEl.appendChild(cat);
  memoryGraphDetailEl.appendChild(text);
  memoryGraphDetailEl.appendChild(source);

  if (n.history?.length) {
    const histLabel = document.createElement('div');
    histLabel.style.cssText = 'margin-top:10px; font-size:11px; font-weight:600; color:rgba(40,16,20,0.6);';
    histLabel.textContent = `历史版本（${n.history.length}）`;
    memoryGraphDetailEl.appendChild(histLabel);
    const histPanel = renderMemoryHistoryPanel(n.history);
    histPanel.style.marginLeft = '0';
    memoryGraphDetailEl.appendChild(histPanel);
  }

  if ((n.memberCount ?? 1) > 1) {
    const sourceFacts = (n.clusterMembers ?? []).filter((fact) => fact.id !== n.id);
    const srcLabel = document.createElement('div');
    srcLabel.style.cssText = 'margin-top:10px; font-size:11px; font-weight:600; color:rgba(40,16,20,0.6);';
    srcLabel.textContent = `语义簇中的相关记忆（${sourceFacts.length}）`;
    memoryGraphDetailEl.appendChild(srcLabel);
    const srcPanel = renderReflectionSourcesPanel(sourceFacts);
    srcPanel.style.marginLeft = '0';
    memoryGraphDetailEl.appendChild(srcPanel);
  }

  const editBtn = document.createElement('button');
  editBtn.className = 'btn';
  editBtn.style.cssText = 'margin-top:8px; margin-right:8px;';
  editBtn.textContent = '编辑';
  editBtn.addEventListener('click', () => renderGraphDetailEdit(n));
  const delBtn = document.createElement('button');
  delBtn.className = 'btn';
  delBtn.style.marginTop = '8px';
  delBtn.textContent = '删除';
  delBtn.addEventListener('click', async () => {
    await window.dash.deleteMemory(n.id);
    memoryGraphDetailEl.style.display = 'none';
    await refreshMemoryGraph();
  });
  memoryGraphDetailEl.appendChild(editBtn);
  memoryGraphDetailEl.appendChild(delBtn);
}

function renderGraphDetailEdit(n) {
  memoryGraphDetailEl.innerHTML = '';
  const catSelect = document.createElement('select');
  for (const c of MEMORY_CATEGORIES_LIST) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    if (c === (n.category || '其他')) opt.selected = true;
    catSelect.appendChild(opt);
  }
  const impSelect = document.createElement('select');
  for (const num of [1, 2, 3]) {
    const opt = document.createElement('option');
    opt.value = String(num);
    opt.textContent = `重要性 ${num}`;
    if (num === (n.importance ?? 1)) opt.selected = true;
    impSelect.appendChild(opt);
  }
  const fieldsRow = document.createElement('div');
  fieldsRow.style.cssText = 'display:flex; gap:8px; margin-bottom:8px;';
  fieldsRow.appendChild(catSelect);
  fieldsRow.appendChild(impSelect);

  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.value = n.text;
  textInput.style.cssText = 'width:100%; box-sizing:border-box; margin-bottom:8px; padding:6px 9px; border-radius:6px; border:1px solid rgba(120,24,32,0.3);';

  const btnRow = document.createElement('div');
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn active';
  saveBtn.style.marginRight = '8px';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', async () => {
    const text = textInput.value.trim();
    if (!text) return;
    await window.dash.editMemory({ id: n.id, category: catSelect.value, importance: Number(impSelect.value), text });
    memoryGraphDetailEl.style.display = 'none';
    await refreshMemoryGraph();
  });
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', () => renderGraphDetailView(n));
  btnRow.appendChild(saveBtn);
  btnRow.appendChild(cancelBtn);

  memoryGraphDetailEl.appendChild(fieldsRow);
  memoryGraphDetailEl.appendChild(textInput);
  memoryGraphDetailEl.appendChild(btnRow);
}

function renderMemoryLegend() {
  const legendEl = document.getElementById('memoryLegend');
  if (legendEl.childElementCount) return; // static, build once
  for (const [cat, color] of Object.entries(MEMORY_CATEGORY_COLOR)) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = color;
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(cat));
    legendEl.appendChild(item);
  }
}

// A real mouse click almost never has zero pixel movement between
// mousedown and mouseup -- trackpads and human hand tremor alone produce a
// few px of drift. Flagging *any* movement as "moved" meant a genuine
// click-to-view-detail almost always got misread as a drag and silently
// swallowed (reported: clicking a node shows nothing). Require the
// pointer to actually clear a small threshold before it counts as
// dragging rather than clicking.
const GRAPH_DRAG_THRESHOLD = 5;

memoryGraphCanvasEl.addEventListener('mousedown', (e) => {
  const pt = canvasPointFromEvent(e);
  const n = nodeAtPoint(pt);
  if (n) graphDrag = { node: n, moved: false, startX: pt.x, startY: pt.y };
});
window.addEventListener('mousemove', (e) => {
  if (!graphDrag) return;
  const pt = canvasPointFromEvent(e);
  if (!graphDrag.moved) {
    const dx = pt.x - graphDrag.startX;
    const dy = pt.y - graphDrag.startY;
    if (dx * dx + dy * dy < GRAPH_DRAG_THRESHOLD * GRAPH_DRAG_THRESHOLD) return;
    graphDrag.moved = true;
  }
  graphDrag.node.x = pt.x;
  graphDrag.node.y = pt.y;
  graphDrag.node.vx = 0;
  graphDrag.node.vy = 0;
});
window.addEventListener('mouseup', () => {
  if (graphDrag && !graphDrag.moved) showGraphDetail(graphDrag.node);
  if (graphDrag?.moved) graphSettled = false; // dropped somewhere new -- let it re-settle
  graphDrag = null;
});
memoryGraphCanvasEl.addEventListener('mousemove', (e) => {
  if (graphDrag) return;
  const pt = canvasPointFromEvent(e);
  const n = nodeAtPoint(pt);
  graphHoverId = n?.id ?? null;
  memoryGraphCanvasEl.style.cursor = n ? 'pointer' : 'grab';
});

async function refreshMemoryGraph() {
  const wasRunning = graphRunning;
  graphRunning = true; // set before refreshMemory() so applyMemoryFilters' graphRunning check rebuilds the graph too
  await refreshMemory(); // shared fetch+filter path with the list view -- same filters apply to both
  if (!wasRunning) graphLoop();
}

function showMemoryView(view) {
  memoryViewListBtnEl.classList.toggle('active', view === 'list');
  memoryViewGraphBtnEl.classList.toggle('active', view === 'graph');
  memoryListEl.style.display = view === 'list' ? '' : 'none';
  memoryGraphWrapEl.style.display = view === 'graph' ? 'block' : 'none';
  if (view === 'graph') {
    renderMemoryLegend();
    refreshMemoryGraph();
  } else {
    graphRunning = false;
    applyMemoryFilters();
  }
}
memoryViewListBtnEl.addEventListener('click', () => showMemoryView('list'));
memoryViewGraphBtnEl.addEventListener('click', () => showMemoryView('graph'));

// --- initial load --------------------------------------------------------
(async () => {
  const data = await window.dash.getData();
  renderOverview(data);
  renderSettings(data.settings);
  renderTodos(data.todos);
  renderTasks(data.sessions);
  currentShortcuts = data.shortcuts ?? {};
  renderShortcuts();
  renderPetPacks(data.pets, data.activePet);
  renderActionMapping(data.actionMapping);
})();
