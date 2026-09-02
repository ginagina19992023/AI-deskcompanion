// Dashboard: a normal resizable window, independent of the pet's own tiny
// frameless one. Talks to main.js purely over request/response ("dash.*",
// see dashboard-preload.cjs) rather than push events -- every mutating
// action just re-fetches afterward, which keeps this file simple since the
// window is opened deliberately and briefly, not something that needs to
// track live state the whole time it's open.

import { ATLAS, BASE_ROWS, ROW_FRAME_COUNTS } from './atlas.js';
import { isOverdue, parseTodoInput } from './todos.js';
import { speak } from './voice-tts.js';
import { DASHBOARD_I18N } from './dashboard-i18n-map.js';

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

// The overview tab's Claude usage/task-list numbers are written by an
// external process (Claude Code's own hooks, on their own cadence, not
// this app's) -- confirmed live that a dashboard window left open on this
// tab shows stale percentages next to the terminal's own up-to-date
// statusline until something forces a refetch. showSection() already
// refetches once on *entering* the tab; this keeps it current while
// you're just sitting on it, without needing to click away and back.
const OVERVIEW_POLL_MS = 15000;
let overviewPollTimer = null;
function stopOverviewPolling() {
  if (overviewPollTimer) {
    clearInterval(overviewPollTimer);
    overviewPollTimer = null;
  }
}

function showSection(name) {
  for (const btn of navBtns) btn.classList.toggle('active', btn.dataset.section === name);
  for (const [key, el] of Object.entries(sections)) el.classList.toggle('active', key === name);
  stopOverviewPolling();
  if (name === 'todos') {
    refreshTodosAndTasks();
    refreshOutlookStatus();
  }
  if (name === 'tasks') refreshTodosAndTasks();
  if (name === 'history') loadHistory();
  if (name === 'overview') {
    refreshOverview();
    overviewPollTimer = setInterval(refreshOverview, OVERVIEW_POLL_MS);
  }
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
  if (name === 'vocal') ensureVocalVoicesLoaded();
}

// --- vocal / singing --------------------------------------------------
// Reuses MiMo's regular preset-voice list (same IPC call the voice section
// already uses) -- singing mode is the same voices, just with a (唱歌)
// style tag prepended server-side by main.js's pet:synthesize-song
// handler, so there's no separate "singing voice list" to fetch.
let vocalVoicesLoaded = false;
async function ensureVocalVoicesLoaded() {
  if (vocalVoicesLoaded) return;
  vocalVoicesLoaded = true;
  const vocalVoiceSelectEl = document.getElementById('vocalVoiceSelect');
  if (!vocalVoiceSelectEl) return;
  try {
    const { chinese, english } = await window.dash.getMimoVoices();
    const allVoices = [...chinese, ...english.filter((v) => v.id !== 'mimo_default')];
    for (const v of allVoices) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.label;
      vocalVoiceSelectEl.appendChild(opt);
    }
  } catch (err) {
    console.error('Failed to load vocal voices:', err);
  }
}

const vocalLyricsInputEl = document.getElementById('vocalLyricsInput');
const vocalSampleSelectEl = document.getElementById('vocalSampleSelect');
const vocalVoiceSelectEl = document.getElementById('vocalVoiceSelect');
const vocalSingBtnEl = document.getElementById('vocalSingBtn');
const vocalStatusEl = document.getElementById('vocalStatus');

if (vocalSampleSelectEl) {
  vocalSampleSelectEl.addEventListener('change', (e) => {
    if (e.target.value) vocalLyricsInputEl.value = e.target.value;
  });
}

if (vocalSingBtnEl) {
  vocalSingBtnEl.addEventListener('click', async () => {
    const lyrics = vocalLyricsInputEl.value.trim();
    if (!lyrics) {
      vocalStatusEl.style.color = '#c4304a';
      vocalStatusEl.textContent = '✗ 先填歌词或选一个样例';
      return;
    }
    vocalSingBtnEl.disabled = true;
    vocalStatusEl.style.color = '';
    vocalStatusEl.textContent = '演唱合成中…（比普通语音耗时更长，可能要 10-20 秒）';
    try {
      const result = await window.dash.synthesizeSong(lyrics, vocalVoiceSelectEl.value || undefined);
      if (result.fileUrl) {
        const audio = new Audio(result.fileUrl);
        audio.play();
        vocalStatusEl.style.color = '#2e8b45';
        vocalStatusEl.textContent = '✓ 播放中…';
        audio.onended = () => {
          vocalStatusEl.textContent = '';
        };
      } else {
        vocalStatusEl.style.color = '#c4304a';
        vocalStatusEl.textContent = `✗ ${result.error || '合成失败'}`;
      }
    } catch (err) {
      vocalStatusEl.style.color = '#c4304a';
      vocalStatusEl.textContent = `✗ 出错: ${err.message}`;
    } finally {
      vocalSingBtnEl.disabled = false;
    }
  });
}

// Singing transcription: extract lyrics and pitch from audio
const vocalAudioInputEl = document.getElementById('vocalAudioInput');
const vocalTranscribeBtnEl = document.getElementById('vocalTranscribeBtn');
const vocalTranscribeStatusEl = document.getElementById('vocalTranscribeStatus');
const vocalTranscribeResultsEl = document.getElementById('vocalTranscribeResults');
const vocalTranscribedLyricsEl = document.getElementById('vocalTranscribedLyrics');
const vocalTranscribedPitchEl = document.getElementById('vocalTranscribedPitch');
const vocalUseTranscribedBtnEl = document.getElementById('vocalUseTranscribedBtn');
const vocalTestSongSelectEl = document.getElementById('vocalTestSongSelect');
const vocalTestSongPlayRowEl = document.getElementById('vocalTestSongPlayRow');
const vocalTestSongAudioEl = document.getElementById('vocalTestSongAudio');
const vocalUseTestSongBtnEl = document.getElementById('vocalUseTestSongBtn');

// Track the path to actually transcribe: either an uploaded file (resolved
// via webUtils, since Electron 32+ dropped File.path) or a picked built-in
// test song. Whichever was chosen most recently wins.
let vocalSelectedAudioPath = '';

async function loadTestSongs() {
  if (!vocalTestSongSelectEl) return;
  let songs = [];
  try {
    songs = await window.dash.listTestSongs();
  } catch (err) {
    // window.dash.listTestSongs is added by a preload/main.js change that
    // only takes effect after a full app restart (not just a window
    // reload) -- surface that clearly instead of leaving a silently
    // unpopulated dropdown that looks like "there's nothing to pick".
    vocalTestSongSelectEl.replaceChildren();
    const errOpt = document.createElement('option');
    errOpt.value = '';
    errOpt.textContent = '（功能未生效，请完全重启应用后再试）';
    vocalTestSongSelectEl.appendChild(errOpt);
    return;
  }
  vocalTestSongSelectEl.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = songs.length ? '（先选一首，或者自己上传文件）' : '（data/test-songs 里还没有音频，见下方指南）';
  vocalTestSongSelectEl.appendChild(placeholder);
  for (const song of songs) {
    const opt = document.createElement('option');
    opt.value = song.url;
    opt.dataset.path = song.path;
    opt.textContent = song.name;
    vocalTestSongSelectEl.appendChild(opt);
  }
}

if (vocalTestSongSelectEl) {
  loadTestSongs();
  vocalTestSongSelectEl.addEventListener('change', () => {
    const opt = vocalTestSongSelectEl.selectedOptions[0];
    if (!opt || !opt.value) {
      vocalTestSongPlayRowEl.style.display = 'none';
      vocalTestSongAudioEl.removeAttribute('src');
      return;
    }
    vocalTestSongAudioEl.src = opt.value;
    vocalTestSongPlayRowEl.style.display = '';
    vocalSelectedAudioPath = opt.dataset.path;
    vocalAudioInputEl.value = '';
  });
}

if (vocalUseTestSongBtnEl) {
  vocalUseTestSongBtnEl.addEventListener('click', () => {
    if (!vocalSelectedAudioPath) return;
    vocalTranscribeBtnEl.click();
  });
}

if (vocalAudioInputEl) {
  vocalAudioInputEl.addEventListener('change', () => {
    if (vocalAudioInputEl.files.length) {
      vocalSelectedAudioPath = window.dash.getPathForFile(vocalAudioInputEl.files[0]);
      vocalTestSongSelectEl.value = '';
      vocalTestSongPlayRowEl.style.display = 'none';
    }
  });
}

if (vocalTranscribeBtnEl) {
  vocalTranscribeBtnEl.addEventListener('click', async () => {
    if (!vocalSelectedAudioPath) {
      vocalTranscribeStatusEl.style.color = '#c4304a';
      vocalTranscribeStatusEl.textContent = '✗ 先选一首内置测试歌曲，或者自己上传一个音频文件';
      return;
    }

    vocalTranscribeBtnEl.disabled = true;
    vocalTranscribeStatusEl.style.color = '';
    vocalTranscribeStatusEl.textContent = '识歌中…（第一次需要下载 Whisper 模型，可能要几分钟）';
    vocalTranscribeResultsEl.style.display = 'none';

    try {
      const result = await window.dash.transcribeSinging(vocalSelectedAudioPath);
      if (result.error) {
        vocalTranscribeStatusEl.style.color = '#c4304a';
        vocalTranscribeStatusEl.textContent = `✗ ${result.error}`;
        return;
      }

      const lyricsText = result.lyrics?.text?.trim() || '';
      vocalTranscribedLyricsEl.value = lyricsText || '（没有识别出歌词）';

      const midiNotes = result.pitch?.midi_notes || [];
      const voicedNotes = midiNotes.filter((n) => n != null).map((n) => Math.round(n));
      vocalTranscribedPitchEl.textContent = voicedNotes.length
        ? voicedNotes.join(' ')
        : '（没有检测到有效音高）';

      vocalTranscribeResultsEl.style.display = '';
      vocalTranscribeStatusEl.style.color = '';
      vocalTranscribeStatusEl.textContent = '✓ 识别完成';
    } catch (err) {
      vocalTranscribeStatusEl.style.color = '#c4304a';
      vocalTranscribeStatusEl.textContent = `✗ 出错: ${err.message}`;
    } finally {
      vocalTranscribeBtnEl.disabled = false;
    }
  });

  if (vocalUseTranscribedBtnEl) {
    vocalUseTranscribedBtnEl.addEventListener('click', () => {
      const lyrics = vocalTranscribedLyricsEl.value.trim();
      if (lyrics) {
        vocalLyricsInputEl.value = lyrics;
        vocalStatusEl.textContent = '✓ 歌词已填入，点"唱一下"开始合成';
      }
    });
  }
}

// Vocal separation (人声分离): split the same selected/uploaded audio into
// a vocals-only track and an instrumental-only backing track via Demucs.
const vocalExtractBtnEl = document.getElementById('vocalExtractBtn');
const vocalExtractStatusEl = document.getElementById('vocalExtractStatus');
const vocalExtractResultsEl = document.getElementById('vocalExtractResults');
const vocalExtractedVocalsAudioEl = document.getElementById('vocalExtractedVocalsAudio');
const vocalExtractedInstrumentalAudioEl = document.getElementById('vocalExtractedInstrumentalAudio');
// The voice-conversion step below needs a real file path (Demucs's own
// output), not the file:// URL used just for the <audio> preview element.
let lastExtractedVocalsPath = '';
let lastExtractedInstrumentalPath = '';

// 流程进度追踪和更新
const vocalWorkflowSteps = ['vocalWorkflowStep1', 'vocalWorkflowStep2', 'vocalWorkflowStep3'];
function updateVocalWorkflow() {
  const steps = vocalWorkflowSteps.map(id => document.getElementById(id));
  const voiceGenCompleteBtnEl = document.getElementById('voiceGenCompleteBtn');

  // ①识歌：可选，不强制完成
  if (vocalSelectedAudioPath) {
    steps[0]?.classList.add('done');
  } else {
    steps[0]?.classList.remove('done');
  }
  // ②拆伴奏：有提取结果才算完成
  if (lastExtractedVocalsPath && lastExtractedInstrumentalPath) {
    steps[1]?.classList.add('done');
  } else {
    steps[1]?.classList.remove('done');
  }
  // ③换声：本次会话刚转换完，或者从"歌曲库"里选中了一条换声记录，都算有结果可用
  const hasConvertResult = voiceConvertResultsEl && voiceConvertResultsEl.style.display !== 'none';
  const hasSelectedFromLibrary = !!selectedConversionEntry;
  if (hasConvertResult || hasSelectedFromLibrary) {
    steps[2]?.classList.add('done');
    if (voiceGenCompleteBtnEl) {
      voiceGenCompleteBtnEl.style.display = '';
    }
  } else {
    steps[2]?.classList.remove('done');
    if (voiceGenCompleteBtnEl) {
      voiceGenCompleteBtnEl.style.display = 'none';
    }
  }
}

if (vocalExtractBtnEl) {
  vocalExtractBtnEl.addEventListener('click', async () => {
    if (!vocalSelectedAudioPath) {
      vocalExtractStatusEl.style.color = '#c4304a';
      vocalExtractStatusEl.textContent = '✗ 先选一首内置测试歌曲，或者自己上传一个音频文件';
      return;
    }

    vocalExtractBtnEl.disabled = true;
    vocalExtractStatusEl.style.color = '';
    vocalExtractResultsEl.style.display = 'none';

    // Same reasoning as the 换声 timer below: this can run for several
    // minutes on CPU (longer still on a first run, downloading the Demucs
    // model), and a static message gives no way to tell "still working"
    // from "stuck".
    const extractStartedAt = Date.now();
    const tickExtractStatus = () => {
      const elapsed = Math.round((Date.now() - extractStartedAt) / 1000);
      vocalExtractStatusEl.textContent = `分离中…（第一次需要下载 Demucs 模型，CPU 处理可能要几分钟，已用时 ${elapsed}s）`;
    };
    tickExtractStatus();
    const extractTimer = setInterval(tickExtractStatus, 1000);

    try {
      const result = await window.dash.extractInstrumental(vocalSelectedAudioPath);
      if (result.error) {
        vocalExtractStatusEl.style.color = '#c4304a';
        vocalExtractStatusEl.textContent = `✗ ${result.error}`;
        return;
      }

      vocalExtractedVocalsAudioEl.src = result.vocalsUrl || '';
      vocalExtractedInstrumentalAudioEl.src = result.instrumentalUrl || '';
      lastExtractedVocalsPath = result.vocals || '';
      lastExtractedInstrumentalPath = result.instrumental || '';
      vocalExtractResultsEl.style.display = '';
      vocalExtractStatusEl.style.color = '';
      const totalSeconds = Math.round((Date.now() - extractStartedAt) / 1000);
      vocalExtractStatusEl.textContent = `✓ 分离完成（用时 ${totalSeconds}s）`;
      updateVocalWorkflow();
      loadVocalHistory();
    } catch (err) {
      vocalExtractStatusEl.style.color = '#c4304a';
      vocalExtractStatusEl.textContent = `✗ 出错: ${err.message}`;
    } finally {
      clearInterval(extractTimer);
      vocalExtractBtnEl.disabled = false;
    }
  });
}

// Voice conversion (换声) -- deliberately generic on which model file is
// picked (see dashboard:pick-voice-model / dashboard:convert-voice in
// main.js): this UI never hardcodes a voice, just points at whatever .pth
// the user has downloaded or trained, so trying a different voice is a
// re-pick, not a code change.
const pickVoiceModelBtnEl = document.getElementById('pickVoiceModelBtn');
const voiceModelPathDisplayEl = document.getElementById('voiceModelPathDisplay');
const voicePitchShiftEl = document.getElementById('voicePitchShift');
const voiceIndexRateRowEl = document.getElementById('voiceIndexRateRow');
const voiceIndexRateEl = document.getElementById('voiceIndexRate');
const voiceIndexRateValueEl = document.getElementById('voiceIndexRateValue');
const voiceConvertBtnEl = document.getElementById('voiceConvertBtn');
const voiceConvertStatusEl = document.getElementById('voiceConvertStatus');
const voiceConvertResultsEl = document.getElementById('voiceConvertResults');
const voiceConvertedAudioEl = document.getElementById('voiceConvertedAudio');
const voiceGenCompleteBtnEl = document.getElementById('voiceGenCompleteBtn');
const voiceCompleteAudioSectionEl = document.getElementById('voiceCompleteAudioSection');
const voiceFullPipelinePanelEl = document.getElementById('voiceFullPipelinePanel');
const voiceFullPipelineSongSelectEl = document.getElementById('voiceFullPipelineSongSelect');
const voiceFullPipelineModelEl = document.getElementById('voiceFullPipelineModel');
const voiceFullPipelinePickModelEl = document.getElementById('voiceFullPipelinePickModel');
const voiceFullPipelinePitchEl = document.getElementById('voiceFullPipelinePitch');
const voiceFullPipelineIndexRateEl = document.getElementById('voiceFullPipelineIndexRate');
const voiceFullPipelineIndexRateValueEl = document.getElementById('voiceFullPipelineIndexRateValue');
const voiceFullPipelineBtnEl = document.getElementById('voiceFullPipelineBtn');
const voiceFullPipelineStatusEl = document.getElementById('voiceFullPipelineStatus');
const voiceCompleteAudioEl = document.getElementById('voiceCompleteAudio');
const voiceEnhanceBtnEl = document.getElementById('voiceEnhanceBtn');
const voiceEnhanceStrengthEl = document.getElementById('voiceEnhanceStrength');
const voiceEnhanceStrengthValueEl = document.getElementById('voiceEnhanceStrengthValue');
const voiceEnhanceStatusEl = document.getElementById('voiceEnhanceStatus');
let lastConvertedVocalsPath = '';
const voiceModelCardGridEl = document.getElementById('voiceModelCardGrid');
const voiceModelSaveRowEl = document.getElementById('voiceModelSaveRow');
const voiceModelSaveNameEl = document.getElementById('voiceModelSaveName');
const voiceModelSaveBtnEl = document.getElementById('voiceModelSaveBtn');
let selectedVoiceModelPath = '';
let selectedVoiceIndexPath = '';
let selectedSavedVoiceModelId = '';
let savedVoiceModels = [];
let defaultVoiceModelId = '';

function basenameOf(p) {
  return String(p ?? '').split(/[\\/]/).pop();
}

// hf-rvc has no faiss dependency at all -- .index-based retrieval only
// exists because tools/voice-convert.py loads it separately (see
// _retrieve_blend), so the rate slider is meaningless with no .index
// selected and stays hidden rather than sitting there doing nothing.
function updateIndexRateVisibility() {
  if (voiceIndexRateRowEl) voiceIndexRateRowEl.style.display = selectedVoiceIndexPath ? '' : 'none';
}

if (voiceIndexRateEl && voiceIndexRateValueEl) {
  voiceIndexRateEl.addEventListener('input', () => {
    voiceIndexRateValueEl.textContent = Number(voiceIndexRateEl.value).toFixed(2);
  });
}

function selectSavedVoiceModel(id) {
  const model = savedVoiceModels.find((m) => m.id === id);
  if (!model) return;
  selectedSavedVoiceModelId = id;
  selectedVoiceModelPath = model.modelPath;
  selectedVoiceIndexPath = model.indexPath || '';
  voiceModelPathDisplayEl.value = model.modelPath;
  voiceModelSaveRowEl.style.display = 'none'; // already-saved model doesn't need re-saving
  updateIndexRateVisibility();
  renderSavedVoiceModels();
}

// Card grid, not a <select> -- clicking anywhere on a card selects it
// (matches the .pet-card pattern used for character packs); the three
// per-card buttons stopPropagation so clicking them doesn't *also* select
// the card underneath.
function renderSavedVoiceModels() {
  if (!voiceModelCardGridEl) return;
  voiceModelCardGridEl.replaceChildren();
  if (!savedVoiceModels.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.style.margin = '0';
    empty.textContent = '还没保存过音色——下面选一个 .pth 文件，转换成功后会提示保存';
    voiceModelCardGridEl.appendChild(empty);
    return;
  }
  for (const m of savedVoiceModels) {
    const isDefault = m.id === defaultVoiceModelId;
    const card = document.createElement('div');
    card.className = 'card voice-card' + (m.id === selectedSavedVoiceModelId ? ' selected' : '');
    card.innerHTML =
      `<div class="voice-name">${escapeHtml(m.name)}${isDefault ? ' ⭐' : ''}</div>` +
      `<div class="voice-path">${escapeHtml(basenameOf(m.modelPath))}</div>` +
      (m.indexPath ? '<div class="voice-badges"><span class="voice-badge">含 .index</span></div>' : '');
    card.addEventListener('click', () => selectSavedVoiceModel(m.id));

    const actions = document.createElement('div');
    actions.className = 'voice-actions';

    const defaultBtn = document.createElement('button');
    defaultBtn.className = 'btn';
    defaultBtn.textContent = isDefault ? '已是默认' : '设为默认';
    defaultBtn.disabled = isDefault;
    defaultBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const result = await window.dash.setDefaultVoiceModel(m.id);
      if (result.ok) {
        defaultVoiceModelId = result.defaultVoiceModelId;
        renderSavedVoiceModels();
      }
    });
    actions.appendChild(defaultBtn);

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn';
    renameBtn.textContent = '重命名';
    renameBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = prompt('给这个音色改个名字', m.name);
      if (name === null) return; // cancelled
      const result = await window.dash.renameVoiceModel(m.id, name);
      if (result.ok) {
        savedVoiceModels = result.voiceModels;
        renderSavedVoiceModels();
      } else {
        alert(result.error || '重命名失败');
      }
    });
    actions.appendChild(renameBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn';
    deleteBtn.textContent = '删除';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`删除音色「${m.name}」？（不会删掉原始 .pth 文件，只是从列表移除）`)) return;
      const result = await window.dash.deleteVoiceModel(m.id);
      if (result.ok) {
        savedVoiceModels = result.voiceModels;
        defaultVoiceModelId = result.defaultVoiceModelId;
        if (selectedSavedVoiceModelId === m.id) selectedSavedVoiceModelId = '';
        renderSavedVoiceModels();
      }
    });
    actions.appendChild(deleteBtn);

    card.appendChild(actions);
    voiceModelCardGridEl.appendChild(card);
  }
}

async function loadSavedVoiceModels() {
  const data = await window.dash.getData();
  savedVoiceModels = data.settings?.voiceModels ?? [];
  defaultVoiceModelId = data.settings?.defaultVoiceModelId ?? '';
  // Auto-select the default model on load so换声 is one click, not a
  // re-browse every time the dashboard reopens.
  const def = savedVoiceModels.find((m) => m.id === defaultVoiceModelId);
  if (def) {
    selectedSavedVoiceModelId = def.id;
    selectedVoiceModelPath = def.modelPath;
    selectedVoiceIndexPath = def.indexPath || '';
    voiceModelPathDisplayEl.value = def.modelPath;
    updateIndexRateVisibility();
  }
  renderSavedVoiceModels();
}
if (voiceModelCardGridEl) loadSavedVoiceModels();

if (voiceModelSaveBtnEl) {
  voiceModelSaveBtnEl.addEventListener('click', async () => {
    const name = voiceModelSaveNameEl.value.trim();
    if (!name) return;
    if (!selectedVoiceModelPath) return;
    try {
      const result = await window.dash.saveVoiceModel({ name, modelPath: selectedVoiceModelPath, indexPath: selectedVoiceIndexPath });
      if (result.ok) {
        savedVoiceModels = result.voiceModels;
        defaultVoiceModelId = result.defaultVoiceModelId;
        selectedSavedVoiceModelId = result.id;
        renderSavedVoiceModels();
        voiceModelSaveRowEl.style.display = 'none';
        voiceModelSaveNameEl.value = '';
      } else {
        alert(result.error || '保存失败');
      }
    } catch (err) {
      // window.dash.saveVoiceModel is registered by a main.js change that
      // only takes effect after a full app restart (not a window reload) --
      // without this catch, an unregistered handler throws silently here
      // and the click looks like it did nothing at all.
      alert('保存失败，可能是应用还没完全重启：' + err.message);
    }
  });
}

if (voiceGenCompleteBtnEl) {
  voiceGenCompleteBtnEl.addEventListener('click', async () => {
    // 优先使用从库里选中的换声记录，没选就用最后生成的
    let vocalsPath, instrumentalPath;

    if (selectedConversionEntry) {
      vocalsPath = selectedConversionEntry.outputPath;
      // 换声记录自带的伴奏优先；没有（老记录）就用手动补选的那条伴奏轨
      instrumentalPath = selectedConversionEntry.instrumentalPath || selectedInstrumentalEntry?.instrumentalPath;
    } else {
      vocalsPath = lastConvertedVocalsPath;
      instrumentalPath = selectedInstrumentalEntry?.instrumentalPath || lastExtractedInstrumentalPath;
    }

    if (!vocalsPath || !instrumentalPath) {
      alert('缺少必要的人声或伴奏文件。\n请从下面"🎵 歌曲库"中选一条换声记录（如果它没自带伴奏，还需额外选一条"分离"记录的伴奏轨），或者直接完成上面的③换声步骤');
      return;
    }
    voiceGenCompleteBtnEl.disabled = true;
    voiceGenCompleteBtnEl.textContent = '生成中…';
    try {
      const result = await window.dash.mixTracks({
        vocalsPath,
        instrumentalPath,
      });
      if (result.error) {
        alert(`生成失败: ${result.error}`);
        return;
      }
      voiceCompleteAudioEl.src = result.outputUrl || '';
      voiceCompleteAudioSectionEl.style.display = '';
      // 清空选中状态（混音成功后）
      selectedConversionEntry = null;
      selectedInstrumentalEntry = null;
      loadVocalHistory(); // 刷新卡片UI
    } catch (err) {
      alert(`生成出错: ${err.message}`);
    } finally {
      voiceGenCompleteBtnEl.disabled = false;
      voiceGenCompleteBtnEl.textContent = '✨ 一键生成完整翻唱';
    }
  });
}

if (voiceEnhanceStrengthEl && voiceEnhanceStrengthValueEl) {
  voiceEnhanceStrengthEl.addEventListener('input', () => {
    voiceEnhanceStrengthValueEl.textContent = Number(voiceEnhanceStrengthEl.value).toFixed(1);
  });
}

if (voiceEnhanceBtnEl) {
  voiceEnhanceBtnEl.addEventListener('click', async () => {
    if (!lastConvertedVocalsPath) {
      alert('先完成上面③「换声」，才有人声可以增强');
      return;
    }
    voiceEnhanceBtnEl.disabled = true;
    voiceEnhanceBtnEl.textContent = '处理中…';
    voiceEnhanceStatusEl.textContent = '';
    try {
      const result = await window.dash.enhanceVocal({
        inputPath: lastConvertedVocalsPath,
        strength: Number(voiceEnhanceStrengthEl.value) || 0.6,
      });
      if (result.error) {
        voiceEnhanceStatusEl.style.color = '#c4304a';
        voiceEnhanceStatusEl.textContent = `✗ ${result.error}`;
        return;
      }
      // 增强结果替换主播放器里播放的内容，方便直接对比听感；原始版本仍保留在歌曲库里
      voiceConvertedAudioEl.src = result.outputUrl || '';
      lastConvertedVocalsPath = result.output || lastConvertedVocalsPath;
      voiceEnhanceStatusEl.style.color = '';
      voiceEnhanceStatusEl.textContent = '✓ 已增强，播放器已更新为增强版';
      loadVocalHistory();
    } catch (err) {
      voiceEnhanceStatusEl.style.color = '#c4304a';
      voiceEnhanceStatusEl.textContent = `✗ 出错: ${err.message}`;
    } finally {
      voiceEnhanceBtnEl.disabled = false;
      voiceEnhanceBtnEl.textContent = '🪄 清晰度增强';
    }
  });
}

if (pickVoiceModelBtnEl) {
  pickVoiceModelBtnEl.addEventListener('click', async () => {
    const result = await window.dash.pickVoiceModel();
    if (!result.ok) return;
    selectedVoiceModelPath = result.modelPath;
    selectedVoiceIndexPath = result.indexPath || '';
    selectedSavedVoiceModelId = ''; // a freshly-picked file isn't any saved card
    voiceModelPathDisplayEl.value = result.modelPath;
    // Only offer to save a freshly-picked file -- one already loaded from
    // the saved library doesn't need re-saving.
    voiceModelSaveRowEl.style.display = '';
    updateIndexRateVisibility();
    renderSavedVoiceModels();
  });
}

if (voiceConvertBtnEl) {
  voiceConvertBtnEl.addEventListener('click', async () => {
    if (!lastExtractedVocalsPath) {
      voiceConvertStatusEl.style.color = '#c4304a';
      voiceConvertStatusEl.textContent = '✗ 先做上面②「拆出人声与伴奏」，或去下面"🎵 歌曲库"里点一条分离记录的"用这条轨换声"';
      return;
    }
    if (!selectedVoiceModelPath) {
      voiceConvertStatusEl.style.color = '#c4304a';
      voiceConvertStatusEl.textContent = '✗ 先选一个 RVC 模型文件（.pth）';
      return;
    }

    voiceConvertBtnEl.disabled = true;
    voiceConvertStatusEl.style.color = '';
    voiceConvertResultsEl.style.display = 'none';

    // A bad noise draw inside the vocoder (see tools/voice-convert.py's
    // retry loop) occasionally costs a few extra inference passes, so
    // total time isn't fixed run to run -- a static "请耐心等待" gives no
    // signal that it's still alive versus stuck. A ticking elapsed counter
    // costs nothing and answers "is this still working?" at a glance.
    const convertStartedAt = Date.now();
    const tickConvertStatus = () => {
      const elapsed = Math.round((Date.now() - convertStartedAt) / 1000);
      voiceConvertStatusEl.textContent = `换声中…（CPU 推理，已用时 ${elapsed}s）`;
    };
    tickConvertStatus();
    const convertTimer = setInterval(tickConvertStatus, 1000);

    try {
      const result = await window.dash.convertVoice({
        audioPath: lastExtractedVocalsPath,
        modelPath: selectedVoiceModelPath,
        indexPath: selectedVoiceIndexPath,
        pitchShift: Number(voicePitchShiftEl.value) || 0,
        indexRate: selectedVoiceIndexPath ? Number(voiceIndexRateEl.value) : undefined,
        instrumentalPath: lastExtractedInstrumentalPath, // 用于记录此换声对应的伴奏
      });
      if (result.error) {
        voiceConvertStatusEl.style.color = '#c4304a';
        voiceConvertStatusEl.textContent = `✗ ${result.error}`;
        return;
      }

      voiceConvertedAudioEl.src = result.outputUrl || '';
      lastConvertedVocalsPath = result.output || '';
      voiceCompleteAudioSectionEl.style.display = 'none';
      voiceConvertResultsEl.style.display = '';
      voiceConvertStatusEl.style.color = '';
      const totalSeconds = Math.round((Date.now() - convertStartedAt) / 1000);
      voiceConvertStatusEl.textContent = `✓ 换声完成（用时 ${totalSeconds}s）`;
      updateVocalWorkflow();
      loadVocalHistory();
    } catch (err) {
      voiceConvertStatusEl.style.color = '#c4304a';
      voiceConvertStatusEl.textContent = `✗ 出错: ${err.message}`;
    } finally {
      clearInterval(convertTimer);
      voiceConvertBtnEl.disabled = false;
    }
  });
}

// 生成记录 (生成历史) -- past separations/conversions, so replaying one is
// a click on an already-rendered <audio> instead of re-running Demucs/RVC.
const vocalHistoryListEl = document.getElementById('vocalHistoryBySong');

// 歌曲库中选中的换声记录（用于一键生成混音）
let selectedConversionEntry = null;
// 补充选项：旧的换声记录没存自己的伴奏路径，允许手动指定一条"分离"记录的伴奏来配对
let selectedInstrumentalEntry = null;

function vocalHistoryRow(entry) {
  const card = document.createElement('div');
  card.className = 'card song-card';
  card.id = `vocal-history-${entry.id}`;

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
  header.style.marginBottom = '6px';

  const title = document.createElement('div');
  title.className = 'song-title';
  if (entry.type === 'separation') {
    title.textContent = `🎚️ 分离 · ${entry.sourceName ?? ''}`;
  } else if (entry.type === 'mix') {
    title.textContent = '✨ 完整翻唱（人声+伴奏）';
  } else if (entry.type === 'enhance') {
    title.textContent = `🪄 清晰度增强（强度${entry.strength ?? 0.6}）`;
  } else {
    title.textContent = `🎙️ 换声 · ${entry.modelName ?? ''}${entry.pitchShift ? ` (变调${entry.pitchShift > 0 ? '+' : ''}${entry.pitchShift})` : ''}${entry.indexPath ? ` (相似度${entry.indexRate ?? 0.75})` : ''}`;
  }
  header.appendChild(title);

  // 类型标签
  const typeTagText = { separation: '伴奏', conversion: '人声', mix: '成品', enhance: '增强' }[entry.type] ?? entry.type;
  const typeTagColor = { separation: 'rgba(100, 150, 200, 0.4)', conversion: 'rgba(150, 100, 200, 0.4)', mix: 'rgba(100, 200, 100, 0.4)', enhance: 'rgba(230, 180, 60, 0.4)' }[entry.type] ?? 'rgba(150, 150, 150, 0.4)';
  const typeTag = document.createElement('div');
  typeTag.style.fontSize = '12px';
  typeTag.style.padding = '2px 8px';
  typeTag.style.borderRadius = '4px';
  typeTag.style.backgroundColor = typeTagColor;
  typeTag.style.color = 'var(--theme-text)';
  typeTag.textContent = typeTagText;
  header.appendChild(typeTag);

  card.appendChild(header);

  if (entry.createdAt) {
    const time = document.createElement('div');
    time.className = 'song-time';
    time.textContent = new Date(entry.createdAt).toLocaleString('zh-CN', { hour12: false });
    card.appendChild(time);
  }

  if (entry.type === 'separation') {
    const vocalsRow = document.createElement('div');
    vocalsRow.style.display = 'flex';
    vocalsRow.style.justifyContent = 'space-between';
    vocalsRow.style.alignItems = 'center';
    const vocalsLabel = document.createElement('div');
    vocalsLabel.style.fontSize = '11px';
    vocalsLabel.style.opacity = '0.7';
    vocalsLabel.textContent = '人声轨（原唱）';
    vocalsRow.appendChild(vocalsLabel);

    const useForConvertBtn = document.createElement('button');
    useForConvertBtn.className = 'btn';
    useForConvertBtn.textContent = lastExtractedVocalsPath === entry.vocalsPath ? '✓ 已选中' : '用这条轨换声';
    useForConvertBtn.title = '把这条人声轨设为③换声的输入，不用重新跑一次②拆分离';
    useForConvertBtn.style.fontSize = '12px';
    useForConvertBtn.style.padding = '2px 8px';
    if (lastExtractedVocalsPath === entry.vocalsPath) {
      useForConvertBtn.style.backgroundColor = 'rgba(100, 200, 100, 0.5)';
    }
    useForConvertBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      lastExtractedVocalsPath = entry.vocalsPath || '';
      lastExtractedInstrumentalPath = entry.instrumentalPath || '';
      updateVocalWorkflow();
      loadVocalHistory();
      voiceConvertBtnEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    vocalsRow.appendChild(useForConvertBtn);
    card.appendChild(vocalsRow);

    const vocalsAudio = document.createElement('audio');
    vocalsAudio.controls = true;
    vocalsAudio.src = entry.vocalsUrl;
    card.appendChild(vocalsAudio);

    const instRow = document.createElement('div');
    instRow.style.display = 'flex';
    instRow.style.justifyContent = 'space-between';
    instRow.style.alignItems = 'center';
    instRow.style.marginTop = '6px';
    const instLabel = document.createElement('div');
    instLabel.style.fontSize = '11px';
    instLabel.style.opacity = '0.7';
    instLabel.textContent = '伴奏轨';
    instRow.appendChild(instLabel);

    const selectInstBtn = document.createElement('button');
    selectInstBtn.className = 'btn';
    selectInstBtn.textContent = selectedInstrumentalEntry?.id === entry.id ? '✓ 已选中' : '用这条伴奏';
    selectInstBtn.style.fontSize = '12px';
    selectInstBtn.style.padding = '2px 8px';
    if (selectedInstrumentalEntry?.id === entry.id) {
      selectInstBtn.style.backgroundColor = 'rgba(100, 200, 100, 0.5)';
    }
    selectInstBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedInstrumentalEntry = entry;
      loadVocalHistory();
    });
    instRow.appendChild(selectInstBtn);
    card.appendChild(instRow);

    const instAudio = document.createElement('audio');
    instAudio.controls = true;
    instAudio.src = entry.instrumentalUrl;
    card.appendChild(instAudio);
  } else {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = entry.outputUrl;
    card.appendChild(audio);
  }

  const actions = document.createElement('div');
  actions.className = 'song-actions';

  if (entry.type === 'conversion' || entry.type === 'enhance') {
    const selectBtn = document.createElement('button');
    selectBtn.className = 'btn';
    selectBtn.textContent = '✓ 选择此版本';
    selectBtn.style.fontSize = '12px';
    selectBtn.style.padding = '4px 8px';

    selectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedConversionEntry = entry;
      // 只有这条记录自带伴奏时才清空手动选的伴奏（避免张冠李戴）；
      // 没自带伴奏的话，用户之前手动选的伴奏应该继续保留，不能白选
      if (entry.instrumentalPath) {
        selectedInstrumentalEntry = null;
      }
      // 更新所有卡片的样式
      loadVocalHistory();
      // 让"一键生成完整翻唱"按钮立即显示出来，不用等再做一次③换声
      updateVocalWorkflow();
    });

    actions.appendChild(selectBtn);

    // 老记录没存自带伴奏路径，提示需要额外从下面选一条"分离"记录的伴奏
    if (!entry.instrumentalPath) {
      const hint = document.createElement('div');
      hint.style.fontSize = '11px';
      hint.style.color = 'rgba(255, 180, 100, 0.9)';
      hint.style.marginTop = '4px';
      hint.textContent = '⚠ 这条记录没存伴奏，选它后还需在下面选一条"分离"记录的伴奏';
      card.appendChild(hint);
    }
  }


  if (entry.type === 'conversion') {
    const replayBtn = document.createElement('button');
    replayBtn.className = 'btn';
    replayBtn.textContent = '🔁 再唱一次';
    replayBtn.title = '参数完全不变，重新生成一遍（RVC 每次推理带随机噪声，音质会有细微差异，适合抽卡）';
    replayBtn.style.fontSize = '12px';
    replayBtn.style.padding = '4px 8px';
    replayBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      replayBtn.disabled = true;
      replayBtn.textContent = '生成中…';
      const result = await window.dash.replayVocalHistoryEntry(entry.id);
      replayBtn.disabled = false;
      replayBtn.textContent = '🔁 再唱一次';
      if (result.error) {
        alert(result.error);
        return;
      }
      loadVocalHistory();
    });
    actions.appendChild(replayBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'btn';
    editBtn.textContent = '⚙️ 调整参数重唱';
    editBtn.title = '把这条记录的模型/变调/相似度填到上面③换声面板，你可以先改参数再自己点换声';
    editBtn.style.fontSize = '12px';
    editBtn.style.padding = '4px 8px';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      lastExtractedVocalsPath = entry.sourcePath || '';
      if (entry.instrumentalPath) lastExtractedInstrumentalPath = entry.instrumentalPath;
      selectedVoiceModelPath = entry.modelPath || '';
      selectedVoiceIndexPath = entry.indexPath || '';
      voiceModelPathDisplayEl.value = entry.modelPath || '';
      voicePitchShiftEl.value = entry.pitchShift || 0;
      if (entry.indexPath && voiceIndexRateEl) {
        voiceIndexRateEl.value = entry.indexRate ?? 0.75;
        voiceIndexRateValueEl.textContent = Number(voiceIndexRateEl.value).toFixed(2);
      }
      // 如果这个模型正好是已保存的音色卡片之一，同步高亮它
      const matched = savedVoiceModels.find((m) => m.modelPath === entry.modelPath);
      selectedSavedVoiceModelId = matched ? matched.id : '';
      voiceModelSaveRowEl.style.display = matched ? 'none' : '';
      updateIndexRateVisibility();
      renderSavedVoiceModels();
      updateVocalWorkflow();
      voiceConvertBtnEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    actions.appendChild(editBtn);
  }

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn';
  deleteBtn.textContent = '删除记录';
  deleteBtn.style.fontSize = '12px';
  deleteBtn.style.padding = '4px 8px';
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.dash.deleteVocalHistoryEntry(entry.id);
    loadVocalHistory();
  });
  actions.appendChild(deleteBtn);
  card.appendChild(actions);

  // 显示选中状态
  const isSelected =
    (entry.type === 'conversion' && selectedConversionEntry?.id === entry.id) ||
    (entry.type === 'separation' && selectedInstrumentalEntry?.id === entry.id);
  if (isSelected) {
    card.style.borderWidth = '2px';
    card.style.borderColor = 'rgba(100, 200, 100, 0.8)';
    card.style.backgroundColor = 'rgba(100, 200, 100, 0.1)';
  }

  return card;
}

const vocalHistoryFilterRowEl = document.getElementById('vocalHistoryFilterRow');
const VOCAL_HISTORY_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'separation', label: '🎚️ 伴奏' },
  { key: 'conversion', label: '🎙️ 人声' },
  { key: 'enhance', label: '🪄 增强' },
  { key: 'mix', label: '✨ 成品' },
];
let vocalHistoryFilter = 'all';
let vocalHistoryCache = [];

function renderVocalHistoryFilterRow() {
  if (!vocalHistoryFilterRowEl) return;
  vocalHistoryFilterRowEl.replaceChildren();
  for (const f of VOCAL_HISTORY_FILTERS) {
    const count = f.key === 'all' ? vocalHistoryCache.length : vocalHistoryCache.filter((h) => h.type === f.key).length;
    const btn = document.createElement('button');
    btn.className = 'btn' + (vocalHistoryFilter === f.key ? ' active' : '');
    btn.textContent = `${f.label} (${count})`;
    btn.style.fontSize = '12px';
    btn.style.padding = '4px 10px';
    btn.addEventListener('click', () => {
      vocalHistoryFilter = f.key;
      renderVocalHistoryList();
    });
    vocalHistoryFilterRowEl.appendChild(btn);
  }
}

function renderVocalHistoryList() {
  const historyContainer = document.getElementById('vocalHistoryBySong');
  if (!historyContainer) return;
  renderVocalHistoryFilterRow();

  const filtered = vocalHistoryFilter === 'all'
    ? vocalHistoryCache
    : vocalHistoryCache.filter((h) => h.type === vocalHistoryFilter);

  historyContainer.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.style.margin = '0';
    empty.textContent = vocalHistoryCache.length
      ? '这个分类下还没有记录'
      : '还没有生成记录——分离一次伴奏，或者换一次声，就会出现在这里';
    historyContainer.appendChild(empty);
    return;
  }

  // Group by songName (backwards compatible with old records that lack it)
  const bySong = {};
  for (const entry of filtered) {
    // Try to extract song name from various fields, preferring htdemucs directory for conversions
    let songName = entry.songName;
    if (!songName && entry.sourceName) songName = entry.sourceName?.replace(/\.[^.]*$/, '');

    // For conversion: extract from htdemucs directory (e.g. ".../htdemucs/Song Name/vocals.wav" → "Song Name")
    if (!songName && entry.type === 'conversion' && entry.sourcePath?.includes('htdemucs')) {
      const parts = entry.sourcePath.split(/[\\/]/);
      const htdemucsIdx = parts.findIndex(p => p === 'htdemucs');
      if (htdemucsIdx >= 0 && htdemucsIdx + 1 < parts.length) {
        songName = parts[htdemucsIdx + 1];
      }
    }

    // For mix/enhance: try vocalsPath or instrumentalPath
    if (!songName && entry.vocalsPath?.includes('htdemucs')) {
      const parts = entry.vocalsPath.split(/[\\/]/);
      const htdemucsIdx = parts.findIndex(p => p === 'htdemucs');
      if (htdemucsIdx >= 0 && htdemucsIdx + 1 < parts.length) {
        songName = parts[htdemucsIdx + 1];
      }
    }
    if (!songName && entry.instrumentalPath?.includes('htdemucs')) {
      const parts = entry.instrumentalPath.split(/[\\/]/);
      const htdemucsIdx = parts.findIndex(p => p === 'htdemucs');
      if (htdemucsIdx >= 0 && htdemucsIdx + 1 < parts.length) {
        songName = parts[htdemucsIdx + 1];
      }
    }

    songName = songName || '未知歌曲';
    if (!bySong[songName]) bySong[songName] = [];
    bySong[songName].push(entry);
  }

  // Render by song
  for (const [songName, entries] of Object.entries(bySong).sort()) {
    const songGroup = document.createElement('div');
    songGroup.style.marginBottom = '12px';
    songGroup.style.padding = '10px';
    songGroup.style.background = 'rgba(var(--theme-accent-rgb), 0.04)';
    songGroup.style.borderRadius = '6px';

    const songTitle = document.createElement('div');
    songTitle.style.fontWeight = '600';
    songTitle.style.marginBottom = '8px';
    songTitle.style.fontSize = '13px';
    songTitle.style.color = 'rgba(var(--theme-text-rgb), 0.9)';
    songTitle.textContent = `📂 ${songName} (${entries.length})`;
    songGroup.appendChild(songTitle);

    const itemsContainer = document.createElement('div');
    itemsContainer.style.display = 'grid';
    itemsContainer.style.gridTemplateColumns = 'repeat(auto-fill, minmax(240px, 1fr))';
    itemsContainer.style.gap = '8px';
    for (const entry of entries) itemsContainer.appendChild(vocalHistoryRow(entry));
    songGroup.appendChild(itemsContainer);

    historyContainer.appendChild(songGroup);
  }
}

async function loadVocalHistory() {
  if (!vocalHistoryListEl) return;
  vocalHistoryCache = await window.dash.listVocalHistory();
  renderVocalHistoryList();
}
if (vocalHistoryListEl) loadVocalHistory();

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

function renderUsageBar(container, label, sub, valueText, pct, tier) {
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
  fill.className = `usage-bar-fill ${usageBarClass(pct)}${tier ? ` tier-${tier}` : ''}`;
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
      renderUsageBar(claudeUsageSessionsEl, label, s.model, valueText, pct, 'context');
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
        'fivehour',
      );
    }
    if (accountRateLimits.weekUsedPercent != null) {
      renderUsageBar(
        claudeUsageLimitsEl,
        '每周额度 · 全部模型',
        null,
        `${formatResetIn(accountRateLimits.weekResetsAt)} · ${Math.round(accountRateLimits.weekUsedPercent)}%`,
        accountRateLimits.weekUsedPercent,
        'week',
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
// Three independent transparency layers: this one is the *real* native
// window opacity (desktop shows through background + sidebar + modules
// together) -- separate from --panel-alpha (sidebar/module glass, below)
// and from --bg-alpha (the background layer, see makeColorOverridePicker
// section further down). Used to also double as the module-alpha control
// until the user pointed out those are two different things.
const dashWindowOpacityEl = document.getElementById('dashWindowOpacity');
const dashWindowOpacityValueEl = document.getElementById('dashWindowOpacityValue');
function applyWindowOpacityDisplay(v) {
  dashWindowOpacityValueEl.textContent = `${Math.round(v * 100)}%`;
}
// Live preview while dragging (no disk write on every pixel of movement),
// persisted once the user actually lets go of the slider.
dashWindowOpacityEl.addEventListener('input', () => {
  const value = Number(dashWindowOpacityEl.value);
  applyWindowOpacityDisplay(value);
  window.dash.previewOpacity(value);
});
dashWindowOpacityEl.addEventListener('change', () => window.dash.setSetting('dashboardPanelAlpha', Number(dashWindowOpacityEl.value)));

// Sidebar/module glass alpha -- purely the --panel-alpha CSS variable
// (rgba(var(--skin-rgb), var(--panel-alpha)) throughout dashboard.html),
// no window-opacity effect at all.
const dashModuleAlphaEl = document.getElementById('dashModuleAlpha');
const dashModuleAlphaValueEl = document.getElementById('dashModuleAlphaValue');
// Storage for preset-specific module alpha (sidebar transparency)
let themeAlphaStorage = {};

function applyModuleAlpha(v) {
  document.documentElement.style.setProperty('--panel-alpha', v);
  dashModuleAlphaValueEl.textContent = `${Math.round(v * 100)}%`;
}
dashModuleAlphaEl.addEventListener('input', () => applyModuleAlpha(Number(dashModuleAlphaEl.value)));
dashModuleAlphaEl.addEventListener('change', () => {
  const alpha = Number(dashModuleAlphaEl.value);
  const currentPreset = dashThemePresetEl.value.startsWith('custom:') ? 'custom' : (dashThemePresetEl.value || 'classic');
  // Remember this preset's alpha setting
  themeAlphaStorage[currentPreset] = alpha;
  window.dash.setSetting('moduleAlpha', alpha);
});

// Theme preset: sets/clears the [data-theme] attribute the CSS presets in
// dashboard.html's <style> block key off of -- 'classic' has no preset
// block (it's what :root's own defaults already are), so it's expressed
// as *removing* the attribute rather than a "classic" preset block that
// would just duplicate those same default values.

// Language setting with dynamic UI updates
const uiLanguageSelectEl = document.getElementById('uiLanguageSelect');
const i18nStrings = {
  zh: {
    '界面语言': '界面语言',
    '应用': '应用',
    '中文': '中文',
    '配色方案': '配色方案',
    '主题名字': '主题名字',
    '整体透明度': '整体透明度',
    '侧边栏 / 模块透明度': '侧边栏 / 模块透明度',
    '界面缩放（文字/按钮大小）': '界面缩放（文字/按钮大小）',
    '「记忆」页的关系图配色跟随主题': '「记忆」页的关系图配色跟随主题',
    '背景颜色': '背景颜色',
    '背景透明度': '背景透明度',
    '气泡/按钮链/徽章的底色': '气泡/按钮链/徽章的底色',
    '强调色（按钮 / 自己发的消息气泡）': '强调色（按钮 / 自己发的消息气泡）',
    '文字色': '文字色',
    '开启（番茄钟结束 / AI 任务需要你了 / 出错 / 摸它 时响一声短音）': '开启（番茄钟结束 / AI 任务需要你了 / 出错 / 摸它 时响一声短音）',
    '启用语音输出与输入': '启用语音输出与输入',
    '语音输出音量': '语音输出音量',
    '语速': '语速',
    '音高': '音高',
    '朗读引擎': '朗读引擎',
    'MiMo API Key': 'MiMo API Key',
    '中文音色（MiMo）': '中文音色（MiMo）',
    '中文语气标签（可选）': '中文语气标签（可选）',
    '英文音色（MiMo）': '英文音色（MiMo）',
    '发声音色（SAPI）': '发声音色（SAPI）',
    '英文音色（Edge）': '英文音色（Edge）',
    '中文音色（Edge）': '中文音色（Edge）',
    '语音识别引擎': '语音识别引擎',
    'CPU 模式（先出文字再朗读）': 'CPU 模式（先出文字再朗读）',
    '推送通话快捷键': '推送通话快捷键',
    '启用聊天': '启用聊天',
    '聊天时启用语音回复': '聊天时启用语音回复',
    '聊天模型提供商': '聊天模型提供商',
    'Ollama 地址': 'Ollama 地址',
    '模型名称': '模型名称',
    '回复语言': '回复语言',
    '口头禅（每行一句）': '口头禅（每行一句）',
    '歌词文本': '歌词文本',
    '试用样例歌词': '试用样例歌词',
    '演唱音色': '演唱音色',
    '来源': '来源',
    '模型': '模型',
    'voicePreviewChineseBtn': '试听',
    'voicePreviewEnglishBtn': 'Preview',
    'voiceEdgeEnglishHint': 'Edge 云端英文神经语音 · 点击「Preview」听样音（测试文本："Ah, young master, you look rather well this evening."）',
    'voiceEdgeChineseHint': 'Edge 云端中文神经语音 · 点击「试听」听样音（测试文本："哦呀哦呀，少爷，今天气色看着倒是不错，是发生了什么好事吗？"）',
    'uiLanguageLabel': '界面语言',
    'uiLanguageApplyBtn': '应用',
    'sidebarLangBadge': '中文',
    // Section titles (h3)
    '语言设置': '语言设置',
    '控制面板外观': '控制面板外观',
    '背景': '背景',
    '桌宠主题色': '桌宠主题色',
    '通知音效': '通知音效',
    '🎤 语音设置': '🎤 语音设置',
    '💬 聊天设置': '💬 聊天设置',
    '角色对话语言': '角色对话语言',
    '口头禅': '口头禅',
    '唱歌': '唱歌',
    '手势': '手势',
    // Hint descriptions (key UI Language section)
    '切换界面、对话和通知文本的语言；点「应用」实际执行切换，成功显示绿色✓，失败显示红色✗（提示最多显示1分钟）。': '切换界面、对话和通知文本的语言；点「应用」实际执行切换，成功显示绿色✓，失败显示红色✗（提示最多显示1分钟）。',
    // Status messages
    '✓ 转换成功': '✓ 转换成功',
    '✗ 转换失败': '✗ 转换失败',
    '转换中…': '转换中…',
    // Appearance section options and hints
    '经典（暖白 + 酒红）': '经典（暖白 + 酒红）',
    '黑绿赛博（荧光终端绿）': '黑绿赛博（荧光终端绿）',
    'EVA 绫波（紫罗兰 + 深紫）': 'EVA 绫波（紫罗兰 + 深紫）',
    'EVA 1号机（草绿 + 青）': 'EVA 1号机（草绿 + 青）',
    'EVA 2号机（深红 + 猩红）': 'EVA 2号机（深红 + 猩红）',
    'EVA 3号机（深蓝 + 天蓝）': 'EVA 3号机（深蓝 + 天蓝）',
    '选完立刻生效，控制面板和宠物身上的聊天气泡会一起换色，不用重启。': '选完立刻生效，控制面板和宠物身上的聊天气泡会一起换色，不用重启。',
    '恢复默认': '恢复默认',
  },
  en: {
    '界面语言': 'Interface Language',
    '应用': 'Apply',
    '中文': 'Chinese',
    '配色方案': 'Color Scheme',
    '主题名字': 'Theme Name',
    '整体透明度': 'Opacity',
    '侧边栏 / 模块透明度': 'Sidebar / Module Opacity',
    '界面缩放（文字/按钮大小）': 'UI Scale (Text / Button Size)',
    '「记忆」页的关系图配色跟随主题': 'Memory Graph Color Follows Theme',
    '背景颜色': 'Background Color',
    '背景透明度': 'Background Opacity',
    '气泡/按钮链/徽章的底色': 'Bubble / Link / Badge Base Color',
    '强调色（按钮 / 自己发的消息气泡）': 'Accent Color (Button / Message Bubble)',
    '文字色': 'Text Color',
    '开启（番茄钟结束 / AI 任务需要你了 / 出错 / 摸它 时响一声短音）': 'Enable (Pomodoro Done / Task Alert / Error / Pet Interaction)',
    '启用语音输出与输入': 'Enable Voice Output & Input',
    '语音输出音量': 'Voice Volume',
    '语速': 'Speech Rate',
    '音高': 'Pitch',
    '朗读引擎': 'TTS Engine',
    'MiMo API Key': 'MiMo API Key',
    '中文音色（MiMo）': 'Chinese Voice (MiMo)',
    '中文语气标签（可选）': 'Chinese Style Tag (Optional)',
    '英文音色（MiMo）': 'English Voice (MiMo)',
    '发声音色（SAPI）': 'Voice (SAPI)',
    '英文音色（Edge）': 'English Voice (Edge)',
    '中文音色（Edge）': 'Chinese Voice (Edge)',
    '语音识别引擎': 'Speech Recognition Engine',
    'CPU 模式（先出文字再朗读）': 'CPU Mode (Text First)',
    '推送通话快捷键': 'Push-to-Talk Hotkey',
    '启用聊天': 'Enable Chat',
    '聊天时启用语音回复': 'Voice Reply During Chat',
    '聊天模型提供商': 'Chat Provider',
    'Ollama 地址': 'Ollama URL',
    '模型名称': 'Model Name',
    '回复语言': 'Reply Language',
    '口头禅（每行一句）': 'Catchphrases (One per Line)',
    '歌词文本': 'Song Lyrics',
    '试用样例歌词': 'Example Lyrics',
    '演唱音色': 'Singing Voice',
    '来源': 'Source',
    '模型': 'Model',
    'voicePreviewChineseBtn': 'Listen',
    'voicePreviewEnglishBtn': 'Preview',
    'voiceEdgeEnglishHint': 'Edge cloud English neural voice · Click "Preview" to hear sample ("Ah, young master, you look rather well this evening.")',
    'voiceEdgeChineseHint': 'Edge cloud Chinese neural voice · Click "Listen" to hear sample ("哦呀哦呀，少爷，今天气色看着倒是不错，是发生了什么好事吗？")',
    'uiLanguageLabel': 'Interface Language',
    'uiLanguageApplyBtn': 'Apply',
    'sidebarLangBadge': 'English',
    // Section titles (h3)
    '语言设置': 'Language Settings',
    '控制面板外观': 'Panel Appearance',
    '背景': 'Background',
    '桌宠主题色': 'Pet Theme Color',
    '通知音效': 'Notification Sound',
    '🎤 语音设置': '🎤 Voice Settings',
    '💬 聊天设置': '💬 Chat Settings',
    '角色对话语言': 'Character Chat Language',
    '口头禅': 'Catchphrases',
    '唱歌': 'Singing',
    '手势': 'Gestures',
    // Hint descriptions (key UI Language section)
    '切换界面、对话和通知文本的语言；点「应用」实际执行切换，成功显示绿色✓，失败显示红色✗（提示最多显示1分钟）。': 'Switch the language for interface, chat, and notifications; click "Apply" to execute; success shows green ✓, failure shows red ✗ (message shows for at most 1 minute).',
    // Status messages
    '✓ 转换成功': '✓ Success',
    '✗ 转换失败': '✗ Failed',
    '转换中…': 'Converting...',
    // Appearance section options and hints
    '经典（暖白 + 酒红）': 'Classic (Warm White + Wine Red)',
    '黑绿赛博（荧光终端绿）': 'Cyberpunk Black-Green (Neon Terminal)',
    'EVA 绫波（紫罗兰 + 深紫）': 'EVA Ayanami (Violet + Deep Purple)',
    'EVA 1号机（草绿 + 青）': 'EVA Unit-01 (Grass Green + Cyan)',
    'EVA 2号机（深红 + 猩红）': 'EVA Unit-02 (Deep Red + Scarlet)',
    'EVA 3号机（深蓝 + 天蓝）': 'EVA Unit-03 (Deep Blue + Sky Blue)',
    '选完立刻生效，控制面板和宠物身上的聊天气泡会一起换色，不用重启。': 'Changes apply immediately; chat bubbles on both panel and pet update together, no restart needed.',
    '恢复默认': 'Reset to Default',
  }
};

const sidebarLangBadgeEl = document.getElementById('sidebarLangBadge');
let currentUILanguage = 'zh'; // Track current UI language for status messages

// Helper function to translate dynamic strings
function t(zhText) {
  const allTranslations = { ...i18nStrings[currentUILanguage], ...vocabularyFallback };
  return allTranslations[zhText] || zhText;
}

// Fallback vocabulary map for texts not in i18nStrings
const vocabularyFallback = {
  '🎤 语音设置': '🎤 Voice Settings',
  '💬 聊天设置': '💬 Chat Settings',
  '🎨 生成新形象需求': '🎨 Generate Character',
  '👀 干活监督': '👀 Focus Monitor',
  '📝 每日总结 + 记忆整理': '📝 Daily Summary + Memory',
  '📧 Outlook 待办同步': '📧 Outlook Sync',
  '📷 摄像头感知': '📷 Camera Sensing',
  '🖼️ 屏幕提示（截屏 + AI 锐评）': '🖼️ Screen Tips',
  '语言设置': 'Language Settings',
  '控制面板外观': 'Panel Appearance',
  '背景': 'Background',
  '桌宠主题色': 'Pet Theme Color',
  '通知音效': 'Notification Sound',
  '角色口头禅': 'Catchphrases',
  '角色对话语言': 'Character Chat Language',
  '唱歌': 'Singing',
  '手势': 'Gestures',
  '宠物可以说话，你也可以按下面设置的快捷键用麦克风讲话': 'Pet can speak; you can also use the hotkey below to talk via microphone.',
  '选完立刻生效，控制面板和宠物身上的聊天气泡会一起换色，不用重启。': 'Changes apply immediately; chat bubbles on both panel and pet update together.',
  '拖动即可实时调整整个控制面板窗口（背景 + 侧边栏 + 设置模块全部一起）的真实透明度；数值越低，桌面透得越明显。': 'Drag to adjust panel opacity in real-time; lower values make the desktop more visible.',
  '只调左侧栏和每个设置模块自己的磨砂玻璃浓淡，跟上面的「整体透明度」和「背景」都是分开的三层，互不影响。': 'Adjust sidebar and module frosted glass opacity separately; independent from overall opacity.',
  '看不清小字或者觉得按钮太大都可以调这个，跟系统缩放无关，只影响这个应用自己。': 'Adjust text size and button size; independent from system scale.',
  '改的是桌宠身上所有 UI（对话气泡、选项扇形按钮链、用量徽章卡片）共用的底色，选完立刻生效；黑红描边和文字颜色不受影响。': 'Changes the base color for all pet UI (chat bubbles, options, usage badges); takes effect immediately.',
  '不选文件就用内置的合成音效；选了就换成你自己的音频文件。': 'Use built-in sound effect by default; select a file to use your own audio.',
  'Windows 自带（SAPI，零配置）': 'Windows Built-in (SAPI, No Config)',
  'Windows 自带（SAPI，零配置，音质一般）': 'Windows Built-in (SAPI, Standard Quality)',
  'Piper（本地神经语音，音质好，需先配置模型）': 'Piper (Local Neural, High Quality, Needs Setup)',
  'Edge 云端语音（音质最好，需要联网）': 'Edge Cloud (Best Quality, Requires Internet)',
  'MiMo 云端语音（小米，角色感强，需要联网+API Key）': 'MiMo Cloud (Xiaomi, Character-driven, Requires Internet + API)',
  '列表来自本机 Windows 系统自带的语音包（仅对上面的 SAPI 引擎生效）；系统默认经常是女声，想要男声从这里选一个名字含"男"或 Male 的试听效果': 'Lists voices from Windows system packages (SAPI only); default is usually female.',
  '语气标签会拼进合成文本前面影响音色表现（比如「磁性」「沉稳」更贴合管家人设），留空则不加修饰；只对中文文本生效。': 'Style tags affect voice tone; leave empty for no modification. Chinese text only.',
  '跟界面语言是两回事——这个只决定角色聊天回复用哪种语言，选了 English 之后角色会用英文回复，语音也会自动跟着用对应的英文音色（不用额外设置）。': 'Separate from interface language; determines which language the character uses for chat replies.',
  '用 Alt+A 快捷键或点工具栏打开聊天窗口': 'Press Alt+A or click toolbar to open chat.',
  '宠物会用语音读出聊天回复': 'Pet will speak the chat reply with voice.',
  '跨会话记忆': 'Cross-session Memory',
  '定期截一屏交给视觉模型看一眼，说一句简短观察。': 'Periodically screenshot and ask vision model for brief observations.',
  '定期生成当天屏幕总结，顺带跑一遍记忆的提炼/去重/归纳总结（详见「记忆」页）。': 'Generate daily screen summary and process memory.',
  '给当前这套外观起个名字': 'Name this appearance preset',
  '另存为新主题': 'Save as New Theme',
  '把当前这套配色方案 + 强调色/文字色/背景/透明度/缩放整体存成一个新主题，之后能在上面下拉框里直接选出来；重命名/删除只对你自己存的主题有效，内置的几个方案改不了。': 'Save current color scheme with accent/text/background/opacity/scale as a new theme; rename/delete only affects your custom themes.',
  '这里改的是控制面板最底层的背景，跟左侧栏、各设置模块的磨砂玻璃颜色是分开的——那两个不受这里影响，还是只认「桌宠主题色」。': 'Changes the base background layer, separate from sidebar and module frosted glass colors.',
  '设置了图片就会铺满整个背景层、替代背景颜色；上面的透明度滑块同样能让图片变淡，方便看清前面的文字。': 'Image fills the background layer and replaces color; opacity slider also fades the image.',
  '关掉的话关系图始终用经典配色（暖白底 + 原来那几个节点颜色），不受这里选的配色方案影响。': 'Turn off to keep classic colors for relation graph, unaffected by theme selection.',
  '这两个是在「配色方案」基础上单独微调，改完立刻生效并记住；点「恢复默认」会退回当前配色方案自带的颜色，不影响皮肤色和方案本身。': 'Fine-tune these colors separately from the scheme; changes apply immediately and are saved.',
  '番茄钟完成': 'Pomodoro Complete',
  '任务需要你 / 出错': 'Task Alert / Error',
  '摸它 / 手势': 'Pet Interaction / Gesture',
  '🎼 原创演唱 · 文字直接转唱': '🎼 Original Singing · Text to Song',
  '最快出效果的路径——不需要准备任何歌曲文件，填词就能唱。': 'The fastest path -- no song file needed, just enter lyrics and sing.',
  '输入想让角色唱的歌词（中文/英文均可，中文效果通常更好）': 'Enter lyrics for the character to sing (Chinese/English; Chinese usually sounds better)',
  '跟随语音设置里配置的默认音色': 'Follows default voice from voice settings',
  '🎵 唱一下': '🎵 Sing Now',
  '生成的是完整一段人声演唱（会自带旋律和节奏，不是照着歌词念），时长通常比同样文字说话要长不少；不带伴奏，纯人声。免费额度和「语音与聊天」页共用同一个 MiMo Key。': 'Generates full vocal performance with melody and rhythm (not just recitation); usually longer than spoken text; pure vocals no accompaniment; shares free quota with voice chat.',
  '背景图片': 'Background Image',
  '已选择': 'Selected',
  '选择图片': 'Choose Image',
  '清除': 'Clear',
  '选择文件': 'Choose File',
  '（选一段快速试听，或者自己填词）': '(Choose a sample or enter lyrics)',
  '（内置音效）': '(Built-in Sound)',
  '（未设置，用背景颜色）': '(Not Set, Use Background Color)',
  // Overview tab content
  '待办': 'Todo',
  '番茄钟': 'Pomodoro',
  '未开始': 'Not Started',
  'AI 任务': 'AI Tasks',
  '点「AI 任务」页查看': 'Click "AI Tasks" tab to view',
  '屏幕提示': 'Screen Tips',
  '开启中': 'Enabled',
  'AI 最新状态': 'Latest AI Status',
  'Claude · 刚完成': 'Claude · Just Completed',
  'Claude · 任务完成！': 'Claude · Task Complete!',
  'Claude 用量': 'Claude Usage',
  '数据来自 Claude Code 官方的 statusLine 机制（每个会话自己上报上下文占用，5 小时/每周额度是账号级别，所有会话共享同一个数字），不是猜的也不是接的私有接口。': 'Data from Claude Code official statusLine mechanism (each session reports context usage; 5-hour/weekly quota is account-level, shared across sessions), not estimated or private API.',
  '会话': 'Session',
  '帮我把这个文件转成MP3': 'Help me convert this file to MP3',
  '5 小时额度': '5-hour quota',
  '4 小时 22 分钟后重置 · 17%': 'Resets in 4 hours 22 minutes · 17%',
  '每周额度 · 全部模型': 'Weekly quota · All models',
  '4 天后重置 · 54%': 'Resets in 4 days · 54%',
  '未开始': 'Not Started',
}

// Applies the dashboard "chrome" translation (sidebar title, the persistent
// language badge, nav labels, and each section's <h2>/subtitle) plus the
// smaller voice-preview string set below. Nav buttons carry their own
// translation key in data-section already (no extra markup needed); each
// section's <h2> is found via its existing id="section-<key>" so this
// doesn't require hunting element-by-element -- new nav/section pairs only
// need an entry added to dashboard-i18n-map.js, not a new querySelector
// here.
function applyDashboardChromeLanguage(lang) {
  const t = DASHBOARD_I18N[lang] || DASHBOARD_I18N.zh;

  const titleEl = document.querySelector('#sidebar h1');
  if (titleEl) titleEl.textContent = t.appTitle;
  const footerEl = document.getElementById('sidebarFooter');
  if (footerEl) footerEl.textContent = t.sidebarFooter;
  if (sidebarLangBadgeEl) sidebarLangBadgeEl.textContent = lang === 'en' ? 'English' : '中文';

  const groupLabels = document.querySelectorAll('.nav-group-label');
  const groupKeys = ['navGroupSettings', 'navGroupCharacter', 'navGroupRecords'];
  groupLabels.forEach((el, i) => {
    if (groupKeys[i] && t[groupKeys[i]]) el.textContent = t[groupKeys[i]];
  });

  document.querySelectorAll('.nav-btn[data-section]').forEach((btn) => {
    const key = btn.dataset.section;
    if (t.nav[key]) btn.textContent = t.nav[key];
  });

  for (const key of Object.keys(t.h2)) {
    const h2 = document.querySelector(`#section-${key} h2`);
    if (h2) h2.textContent = t.h2[key];
    const subtitle = t.subtitle?.[key];
    if (subtitle) {
      const p = document.querySelector(`#section-${key} .subtitle`);
      if (p) p.textContent = subtitle;
    }
  }
}

function applyUILanguage(lang) {
  currentUILanguage = lang; // Update current language tracking
  console.log(`[i18n] Starting translation to ${lang}`);
  applyDashboardChromeLanguage(lang);

  const strings = i18nStrings[lang] || i18nStrings.zh;
  let translatedCount = 0;

  // 1. Translate all labels
  const allLabels = document.querySelectorAll('label');
  for (const label of allLabels) {
    let zhText = label.getAttribute('data-i18n-zh');
    if (!zhText) {
      zhText = label.textContent.trim();
    }
    if (strings[zhText]) {
      label.textContent = strings[zhText];
      if (!label.hasAttribute('data-i18n-zh')) {
        label.setAttribute('data-i18n-zh', zhText);
      }
    }
  }

  // 2. Translate buttons (including the Apply button)
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    let zhText = btn.getAttribute('data-i18n-zh');
    if (!zhText) {
      zhText = btn.textContent.trim();
    }
    if (strings[zhText]) {
      btn.textContent = strings[zhText];
      if (!btn.hasAttribute('data-i18n-zh')) {
        btn.setAttribute('data-i18n-zh', zhText);
      }
    }
  }

  // 3. Translate h3 section titles
  const h3Elements = document.querySelectorAll('h3');
  for (const h3 of h3Elements) {
    let zhText = h3.getAttribute('data-i18n-zh');
    if (!zhText) {
      zhText = h3.textContent.trim();
    }
    if (strings[zhText]) {
      h3.textContent = strings[zhText];
      if (!h3.hasAttribute('data-i18n-zh')) {
        h3.setAttribute('data-i18n-zh', zhText);
      }
    }
  }

  // 4. Translate special button IDs
  const btnMap = {
    'voicePreviewChineseBtn': voicePreviewChineseBtnEl,
    'voicePreviewEnglishBtn': voicePreviewEnglishBtnEl,
  };

  for (const [key, el] of Object.entries(btnMap)) {
    if (el && strings[key]) {
      el.textContent = strings[key];
    }
  }

  // 5. Update hint texts
  const hintMap = {
    'voiceEdgeEnglishHint': document.getElementById('voiceEdgeEnglishHint'),
    'voiceEdgeChineseHint': document.getElementById('voiceEdgeChineseHint'),
  };

  for (const [key, el] of Object.entries(hintMap)) {
    if (el && strings[key]) {
      el.textContent = strings[key];
    }
  }

  // 6. Translate hint paragraphs
  const hints = document.querySelectorAll('p.hint');
  for (const hint of hints) {
    let zhText = hint.getAttribute('data-i18n-zh');
    if (!zhText) {
      zhText = hint.textContent.trim();
    }
    if (strings[zhText]) {
      hint.textContent = strings[zhText];
      if (!hint.hasAttribute('data-i18n-zh')) {
        hint.setAttribute('data-i18n-zh', zhText);
      }
    }
  }

  // 7. Translate select option text
  const allSelects = document.querySelectorAll('select');
  for (const select of allSelects) {
    for (const option of select.options) {
      let zhText = option.getAttribute('data-i18n-zh');
      if (!zhText) {
        zhText = option.textContent.trim();
      }
      if (strings[zhText]) {
        option.textContent = strings[zhText];
        if (!option.hasAttribute('data-i18n-zh')) {
          option.setAttribute('data-i18n-zh', zhText);
        }
      }
    }
  }

  // 8. Translate all text nodes, attributes, and elements recursively with fallback
  function normalizeForMatch(text) {
    return text.trim().replace(/\s+/g, ' ');
  }

  function translateAttribute(element, attrName) {
    const value = element.getAttribute(attrName);
    if (!value) return;
    const normalized = normalizeForMatch(value);
    if (strings[normalized]) {
      element.setAttribute(attrName, strings[normalized]);
    } else if (lang === 'en' && vocabularyFallback[normalized]) {
      element.setAttribute(attrName, vocabularyFallback[normalized]);
    } else if (lang === 'en') {
      for (const [key, val] of Object.entries(vocabularyFallback)) {
        if (normalizeForMatch(key) === normalized) {
          element.setAttribute(attrName, val);
          break;
        }
      }
    }
  }

  function translateTextNodes(container) {
    for (const node of container.childNodes) {
      if (node.nodeType === 3) { // Text node
        const zhText = normalizeForMatch(node.textContent);
        if (zhText.length > 0) {
          if (strings[zhText]) {
            node.textContent = strings[zhText];
          } else if (lang === 'en' && vocabularyFallback[zhText]) {
            node.textContent = vocabularyFallback[zhText];
          } else if (lang === 'en') {
            for (const [key, value] of Object.entries(vocabularyFallback)) {
              if (normalizeForMatch(key) === zhText) {
                node.textContent = value;
                break;
              }
            }
          }
        }
      } else if (node.nodeType === 1) { // Element node
        // Translate placeholder and title attributes
        if (node.hasAttribute('placeholder')) {
          translateAttribute(node, 'placeholder');
        }
        if (node.hasAttribute('title')) {
          translateAttribute(node, 'title');
        }

        // Skip script and style
        if (['SCRIPT', 'STYLE'].includes(node.tagName)) {
          continue;
        }
        // For p, h3, div, span without children: try translating textContent
        if (['P', 'H3', 'DIV', 'SPAN'].includes(node.tagName) && node.children.length === 0) {
          const zhText = normalizeForMatch(node.textContent);
          if (zhText && /[一-鿿]/.test(zhText)) {
            if (strings[zhText]) {
              node.textContent = strings[zhText];
            } else if (lang === 'en' && vocabularyFallback[zhText]) {
              node.textContent = vocabularyFallback[zhText];
            } else if (lang === 'en') {
              for (const [key, value] of Object.entries(vocabularyFallback)) {
                if (normalizeForMatch(key) === zhText) {
                  node.textContent = value;
                  break;
                }
              }
            }
          }
        } else {
          translateTextNodes(node);
        }
      }
    }
  }

  // Find all sections and translate their content
  const settingsSections = document.querySelectorAll('.section, .panel-block');
  console.log(`[i18n] Found ${settingsSections.length} sections to translate`);

  for (const section of settingsSections) {
    translateTextNodes(section);
  }

  // 9. Schedule deferred translation for dynamically loaded content
  setTimeout(() => {
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      // Check text content
      if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
        const zhText = normalizeForMatch(el.textContent);
        if (zhText && /[一-鿿]/.test(zhText)) {
          if (strings[zhText]) {
            el.textContent = strings[zhText];
          } else if (lang === 'en' && vocabularyFallback[zhText]) {
            el.textContent = vocabularyFallback[zhText];
          }
        }
      }

      // Check value attribute (for input elements)
      if (el.hasAttribute('value')) {
        const zhVal = normalizeForMatch(el.getAttribute('value'));
        if (zhVal && /[一-鿿]/.test(zhVal)) {
          const allTrans = { ...strings, ...vocabularyFallback };
          if (allTrans[zhVal]) {
            el.setAttribute('value', allTrans[zhVal]);
          }
        }
      }
    }
    console.log(`[i18n] Deferred translation complete`);
  }, 200);

  // 10. Update sidebar language badge
  if (sidebarLangBadgeEl) {
    sidebarLangBadgeEl.textContent = strings['sidebarLangBadge'];
  }

  console.log(`[i18n] Translation complete for language: ${lang}`);
  console.log(`[i18n] i18nStrings has ${Object.keys(strings).length} entries`);
  console.log(`[i18n] vocabularyFallback has ${Object.keys(vocabularyFallback).length} entries`);
}

const uiLanguageApplyBtnEl = document.getElementById('uiLanguageApplyBtn');
const uiLanguageStatusEl = document.getElementById('uiLanguageStatus');
let uiLanguageStatusClearTimer = null;

if (uiLanguageSelectEl) {
  uiLanguageSelectEl.addEventListener('change', () => {
    window.dash.setSetting('uiLanguage', uiLanguageSelectEl.value);
    uiLanguageStatusEl.textContent = '';
  });

  if (uiLanguageApplyBtnEl) {
    uiLanguageApplyBtnEl.addEventListener('click', async () => {
      const value = uiLanguageSelectEl.value;
      if (uiLanguageStatusClearTimer) clearTimeout(uiLanguageStatusClearTimer);
      uiLanguageApplyBtnEl.disabled = true;
      uiLanguageStatusEl.style.color = '';
      const loadingStrings = i18nStrings[value] || i18nStrings.zh;
      uiLanguageStatusEl.textContent = loadingStrings['转换中…'];
      await new Promise((r) => setTimeout(r, 400));
      try {
        window.dash.setSetting('uiLanguage', value);
        applyUILanguage(value);
        const resultStrings = i18nStrings[value] || i18nStrings.zh;
        uiLanguageStatusEl.style.color = '#2e8b45';
        uiLanguageStatusEl.textContent = resultStrings['✓ 转换成功'];
      } catch (err) {
        const errorStrings = i18nStrings[value] || i18nStrings.zh;
        uiLanguageStatusEl.style.color = '#c4304a';
        uiLanguageStatusEl.textContent = `${errorStrings['✗ 转换失败']}: ${err.message}`;
      } finally {
        uiLanguageApplyBtnEl.disabled = false;
        uiLanguageStatusClearTimer = setTimeout(() => {
          uiLanguageStatusEl.textContent = '';
        }, 60000);
      }
    });
  }

  // Initialize from settings
  window.dash.getData().then(data => {
    if (data.settings?.uiLanguage) {
      uiLanguageSelectEl.value = data.settings.uiLanguage;
      applyUILanguage(data.settings.uiLanguage);
    }
  }).catch(err => console.error('Failed to load UI language setting:', err));
}

const dashThemePresetEl = document.getElementById('dashThemePreset');
const dashThemeCustomGroupEl = document.getElementById('dashThemeCustomGroup');
const dashThemeCustomNameEl = document.getElementById('dashThemeCustomName');
const dashThemeCustomActionsRowEl = document.getElementById('dashThemeCustomActionsRow');
const dashThemeSaveBtnEl = document.getElementById('dashThemeSaveBtn');
const dashThemeRenameBtnEl = document.getElementById('dashThemeRenameBtn');
const dashThemeDeleteBtnEl = document.getElementById('dashThemeDeleteBtn');
let customThemesCache = [];

// Map of theme presets to their assistant bubble colors (RGB triplets) and module alpha
const THEME_BUBBLE_COLORS = {
  'classic': '0, 0, 0',
  'dark-red': '30, 20, 22',
  'dark-pink': '30, 22, 28',
  'light-pink': '0, 0, 0',
  'cyber-green': '15, 30, 25',
  'liquid-glass': '0, 0, 0',
  'eva-purple': '15, 10, 20',
  'eva-01-green': '12, 20, 15',
  'eva-02-red': '25, 15, 16',
  'eva-03-blue': '10, 16, 22',
};

const THEME_MODULE_ALPHA = {
  'classic': 0.92,
  'dark-red': 0.92,
  'dark-pink': 0.92,
  'light-pink': 0.88,
  'cyber-green': 0.95,
  'liquid-glass': 0.85,
  'eva-purple': 0.92,
  'eva-01-green': 0.92,
  'eva-02-red': 0.92,
  'eva-03-blue': 0.92,
};

function applyThemePreset(preset) {
  if (preset && preset !== 'classic') document.documentElement.setAttribute('data-theme', preset);
  else document.documentElement.removeAttribute('data-theme');
  // Sync the assistant bubble color to the pet window so it matches the theme
  const bubbleRgb = THEME_BUBBLE_COLORS[preset] || THEME_BUBBLE_COLORS['classic'];
  window.dash.setSetting('assistantBubbleColor', bubbleRgb);
  // Load module alpha for this preset (remembers user's last setting for each preset)
  if (!themeAlphaStorage) themeAlphaStorage = {};
  const moduleAlpha = themeAlphaStorage[preset] ?? (THEME_MODULE_ALPHA[preset] ?? 0.92);
  dashModuleAlphaEl.value = String(moduleAlpha);
  applyModuleAlpha(moduleAlpha);
  window.dash.setSetting('moduleAlpha', moduleAlpha);
  // Reset accent/text/bg color overrides when switching presets
  // (so preset's CSS colors are used, not custom overrides from previous preset)
  accentColorPicker.initFrom('');
  textColorPicker.initFrom('');
  bgColorPicker.initFrom('');
}
// Custom-theme <option>s carry a "custom:<id>" value so this handler can
// tell them apart from the six built-in preset names without needing a
// second <select> or extra markup per entry.
dashThemePresetEl.addEventListener('change', () => {
  const value = dashThemePresetEl.value;
  if (value.startsWith('custom:')) {
    applyCustomThemeSelection(value.slice('custom:'.length));
    return;
  }
  applyThemePreset(value);
  window.dash.setSetting('themePreset', value);
  // The accent/text pickers below fall back to whatever the *new* preset
  // defines whenever the user hasn't pinned a custom override -- refresh
  // their swatches so they don't keep showing the old preset's colour.
  refreshColorOverrideDisplays();
  dashThemeCustomNameEl.value = '';
  dashThemeCustomActionsRowEl.style.display = 'none';
  if (graphRunning) drawGraph();
});

// UI scale: `zoom` on #main/#sidebar (see dashboard.html), not a
// font-size multiplier -- scales spacing/icons/buttons along with text
// instead of just growing text inside unchanged-size boxes.
const dashUiScaleEl = document.getElementById('dashUiScale');
const dashUiScaleValueEl = document.getElementById('dashUiScaleValue');
function applyUiScale(v) {
  document.documentElement.style.setProperty('--ui-scale', v);
  dashUiScaleValueEl.textContent = `${Math.round(v * 100)}%`;
}
dashUiScaleEl.addEventListener('input', () => applyUiScale(Number(dashUiScaleEl.value)));
dashUiScaleEl.addEventListener('change', () => window.dash.setSetting('uiScale', Number(dashUiScaleEl.value)));

const DEFAULT_SKIN_COLOR = '#faf0e4';
const dashSkinColorEl = document.getElementById('dashSkinColor');
const dashSkinColorResetEl = document.getElementById('dashSkinColorReset');
dashSkinColorEl.addEventListener('input', () => window.dash.setSetting('petSkinColor', dashSkinColorEl.value));
dashSkinColorResetEl.addEventListener('click', () => {
  dashSkinColorEl.value = DEFAULT_SKIN_COLOR;
  window.dash.setSetting('petSkinColor', DEFAULT_SKIN_COLOR);
});

// Accent/text colour fine-tuning on top of whatever preset is active.
// Unlike skin colour above (always a fixed value), these two are
// nullable overrides: an empty string means "no override, follow the
// preset", so switching presets keeps working sensibly for anyone who
// hasn't touched these. Applied to *this* document too (not just pushed
// to the pet window) so the dashboard's own accent-coloured buttons/chat
// bubbles preview the change immediately, the same way the theme preset
// picker above already does locally via the data-theme attribute.
function hexToRgbTriple(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}`;
}
function computedRgbHex(varName) {
  const triple = getComputedStyle(document.documentElement).getPropertyValue(varName);
  const parts = triple.split(',').map((s) => parseInt(s.trim(), 10));
  if (parts.length !== 3 || parts.some(Number.isNaN)) return '#000000';
  return '#' + parts.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('');
}

function makeColorOverridePicker(varName, settingName, inputEl, resetEl) {
  let overridden = false;
  function apply(hex) {
    const triple = hexToRgbTriple(hex);
    if (triple) document.documentElement.style.setProperty(varName, triple);
    else document.documentElement.style.removeProperty(varName);
  }
  function refreshDisplay() {
    if (!overridden) inputEl.value = computedRgbHex(varName);
  }
  inputEl.addEventListener('input', () => {
    overridden = true;
    apply(inputEl.value);
    window.dash.setSetting(settingName, inputEl.value);
  });
  resetEl.addEventListener('click', () => {
    overridden = false;
    apply('');
    refreshDisplay();
    window.dash.setSetting(settingName, '');
  });
  return {
    initFrom(hex) {
      overridden = !!hex;
      apply(hex ?? '');
      refreshDisplay();
    },
    refreshDisplay,
  };
}
const accentColorPicker = makeColorOverridePicker(
  '--theme-accent-rgb', 'accentColor',
  document.getElementById('dashAccentColor'), document.getElementById('dashAccentColorReset'),
);
const textColorPicker = makeColorOverridePicker(
  '--theme-text-rgb', 'textColor',
  document.getElementById('dashTextColor'), document.getElementById('dashTextColorReset'),
);
const bgColorPicker = makeColorOverridePicker(
  '--bg-rgb', 'backgroundColor',
  document.getElementById('dashBgColor'), document.getElementById('dashBgColorReset'),
);
function refreshColorOverrideDisplays() {
  accentColorPicker.refreshDisplay();
  textColorPicker.refreshDisplay();
  bgColorPicker.refreshDisplay();
}

// Background transparency -- separate from --panel-alpha (sidebar/module
// glass) and from the native window opacity slider; only fades #bgLayer.
const dashBgAlphaEl = document.getElementById('dashBgAlpha');
const dashBgAlphaValueEl = document.getElementById('dashBgAlphaValue');
function applyBgAlpha(v) {
  document.documentElement.style.setProperty('--bg-alpha', v);
  dashBgAlphaValueEl.textContent = `${Math.round(v * 100)}%`;
}
dashBgAlphaEl.addEventListener('input', () => applyBgAlpha(Number(dashBgAlphaEl.value)));
dashBgAlphaEl.addEventListener('change', () => window.dash.setSetting('backgroundAlpha', Number(dashBgAlphaEl.value)));

// Background image -- an inline background-image on #bgLayer fully
// replaces its CSS gradient (background-size/position stay in effect
// either way); clearing it falls back to the gradient/colour above.
const bgLayerEl = document.getElementById('bgLayer');
const bgImageNameEl = document.getElementById('bgImageName');
const bgImagePickEl = document.getElementById('bgImagePick');
const bgImageClearEl = document.getElementById('bgImageClear');
function applyBgImage(url) {
  if (url) bgLayerEl.style.backgroundImage = `url("${url}")`;
  else bgLayerEl.style.removeProperty('background-image');
}
bgImagePickEl.addEventListener('click', async () => {
  const res = await window.dash.pickBackgroundImage();
  if (!res.ok) return;
  applyBgImage(res.backgroundImageUrl);
  bgImageNameEl.textContent = `已选择：${res.backgroundImageName}`;
});
bgImageClearEl.addEventListener('click', async () => {
  await window.dash.clearBackgroundImage();
  applyBgImage(null);
  bgImageNameEl.textContent = '（未设置，用背景颜色）';
});

// Custom themes: a full snapshot of every appearance field (preset +
// skin/accent/text/background colours + all three alpha layers + uiScale)
// saved under a name, applied as one batch instead of the user re-doing
// each picker by hand. Rebuilt into <optgroup id="dashThemeCustomGroup">
// whenever the list changes; declared with `function` (hoisted) so the
// dashThemePresetEl change handler above -- defined earlier in the file --
// can call it.
function rebuildCustomThemeOptions() {
  dashThemeCustomGroupEl.replaceChildren();
  for (const entry of customThemesCache) {
    const opt = document.createElement('option');
    opt.value = `custom:${entry.id}`;
    opt.textContent = entry.name;
    dashThemeCustomGroupEl.appendChild(opt);
  }
}

function applyCustomThemeSelection(id) {
  const entry = customThemesCache.find((p) => p.id === id);
  if (!entry) return;
  applyThemePreset(entry.preset ?? 'classic');
  dashSkinColorEl.value = entry.skinColor ?? DEFAULT_SKIN_COLOR;
  accentColorPicker.initFrom(entry.accentColor);
  textColorPicker.initFrom(entry.textColor);
  bgColorPicker.initFrom(entry.backgroundColor);
  dashBgAlphaEl.value = String(entry.backgroundAlpha ?? 1);
  applyBgAlpha(Number(dashBgAlphaEl.value));
  dashModuleAlphaEl.value = String(entry.moduleAlpha ?? 0.92);
  applyModuleAlpha(Number(dashModuleAlphaEl.value));
  dashUiScaleEl.value = String(entry.uiScale ?? 1);
  applyUiScale(Number(dashUiScaleEl.value));
  dashThemeCustomNameEl.value = entry.name;
  dashThemeCustomActionsRowEl.style.display = 'flex';
  if (graphRunning) drawGraph();
  window.dash.applyCustomTheme(id).then((res) => {
    if (res.ok) {
      applyBgImage(res.backgroundImageUrl);
      bgImageNameEl.textContent = res.backgroundImageName ? `已选择：${res.backgroundImageName}` : '（未设置，用背景颜色）';
    }
  });
}

dashThemeSaveBtnEl.addEventListener('click', async () => {
  const name = dashThemeCustomNameEl.value.trim();
  if (!name) return;
  const res = await window.dash.saveCustomTheme(name);
  if (!res.ok) return;
  customThemesCache = res.customPresets;
  rebuildCustomThemeOptions();
  dashThemePresetEl.value = `custom:${res.id}`;
  dashThemeCustomActionsRowEl.style.display = 'flex';
});

dashThemeRenameBtnEl.addEventListener('click', async () => {
  const value = dashThemePresetEl.value;
  if (!value.startsWith('custom:')) return;
  const name = dashThemeCustomNameEl.value.trim();
  if (!name) return;
  const id = value.slice('custom:'.length);
  const res = await window.dash.renameCustomTheme(id, name);
  if (!res.ok) return;
  customThemesCache = res.customPresets;
  rebuildCustomThemeOptions();
  dashThemePresetEl.value = value;
});

dashThemeDeleteBtnEl.addEventListener('click', async () => {
  const value = dashThemePresetEl.value;
  if (!value.startsWith('custom:')) return;
  const id = value.slice('custom:'.length);
  const res = await window.dash.deleteCustomTheme(id);
  if (!res.ok) return;
  customThemesCache = res.customPresets;
  rebuildCustomThemeOptions();
  // The deleted theme can't stay selected -- fall back to classic, same
  // as picking it from the dropdown by hand.
  dashThemePresetEl.value = 'classic';
  dashThemePresetEl.dispatchEvent(new Event('change'));
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
const voiceVoiceNameSelectEl = document.getElementById('voiceVoiceNameSelect');
const voiceVoiceNameGroupEl = document.getElementById('voiceSettingsGroup5');
const voiceVoiceNameHintEl = document.getElementById('voiceVoiceNameHint');
const voiceVoiceNameNonSapiHintEl = document.getElementById('voiceVoiceNameNonSapiHint');
const voiceEdgeEnglishSelectEl = document.getElementById('voiceEdgeEnglishSelect');
const voiceEdgeEnglishGroupEl = document.getElementById('voiceEdgeEnglishGroup');
const voiceEdgeEnglishHintEl = document.getElementById('voiceEdgeEnglishHint');
const voiceEdgeChineseSelectEl = document.getElementById('voiceEdgeChineseSelect');
const voiceEdgeChineseGroupEl = document.getElementById('voiceEdgeChineseGroup');
const voiceEdgeChineseHintEl = document.getElementById('voiceEdgeChineseHint');
const voiceSttEngineSelectEl = document.getElementById('voiceSttEngineSelect');
const voiceSttEngineHintEl = document.getElementById('voiceSttEngineHint');
const voiceTtsEngineSelectEl = document.getElementById('voiceTtsEngineSelect');
const voiceTtsEngineHintEl = document.getElementById('voiceTtsEngineHint');
const voiceTtsEnginePiperWarningEl = document.getElementById('voiceTtsEnginePiperWarning');
const voiceTtsEngineStatusEl = document.getElementById('voiceTtsEngineStatus');
const voiceGpuStatusHintEl = document.getElementById('voiceGpuStatusHint');
const voiceMimoGroupEl = document.getElementById('voiceMimoGroup');
const voiceMimoApiKeyInputEl = document.getElementById('voiceMimoApiKeyInput');
const voiceMimoApiKeyHintEl = document.getElementById('voiceMimoApiKeyHint');
const voiceMimoVoiceZhGroupEl = document.getElementById('voiceMimoVoiceZhGroup');
const voiceMimoVoiceZhSelectEl = document.getElementById('voiceMimoVoiceZhSelect');
const voiceMimoVoiceEnGroupEl = document.getElementById('voiceMimoVoiceEnGroup');
const voiceMimoVoiceEnSelectEl = document.getElementById('voiceMimoVoiceEnSelect');
const voiceMimoStyleGroupEl = document.getElementById('voiceMimoStyleGroup');
const voiceMimoStyleSelectEl = document.getElementById('voiceMimoStyleSelect');
const voiceMimoStyleHintEl = document.getElementById('voiceMimoStyleHint');
const voicePreviewMimoZhBtnEl = document.getElementById('voicePreviewMimoZhBtn');
const voicePreviewMimoEnBtnEl = document.getElementById('voicePreviewMimoEnBtn');
const voiceCpuModeEl = document.getElementById('voiceCpuMode');
const voiceCpuModeHintEl = document.getElementById('voiceCpuModeHint');
const voiceSettingsGroups = [
  document.getElementById('voiceSettingsGroup'),
  document.getElementById('voiceSettingsGroup2'),
  document.getElementById('voiceSettingsGroup3'),
  document.getElementById('voiceSettingsGroup4'),
  document.getElementById('voiceSettingsGroupTts'),
  document.getElementById('voiceSettingsGroup6'),
  document.getElementById('voiceSettingsGroup7'),
  voiceTtsEngineHintEl,
  voiceSttEngineHintEl,
  voiceCpuModeHintEl,
];

// The "发声音色" row only means anything for the sapi engine -- piper's
// voice comes from whichever model file is configured, edge-cloud's from
// voice.edge.voiceName*, neither of which this dropdown touches. Showing it
// regardless of engine is exactly what produced the "I picked an engine
// AND a voice, neither seems to matter" confusion, so its visibility
// tracks the engine selection instead of just the blanket voiceEnabled
// toggle the rest of voiceSettingsGroups uses.
function updateVoiceNameGroupVisibility() {
  const engine = voiceTtsEngineSelectEl.value;
  const enabled = voiceEnabledEl.checked;
  const showSapi = enabled && engine === 'sapi';
  const showEdge = enabled && engine === 'edge-cloud';
  const showMimo = enabled && engine === 'mimo-cloud';

  voiceVoiceNameGroupEl.style.display = showSapi ? 'block' : 'none';
  voiceVoiceNameHintEl.style.display = showSapi ? 'block' : 'none';
  voiceEdgeEnglishGroupEl.style.display = showEdge ? 'block' : 'none';
  voiceEdgeEnglishHintEl.style.display = showEdge ? 'block' : 'none';
  voiceEdgeChineseGroupEl.style.display = showEdge ? 'block' : 'none';
  voiceEdgeChineseHintEl.style.display = showEdge ? 'block' : 'none';
  voiceMimoGroupEl.style.display = showMimo ? 'block' : 'none';
  voiceMimoApiKeyHintEl.style.display = showMimo ? 'block' : 'none';
  voiceMimoVoiceZhGroupEl.style.display = showMimo ? 'block' : 'none';
  voiceMimoVoiceEnGroupEl.style.display = showMimo ? 'block' : 'none';
  voiceMimoStyleGroupEl.style.display = showMimo ? 'block' : 'none';
  voiceMimoStyleHintEl.style.display = showMimo ? 'block' : 'none';
  voiceVoiceNameNonSapiHintEl.style.display = enabled && !showSapi && engine !== 'edge-cloud' && engine !== 'mimo-cloud' ? 'block' : 'none';
}

function voiceOptionsFrom(list) {
  return list.map((v) => {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.label;
    return opt;
  });
}

let mimoVoicesLoaded = false;
async function ensureMimoVoicesLoaded() {
  if (mimoVoicesLoaded) return;
  mimoVoicesLoaded = true;
  try {
    const { chinese, english, styleTags } = await window.dash.getMimoVoices();
    voiceMimoVoiceZhSelectEl.replaceChildren(...voiceOptionsFrom(chinese));
    voiceMimoVoiceEnSelectEl.replaceChildren(...voiceOptionsFrom(english));
    voiceMimoStyleSelectEl.replaceChildren(
      ...styleTags.map((tag) => {
        const opt = document.createElement('option');
        opt.value = tag;
        opt.textContent = tag || '（不加语气标签）';
        return opt;
      }),
    );
  } catch (err) {
    console.error('Failed to load MiMo voices:', err);
  }
}

voiceEnabledEl.addEventListener('change', (e) => {
  window.dash.setSetting('voiceEnabled', e.target.checked);
  for (const group of voiceSettingsGroups) {
    group.style.display = e.target.checked ? 'block' : 'none';
  }
  updateTtsEnginePiperWarning();
  updateVoiceNameGroupVisibility();
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
  window.dash.setSetting('voicePushToTalkKey', e.target.value || 'Alt+G');
});

// speechSynthesis.getVoices() is often empty on first call -- the browser
// loads voices asynchronously and fires 'voiceschanged' once they're
// ready, sometimes more than once as different voice sources register.
// zh voices sorted first since this app is Chinese-first and that's what
// someone picking a voice here almost always wants to see without
// scrolling past a long list of English/other-language system voices.
let pendingVoiceSelection = '';
let pendingMimoVoiceZh = '白桦';
let pendingMimoVoiceEn = 'Dean';
let pendingMimoStyleTagZh = '';
function populateVoiceNameSelect() {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  if (!voices.length) return;
  const zh = voices.filter((v) => v.lang?.toLowerCase().startsWith('zh'));
  const rest = voices.filter((v) => !v.lang?.toLowerCase().startsWith('zh'));
  voiceVoiceNameSelectEl.replaceChildren();
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = '（系统默认）';
  voiceVoiceNameSelectEl.appendChild(defaultOpt);
  for (const v of [...zh, ...rest]) {
    const opt = document.createElement('option');
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    voiceVoiceNameSelectEl.appendChild(opt);
  }
  voiceVoiceNameSelectEl.value = pendingVoiceSelection;
}
window.speechSynthesis?.addEventListener('voiceschanged', populateVoiceNameSelect);
populateVoiceNameSelect();

voiceVoiceNameSelectEl.addEventListener('change', (e) => {
  window.dash.setSetting('voiceVoiceName', e.target.value);
});

// Load Edge voices on startup
(async () => {
  const voices = await window.dash.getEdgeVoices();
  if (!voices) return;

  // Populate English voices
  voiceEdgeEnglishSelectEl.replaceChildren();
  const enDefault = document.createElement('option');
  enDefault.value = '';
  enDefault.textContent = '（默认）';
  voiceEdgeEnglishSelectEl.appendChild(enDefault);
  for (const voice of voices.english) {
    const opt = document.createElement('option');
    opt.value = voice.name;
    opt.textContent = voice.label;
    voiceEdgeEnglishSelectEl.appendChild(opt);
  }

  // Populate Chinese voices
  voiceEdgeChineseSelectEl.replaceChildren();
  const zhDefault = document.createElement('option');
  zhDefault.value = '';
  zhDefault.textContent = '（默认）';
  voiceEdgeChineseSelectEl.appendChild(zhDefault);
  for (const voice of voices.chinese) {
    const opt = document.createElement('option');
    opt.value = voice.name;
    opt.textContent = voice.label;
    voiceEdgeChineseSelectEl.appendChild(opt);
  }
})();

voiceEdgeEnglishSelectEl.addEventListener('change', (e) => {
  window.dash.setSetting('voiceEdgeEnglishName', e.target.value || '');
});

// English voice preview
const voicePreviewEnglishBtnEl = document.getElementById('voicePreviewEnglishBtn');
if (voicePreviewEnglishBtnEl) {
  voicePreviewEnglishBtnEl.addEventListener('click', async () => {
    const voiceName = voiceEdgeEnglishSelectEl.value;
    if (!voiceName) {
      alert('Please select an English voice first');
      return;
    }

    voicePreviewEnglishBtnEl.disabled = true;
    voicePreviewEnglishBtnEl.textContent = 'Generating...';

    try {
      const testText = 'Ah, young master, you look rather well this evening.';
      const result = await window.dash.synthesizeSpeech(testText);

      if (result.fileUrl) {
        const audio = new Audio(result.fileUrl);
        audio.play();
        voicePreviewEnglishBtnEl.textContent = 'Playing...';

        audio.onended = () => {
          voicePreviewEnglishBtnEl.textContent = 'Preview';
          voicePreviewEnglishBtnEl.disabled = false;
        };

        setTimeout(() => {
          if (voicePreviewEnglishBtnEl.textContent === 'Playing...') {
            voicePreviewEnglishBtnEl.textContent = 'Preview';
            voicePreviewEnglishBtnEl.disabled = false;
          }
        }, 30000);
      } else {
        alert('Synthesis failed. Check your network connection.');
        voicePreviewEnglishBtnEl.textContent = 'Preview';
        voicePreviewEnglishBtnEl.disabled = false;
      }
    } catch (err) {
      console.error('Voice preview error:', err);
      alert('Preview error: ' + err.message);
      voicePreviewEnglishBtnEl.textContent = 'Preview';
      voicePreviewEnglishBtnEl.disabled = false;
    }
  });
}

voiceEdgeChineseSelectEl.addEventListener('change', (e) => {
  window.dash.setSetting('voiceEdgeChineseName', e.target.value || '');
});

// Voice preview functionality
const voicePreviewChineseBtnEl = document.getElementById('voicePreviewChineseBtn');
let isPreviewPlaying = false;
if (voicePreviewChineseBtnEl) {
  voicePreviewChineseBtnEl.addEventListener('click', async () => {
    const voiceName = voiceEdgeChineseSelectEl.value;
    if (!voiceName) {
      alert('请先选择一个中文音色');
      return;
    }

    voicePreviewChineseBtnEl.disabled = true;
    voicePreviewChineseBtnEl.textContent = '合成中...';

    try {
      // Use a test sentence (Sebastian's greeting)
      const testText = '哦呀哦呀，少爷，今天气色看着倒是不错，是发生了什么好事吗？';
      const result = await window.dash.synthesizeSpeech(testText);

      if (result.fileUrl) {
        // Play the audio
        const audio = new Audio(result.fileUrl);
        audio.play();
        voicePreviewChineseBtnEl.textContent = '播放中...';

        audio.onended = () => {
          voicePreviewChineseBtnEl.textContent = '试听';
          voicePreviewChineseBtnEl.disabled = false;
        };

        // Timeout to restore button state after 30 seconds
        setTimeout(() => {
          if (voicePreviewChineseBtnEl.textContent === '播放中...') {
            voicePreviewChineseBtnEl.textContent = '试听';
            voicePreviewChineseBtnEl.disabled = false;
          }
        }, 30000);
      } else {
        alert('合成失败，请检查网络连接');
        voicePreviewChineseBtnEl.textContent = '试听';
        voicePreviewChineseBtnEl.disabled = false;
      }
    } catch (err) {
      console.error('Voice preview error:', err);
      alert('试听出错: ' + err.message);
      voicePreviewChineseBtnEl.textContent = '试听';
      voicePreviewChineseBtnEl.disabled = false;
    }
  });
}

voiceSttEngineSelectEl.addEventListener('change', (e) => {
  window.dash.setSetting('voiceSttEngine', e.target.value);
});

let piperModelAvailable = false;
function updateTtsEnginePiperWarning() {
  voiceTtsEnginePiperWarningEl.style.display =
    voiceTtsEngineSelectEl.value === 'piper' && !piperModelAvailable && voiceEnabledEl.checked ? 'block' : 'none';
}

voiceTtsEngineSelectEl.addEventListener('change', (e) => {
  window.dash.setSetting('voiceTtsEngine', e.target.value);
  updateTtsEnginePiperWarning();
  updateVoiceNameGroupVisibility();
  if (e.target.value === 'mimo-cloud') ensureMimoVoicesLoaded();
  voiceTtsEngineStatusEl.textContent = '';
});

const voiceTtsEngineApplyBtnEl = document.getElementById('voiceTtsEngineApplyBtn');
voiceTtsEngineApplyBtnEl.addEventListener('click', async () => {
  const engine = voiceTtsEngineSelectEl.value;
  voiceTtsEngineApplyBtnEl.disabled = true;
  voiceTtsEngineStatusEl.style.color = '';
  voiceTtsEngineStatusEl.textContent = '检测中…';
  try {
    const result = await window.dash.testTtsEngine(engine);
    voiceTtsEngineStatusEl.style.color = result.ok ? '#2e8b45' : '#c4304a';
    voiceTtsEngineStatusEl.textContent = result.ok ? `✓ 已配置（${result.detail}）` : `✗ ${result.detail}`;
  } catch (err) {
    voiceTtsEngineStatusEl.style.color = '#c4304a';
    voiceTtsEngineStatusEl.textContent = `✗ 检测失败: ${err.message}`;
  } finally {
    voiceTtsEngineApplyBtnEl.disabled = false;
  }
});

const voiceSttEngineApplyBtnEl = document.getElementById('voiceSttEngineApplyBtn');
const voiceSttEngineStatusEl = document.getElementById('voiceSttEngineStatus');
voiceSttEngineApplyBtnEl.addEventListener('click', async () => {
  const engine = voiceSttEngineSelectEl.value;
  voiceSttEngineApplyBtnEl.disabled = true;
  voiceSttEngineStatusEl.style.color = '';
  voiceSttEngineStatusEl.textContent = '检测中…';
  try {
    const result = await window.dash.testSttEngine(engine);
    voiceSttEngineStatusEl.style.color = result.ok ? '#2e8b45' : '#c4304a';
    voiceSttEngineStatusEl.textContent = result.ok ? `✓ 已配置（${result.detail}）` : `✗ ${result.detail}`;
  } catch (err) {
    voiceSttEngineStatusEl.style.color = '#c4304a';
    voiceSttEngineStatusEl.textContent = `✗ 检测失败: ${err.message}`;
  } finally {
    voiceSttEngineApplyBtnEl.disabled = false;
  }
});

voiceMimoApiKeyInputEl.addEventListener('change', (e) => {
  window.dash.setSetting('voiceMimoApiKey', e.target.value);
});

voiceMimoVoiceZhSelectEl.addEventListener('change', (e) => {
  window.dash.setSetting('voiceMimoVoiceZh', e.target.value);
});

voiceMimoVoiceEnSelectEl.addEventListener('change', (e) => {
  window.dash.setSetting('voiceMimoVoiceEn', e.target.value);
});

voiceMimoStyleSelectEl.addEventListener('change', (e) => {
  window.dash.setSetting('voiceMimoStyleTagZh', e.target.value);
});

function wireMimoPreviewButton(btnEl, testText) {
  if (!btnEl) return;
  const idleLabel = btnEl.textContent;
  btnEl.addEventListener('click', async () => {
    if (!voiceMimoApiKeyInputEl.value) {
      alert('请先填写 MiMo API Key');
      return;
    }
    btnEl.disabled = true;
    btnEl.textContent = idleLabel === 'Preview' ? 'Generating...' : '合成中...';
    try {
      const result = await window.dash.synthesizeSpeech(testText);
      if (result.fileUrl) {
        const audio = new Audio(result.fileUrl);
        audio.play();
        btnEl.textContent = idleLabel === 'Preview' ? 'Playing...' : '播放中...';
        audio.onended = () => {
          btnEl.textContent = idleLabel;
          btnEl.disabled = false;
        };
        setTimeout(() => {
          btnEl.textContent = idleLabel;
          btnEl.disabled = false;
        }, 30000);
      } else {
        alert('合成失败，请检查 API Key 和网络连接');
        btnEl.textContent = idleLabel;
        btnEl.disabled = false;
      }
    } catch (err) {
      console.error('MiMo preview error:', err);
      alert('试听出错: ' + err.message);
      btnEl.textContent = idleLabel;
      btnEl.disabled = false;
    }
  });
}

wireMimoPreviewButton(voicePreviewMimoZhBtnEl, '哦呀哦呀，少爷，今天气色看着倒是不错，是发生了什么好事吗？');
wireMimoPreviewButton(voicePreviewMimoEnBtnEl, 'Ah, young master, you look rather well this evening.');

voiceCpuModeEl.addEventListener('change', (e) => {
  window.dash.setSetting('voiceCpuMode', e.target.checked);
});

const voiceTtsFallbackLogBtnEl = document.getElementById('voiceTtsFallbackLogBtn');
const voiceTtsFallbackLogEl = document.getElementById('voiceTtsFallbackLogEl');
if (voiceTtsFallbackLogBtnEl) {
  voiceTtsFallbackLogBtnEl.addEventListener('click', async () => {
    const showing = voiceTtsFallbackLogEl.style.display !== 'none';
    if (showing) {
      voiceTtsFallbackLogEl.style.display = 'none';
      return;
    }
    const { lines } = await window.dash.getTtsFallbackLog();
    voiceTtsFallbackLogEl.textContent = lines.length ? lines.join('\n') : '（暂无降级记录——说明目前没有引擎失败过）';
    voiceTtsFallbackLogEl.style.display = 'block';
  });
}

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

const chatReplyLanguageSelectEl2 = document.getElementById('chatReplyLanguageSelect');
if (chatReplyLanguageSelectEl2) {
  chatReplyLanguageSelectEl2.addEventListener('change', (e) => {
    window.dash.setSetting('chatReplyLanguage', e.target.value);
  });
}

const chatCatchphrasesUpdateBtnEl = document.getElementById('chatCatchphrasesUpdateBtn');
const chatCatchphrasesStatusEl = document.getElementById('chatCatchphrasesStatus');
let chatCatchphrasesStatusTimer = null;
if (chatCatchphrasesUpdateBtnEl) {
  chatCatchphrasesUpdateBtnEl.addEventListener('click', () => {
    const inputEl = document.getElementById('chatCatchphrasesInput');
    window.dash.setSetting('chatCatchphrases', inputEl.value);
    if (chatCatchphrasesStatusTimer) clearTimeout(chatCatchphrasesStatusTimer);
    chatCatchphrasesStatusEl.style.color = '#2e8b45';
    chatCatchphrasesStatusEl.textContent = '✓ 已更新，下一条回复即可生效';
    chatCatchphrasesStatusTimer = setTimeout(() => {
      chatCatchphrasesStatusEl.textContent = '';
    }, 60000);
  });
}

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
  dashWindowOpacityEl.value = settings.dashboardPanelAlpha ?? 0.92;
  applyWindowOpacityDisplay(Number(dashWindowOpacityEl.value));
  dashModuleAlphaEl.value = settings.moduleAlpha ?? 0.92;
  applyModuleAlpha(Number(dashModuleAlphaEl.value));
  customThemesCache = settings.customPresets ?? [];
  rebuildCustomThemeOptions();
  if (settings.activeCustomThemeId) {
    dashThemePresetEl.value = `custom:${settings.activeCustomThemeId}`;
    const entry = customThemesCache.find((p) => p.id === settings.activeCustomThemeId);
    applyThemePreset((entry ?? {}).preset ?? settings.themePreset ?? 'classic');
    dashThemeCustomNameEl.value = entry ? entry.name : '';
    dashThemeCustomActionsRowEl.style.display = entry ? 'flex' : 'none';
  } else {
    dashThemePresetEl.value = settings.themePreset ?? 'classic';
    applyThemePreset(dashThemePresetEl.value);
    dashThemeCustomNameEl.value = '';
    dashThemeCustomActionsRowEl.style.display = 'none';
  }
  dashUiScaleEl.value = String(settings.uiScale ?? 1);
  applyUiScale(Number(dashUiScaleEl.value));
  graphFollowTheme = settings.graphFollowTheme ?? true;
  dashGraphFollowThemeEl.checked = graphFollowTheme;
  dashSkinColorEl.value = settings.petSkinColor ?? DEFAULT_SKIN_COLOR;
  accentColorPicker.initFrom(settings.accentColor);
  textColorPicker.initFrom(settings.textColor);
  bgColorPicker.initFrom(settings.backgroundColor);
  dashBgAlphaEl.value = String(settings.backgroundAlpha ?? 1);
  applyBgAlpha(Number(dashBgAlphaEl.value));
  applyBgImage(settings.backgroundImageUrl);
  bgImageNameEl.textContent = settings.backgroundImageName ? `已选择：${settings.backgroundImageName}` : '（未设置，用背景颜色）';
  dashMusicCommentChanceEl.value = String(settings.musicCommentChance ?? 0.08);
  dashMusicCommentChanceValueEl.textContent = `${Math.round(Number(dashMusicCommentChanceEl.value) * 100)}%`;
  dashMusicCommentCooldownEl.value = String(Math.round((settings.musicCommentCooldownMs ?? 120000) / 1000));
  dashMusicCommentCooldownValueEl.textContent = `${dashMusicCommentCooldownEl.value} 秒`;
  dashMemoryEnabledEl.checked = !!settings.memoryEnabled;
  dashScreenTipsEnabledEl.checked = !!settings.screenTipsEnabled;
  dashScreenTipsAutoIntervalEl.value = String(settings.screenTipsIntervalMs ?? 180000);
  dashCameraSenseEnabledEl.checked = !!settings.cameraSenseEnabled;
  dashCameraSenseIntervalEl.value = String(settings.cameraSenseIntervalMs ?? 120000);
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
  voicePushToTalkKeyEl.value = settings.voicePushToTalkKey ?? 'Alt+G';
  pendingVoiceSelection = settings.voiceVoiceName ?? '';
  voiceVoiceNameSelectEl.value = pendingVoiceSelection;
  voiceSttEngineSelectEl.value = settings.voiceSttEngine ?? 'sapi';
  voiceTtsEngineSelectEl.value = settings.voiceTtsEngine ?? 'sapi';
  voiceEdgeEnglishSelectEl.value = settings.voiceEdgeEnglishName ?? '';
  voiceEdgeChineseSelectEl.value = settings.voiceEdgeChineseName ?? '';
  piperModelAvailable = !!settings.voiceTtsEngineAvailable?.piper;
  voiceCpuModeEl.checked = !!settings.voiceCpuMode;
  voiceMimoApiKeyInputEl.value = settings.voiceMimoApiKey ?? '';
  pendingMimoVoiceZh = settings.voiceMimoVoiceZh ?? '白桦';
  pendingMimoVoiceEn = settings.voiceMimoVoiceEn ?? 'Dean';
  pendingMimoStyleTagZh = settings.voiceMimoStyleTagZh ?? '';
  for (const group of voiceSettingsGroups) {
    group.style.display = !!settings.voiceEnabled ? 'block' : 'none';
  }
  updateTtsEnginePiperWarning();
  updateVoiceNameGroupVisibility();
  if (voiceTtsEngineSelectEl.value === 'mimo-cloud') {
    ensureMimoVoicesLoaded().then(() => {
      voiceMimoVoiceZhSelectEl.value = pendingMimoVoiceZh;
      voiceMimoVoiceEnSelectEl.value = pendingMimoVoiceEn;
      voiceMimoStyleSelectEl.value = pendingMimoStyleTagZh;
    });
  }
  if (settings.gpu) {
    voiceGpuStatusHintEl.style.display = 'block';
    voiceGpuStatusHintEl.textContent = settings.gpu.available
      ? `检测到独立显卡：${settings.gpu.name} —— 本地高质量语音克隆引擎（IndexTTS2/OpenVoice等）以后可用`
      : `未检测到 NVIDIA 独立显卡（${settings.gpu.reason ?? '仅集显'}）—— 本地语音克隆引擎不可用，已隐藏；建议用 Edge 或 MiMo 云端引擎`;
  }

  // Populate chat settings
  chatEnabledEl.checked = !!settings.chatEnabled;
  chatVoiceModeEl.checked = !!settings.chatVoiceMode;
  chatProviderEl.value = settings.chatProvider ?? 'ollama';
  chatOllamaUrlEl.value = settings.chatOllamaUrl ?? 'http://localhost:11434';
  chatModelEl.value = settings.chatModel ?? 'gemma4:12b';
  const chatCatchphrasesInputEl = document.getElementById('chatCatchphrasesInput');
  if (chatCatchphrasesInputEl) chatCatchphrasesInputEl.value = settings.chatCatchphrases ?? '';
  const chatReplyLanguageSelectEl = document.getElementById('chatReplyLanguageSelect');
  if (chatReplyLanguageSelectEl) chatReplyLanguageSelectEl.value = settings.chatReplyLanguage ?? 'zh';
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
const chatTabHistBtnEl = document.getElementById('chatTabHistBtn');
const chatTabNewBtnEl = document.getElementById('chatTabNewBtn');
const chatTabConvListEl = document.getElementById('chatTabConvList');
const chatTabScreenshotBtnEl = document.getElementById('chatTabScreenshotBtn');
const chatTabScreenshotChipEl = document.getElementById('chatTabScreenshotChip');
const chatTabScreenshotChipClearEl = document.getElementById('chatTabScreenshotChipClear');

let chatTabPendingBubble = null;
let chatTabSpeechBuffer = '';
let chatTabVoiceConfig = null;
let chatTabLoaded = false;
let chatTabHistView = false;
// Mirrors the pet window's chatSendPending guard (see renderer.js) --
// without it, sending a second message while the first is still
// streaming silently reassigns chatTabPendingBubble, losing the first
// bubble's reference and leaving it stuck showing "…" forever.
let chatTabSendPending = false;
let chatTabPendingScreenshotBase64 = null;

function appendChatTabMessage(role, text) {
  const div = document.createElement('div');
  div.className = `chat-tab-msg ${role}`;
  div.textContent = text;
  chatTabMessagesEl.appendChild(div);
  chatTabMessagesEl.scrollTop = chatTabMessagesEl.scrollHeight;
  return div;
}

function setChatTabSendPending(pending) {
  chatTabSendPending = pending;
  chatTabInputEl.disabled = pending;
  chatTabSendEl.disabled = pending;
}

function clearChatTabPendingScreenshot() {
  chatTabPendingScreenshotBase64 = null;
  chatTabScreenshotChipEl.style.display = 'none';
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

function showChatTabMessagesView() {
  chatTabHistView = false;
  chatTabConvListEl.style.display = 'none';
  chatTabMessagesEl.style.display = 'block';
}

function showChatTabHistView() {
  chatTabHistView = true;
  chatTabMessagesEl.style.display = 'none';
  chatTabConvListEl.style.display = 'block';
  window.dash.requestChatConvList();
}

function renderChatTabConvList(convs) {
  chatTabConvListEl.replaceChildren();
  if (!convs?.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-tab-conv-empty';
    empty.textContent = '还没有历史对话';
    chatTabConvListEl.appendChild(empty);
    return;
  }
  for (const c of convs) {
    const row = document.createElement('div');
    row.className = `chat-tab-conv-item${c.active ? ' active' : ''}`;
    const textWrap = document.createElement('div');
    textWrap.className = 'chat-tab-conv-item-text';
    const title = document.createElement('div');
    title.className = 'chat-tab-conv-item-title';
    title.textContent = c.title;
    const sub = document.createElement('div');
    sub.className = 'chat-tab-conv-item-sub';
    sub.textContent = c.subtitle;
    textWrap.appendChild(title);
    textWrap.appendChild(sub);
    const del = document.createElement('button');
    del.className = 'chat-tab-conv-item-del';
    del.textContent = '✕';
    del.title = '删除';
    row.appendChild(textWrap);
    row.appendChild(del);
    row.addEventListener('click', () => {
      window.dash.switchChatConv(c.id);
      showChatTabMessagesView();
    });
    // Two-step delete, same pattern as the pet window's own history list --
    // click once to arm, click again within a couple seconds to confirm.
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
      window.dash.deleteChatConv(c.id);
    });
    chatTabConvListEl.appendChild(row);
  }
}

function sendChatTabMessage() {
  if (chatTabSendPending) return;
  const text = chatTabInputEl.value.trim();
  if (!text) return;
  chatTabInputEl.value = '';
  appendChatTabMessage('user', text);
  chatTabPendingBubble = appendChatTabMessage('assistant', '…');
  chatTabPendingBubble.classList.add('pending');
  setChatTabSendPending(true);
  if (chatTabPendingScreenshotBase64) {
    window.dash.chatSendWithImage(text, chatTabPendingScreenshotBase64);
    clearChatTabPendingScreenshot();
  } else {
    window.dash.chatSend(text);
  }
}

chatTabSendEl.addEventListener('click', sendChatTabMessage);
chatTabInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChatTabMessage();
});

chatTabHistBtnEl.addEventListener('click', () => {
  if (chatTabHistView) showChatTabMessagesView();
  else showChatTabHistView();
});
chatTabNewBtnEl.addEventListener('click', () => {
  window.dash.newChatConv();
  showChatTabMessagesView();
});
window.dash.onChatConvList(({ convs }) => renderChatTabConvList(convs));
window.dash.onChatHistory(({ messages }) => {
  chatTabMessagesEl.replaceChildren();
  for (const m of messages ?? []) {
    if (m.role === 'user' || m.role === 'assistant') appendChatTabMessage(m.role, m.content);
  }
  chatTabPendingBubble = null;
});

chatTabScreenshotBtnEl.addEventListener('click', async () => {
  chatTabScreenshotBtnEl.disabled = true;
  chatTabScreenshotBtnEl.textContent = '…';
  try {
    const res = await window.dash.captureScreenshot();
    if (res.ok) {
      chatTabPendingScreenshotBase64 = res.imageBase64;
      chatTabScreenshotChipEl.style.display = 'flex';
      chatTabInputEl.focus();
    } else {
      appendChatTabMessage('error', `截屏失败：${res.error}`);
    }
  } finally {
    chatTabScreenshotBtnEl.disabled = false;
    chatTabScreenshotBtnEl.textContent = '📸';
  }
});
chatTabScreenshotChipClearEl.addEventListener('click', clearChatTabPendingScreenshot);

window.dash.onChatDelta(({ text }) => {
  if (!chatTabPendingBubble) chatTabPendingBubble = appendChatTabMessage('assistant', '');
  chatTabPendingBubble.classList.remove('pending');
  if (chatTabPendingBubble.textContent === '…') chatTabPendingBubble.textContent = '';
  chatTabPendingBubble.textContent += text;
  chatTabMessagesEl.scrollTop = chatTabMessagesEl.scrollHeight;
});

window.dash.onChatMessageDone(() => {
  chatTabPendingBubble = null;
  setChatTabSendPending(false);
});

window.dash.onChatError(({ message }) => {
  if (chatTabPendingBubble) {
    chatTabPendingBubble.remove();
    chatTabPendingBubble = null;
  }
  appendChatTabMessage('error', message);
  setChatTabSendPending(false);
});

window.dash.onChatSpeakDelta(({ delta, voiceConfig }) => {
  chatTabVoiceConfig = voiceConfig;
  chatTabSpeechBuffer += delta;
  // cpuMode: see the identical comment in renderer.js -- defers all
  // speech to onChatComplete so speech synthesis never competes with
  // in-progress token generation for this machine's CPU.
  if (voiceConfig?.cpuMode) return;
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

// Same hybrid hold-or-toggle pattern as the pet window's own 🎤 button
// (see renderer.js's pttPress/pttRelease) -- a quick tap starts listening
// and stays on until tapped again, a genuine press-and-hold only listens
// while held. Kept as an independent copy rather than a shared module
// since this is a separate window/renderer with its own DOM and its own
// window.dash bridge instead of window.pet.
const CHAT_TAB_PTT_QUICK_CLICK_MS = 350;
let chatTabPttListening = false;
let chatTabPttToggled = false;
let chatTabPttDownAt = 0;
// True from the moment the mic stops listening until a transcript or
// error actually arrives -- SAPI's async recognizer can take a couple of
// seconds to finalize the last utterance after RecognizeAsyncStop(), and
// with no visible state in between this looked exactly like "recorded it
// but nothing happened" (confirmed live) until a *second* click's own
// transcript coincidentally arrived and got mistaken for the first.
let chatTabPttRecognizing = false;

function chatTabPttSetVisual() {
  chatTabVoiceBtnEl.classList.toggle('listening', chatTabPttListening);
  chatTabVoiceBtnEl.classList.toggle('recognizing', !chatTabPttListening && chatTabPttRecognizing);
  chatTabVoiceBtnEl.title = chatTabPttRecognizing ? '正在识别…' : '点一下开始/停止说话，或按住说话';
}

function chatTabPttPress() {
  chatTabPttDownAt = performance.now();
  if (!chatTabPttListening) {
    chatTabPttListening = true;
    chatTabPttRecognizing = false;
    chatTabPttSetVisual();
    window.dash.voicePptStart();
  }
}

function chatTabPttRelease() {
  if (!chatTabPttListening) return;
  if (chatTabPttToggled) {
    chatTabPttListening = false;
    chatTabPttToggled = false;
    chatTabPttRecognizing = true;
    chatTabPttSetVisual();
    window.dash.voicePptStop();
    return;
  }
  if (performance.now() - chatTabPttDownAt < CHAT_TAB_PTT_QUICK_CLICK_MS) {
    chatTabPttToggled = true;
    return;
  }
  chatTabPttListening = false;
  chatTabPttRecognizing = true;
  chatTabPttSetVisual();
  window.dash.voicePptStop();
}

chatTabVoiceBtnEl.addEventListener('mousedown', chatTabPttPress);
chatTabVoiceBtnEl.addEventListener('mouseup', chatTabPttRelease);
chatTabVoiceBtnEl.addEventListener('mouseleave', () => {
  if (chatTabPttListening && !chatTabPttToggled) chatTabPttRelease();
});

// Call mode: one global always-listening toggle (backed by the same STT
// watcher push-to-talk uses) instead of holding/tapping the mic button
// per utterance. While active, the mic button is disabled -- it and call
// mode both drive the one shared listening state, and pressing it mid-call
// would just fight the call-mode toggle for control of the same watcher.
const chatTabCallModeBtnEl = document.getElementById('chatTabCallModeBtn');
chatTabCallModeBtnEl.addEventListener('click', () => window.dash.voiceCallModeToggle());
window.dash.onVoiceCallModeState(({ active }) => {
  chatTabCallModeBtnEl.classList.toggle('active', active);
  chatTabVoiceBtnEl.disabled = active;
});

window.dash.onVoiceTranscript((text) => {
  chatTabPttRecognizing = false;
  chatTabPttSetVisual();
  if (!text) return;
  const current = chatTabInputEl.value.trim();
  // 🎤 marks this input as (at least partly) voice-recognized, distinct
  // from typed text, in both the input box and -- since whatever's in the
  // box at send time becomes the message verbatim -- the resulting chat
  // bubble too.
  if (current.startsWith('🎤')) {
    chatTabInputEl.value = `${current} ${text}`;
  } else {
    chatTabInputEl.value = current ? `🎤 ${current} ${text}` : `🎤 ${text}`;
  }
  chatTabInputEl.focus();
});
window.dash.onVoiceError(({ message }) => {
  chatTabPttRecognizing = false;
  chatTabPttSetVisual();
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
  { key: 'celebrate', label: '任务完成（celebrate）' },
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

// --- character request generator ------------------------------------
// Purely local document/prompt generation -- no AI call of its own. The
// checklist mirrors this app's actual fixed sprite-sheet contract (see
// atlas.js: every pet pack must lay out exactly this row order to load),
// pre-filled so a new-character request starts from what the app really
// needs rather than a blank list the user has to reconstruct from scratch.
const DEFAULT_ACTION_CHECKLIST = [
  { label: 'IDLE 待机', desc: '静止不动时的呼吸感循环动作' },
  { label: 'RUN_RIGHT 向右移动', desc: '向右走/跑的循环动作' },
  { label: 'RUN_LEFT 向左移动', desc: '向左走/跑的循环动作' },
  { label: 'WAVING 挥手', desc: '打招呼、挥手示意' },
  { label: 'JUMPING 跳跃', desc: '跳起来的动作' },
  { label: 'PECK 专注做事', desc: '埋头认真干活/啄食一类的专注动作' },
  { label: 'WAITING 等待', desc: '张望、等待中的小动作' },
  { label: 'DOZE 打盹', desc: '犯困、打瞌睡的动作' },
  { label: 'REVIEW 审阅思考', desc: '思考、审视的姿态' },
  { label: 'TURN_A 转头看向镜头（前半段）', desc: '头部从 0° 转到 157.5° 的连续帧' },
  { label: 'TURN_B 转头看向镜头（后半段）', desc: '头部从 180° 转到 337.5° 的连续帧' },
  { label: 'PERCH 栖息（可选）', desc: '抓握/栖息的静态姿势' },
  { label: 'LIE_DOWN 侧躺休息（可选）', desc: '侧躺着呼吸的休息动作' },
].map((item, i) => ({ ...item, frames: ROW_FRAME_COUNTS[i] ?? 6 }));

let charReqImages = [];
let charReqChecklist = DEFAULT_ACTION_CHECKLIST.map((item) => ({ ...item }));

const charReqDescriptionEl = document.getElementById('charReqDescription');
const charReqPickImagesBtnEl = document.getElementById('charReqPickImagesBtn');
const charReqImagesHintEl = document.getElementById('charReqImagesHint');
const charReqImageGridEl = document.getElementById('charReqImageGrid');
const charReqChecklistEl = document.getElementById('charReqChecklist');
const charReqAddRowBtnEl = document.getElementById('charReqAddRowBtn');
const charReqGenerateBtnEl = document.getElementById('charReqGenerateBtn');
const charReqGenerateHintEl = document.getElementById('charReqGenerateHint');
const charReqResultEl = document.getElementById('charReqResult');
const charReqDocPathEl = document.getElementById('charReqDocPath');
const charReqPromptOutputEl = document.getElementById('charReqPromptOutput');
const charReqCopyPromptBtnEl = document.getElementById('charReqCopyPromptBtn');

function renderCharReqImages() {
  charReqImageGridEl.replaceChildren();
  for (const img of charReqImages) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.padding = '6px';
    const thumb = document.createElement('img');
    thumb.src = img.url;
    thumb.style.cssText = 'width:100%; height:80px; object-fit:cover; border-radius:4px; display:block;';
    const name = document.createElement('div');
    name.className = 'hint';
    name.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    name.textContent = img.name;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn';
    removeBtn.textContent = '移除';
    removeBtn.style.marginTop = '4px';
    removeBtn.addEventListener('click', () => {
      charReqImages = charReqImages.filter((x) => x.path !== img.path);
      renderCharReqImages();
    });
    card.appendChild(thumb);
    card.appendChild(name);
    card.appendChild(removeBtn);
    charReqImageGridEl.appendChild(card);
  }
  charReqImagesHintEl.textContent = charReqImages.length ? `已选 ${charReqImages.length}/5 张` : '';
}

charReqPickImagesBtnEl.addEventListener('click', async () => {
  if (charReqImages.length >= 5) {
    charReqImagesHintEl.textContent = '最多 5 张，先移除几张再加';
    return;
  }
  const res = await window.dash.pickCharacterImages();
  if (!res.ok) return;
  const existingPaths = new Set(charReqImages.map((x) => x.path));
  for (const img of res.images) {
    if (charReqImages.length >= 5) break;
    if (existingPaths.has(img.path)) continue;
    charReqImages.push(img);
  }
  renderCharReqImages();
});

function renderCharReqChecklist() {
  charReqChecklistEl.replaceChildren();
  charReqChecklist.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'field-row';
    row.style.flexWrap = 'wrap';

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = item.label;
    labelInput.style.cssText = 'flex:0 0 220px;';
    labelInput.addEventListener('input', () => { item.label = labelInput.value; });

    const framesInput = document.createElement('input');
    framesInput.type = 'number';
    framesInput.min = '1';
    framesInput.value = String(item.frames);
    framesInput.style.cssText = 'flex:0 0 70px;';
    framesInput.title = '帧数';
    framesInput.addEventListener('input', () => { item.frames = Math.max(1, Number(framesInput.value) || 1); });

    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.value = item.desc;
    descInput.placeholder = '这个动作的具体描述';
    descInput.style.cssText = 'flex:1; min-width:200px;';
    descInput.addEventListener('input', () => { item.desc = descInput.value; });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => {
      charReqChecklist = charReqChecklist.filter((x) => x !== item);
      renderCharReqChecklist();
    });

    row.appendChild(labelInput);
    row.appendChild(framesInput);
    row.appendChild(descInput);
    row.appendChild(delBtn);
    charReqChecklistEl.appendChild(row);
  });
}
renderCharReqChecklist();

charReqAddRowBtnEl.addEventListener('click', () => {
  charReqChecklist.push({ label: '新动作', frames: 6, desc: '' });
  renderCharReqChecklist();
});

function buildCharacterPrompt(description, checklist) {
  const totalHeight = checklist.length * ATLAS.cellH;
  const rowLines = checklist
    .map((item, i) => `Row ${i + 1} (${item.frames} frames): ${item.label} -- ${item.desc || '(no description)'}`)
    .join('\n');
  return `Create a character sprite sheet, exactly ${ATLAS.cellW * ATLAS.cols}x${totalHeight}px, arranged in ${ATLAS.cols} columns x ${checklist.length} rows, each cell exactly ${ATLAS.cellW}x${ATLAS.cellH}px, transparent PNG background. Keep the character's proportions, colors, and design fully consistent across every frame and every row.

Character description: ${description || '(see reference images)'}

Row-by-row action sequences, top to bottom:
${rowLines}

Match the style of the attached reference image(s) as closely as possible.`;
}

charReqGenerateBtnEl.addEventListener('click', async () => {
  charReqGenerateBtnEl.disabled = true;
  charReqGenerateHintEl.textContent = '生成中…';
  try {
    const description = charReqDescriptionEl.value.trim();
    const promptText = buildCharacterPrompt(description, charReqChecklist);
    const res = await window.dash.generateCharacterDoc({
      description,
      imagePaths: charReqImages.map((img) => img.path),
      checklist: charReqChecklist,
      promptText,
    });
    if (!res.ok) {
      charReqGenerateHintEl.textContent = res.error || '生成失败';
      return;
    }
    charReqDocPathEl.value = res.docPath;
    charReqPromptOutputEl.value = promptText;
    charReqResultEl.style.display = 'block';
    charReqGenerateHintEl.textContent = '已生成';
  } finally {
    charReqGenerateBtnEl.disabled = false;
  }
});

charReqCopyPromptBtnEl.addEventListener('click', async () => {
  await navigator.clipboard.writeText(charReqPromptOutputEl.value);
  charReqGenerateHintEl.textContent = '已复制';
});

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
// One full graph palette per theme preset -- 'classic' reproduces the
// original hardcoded values exactly (zero visual change for anyone who's
// never touched 外观). Category hues stay distinguishable but shift
// slightly per theme so they still read well against that theme's own
// background (e.g. cyber-green's are brighter/more saturated for
// legibility on a near-black canvas). Falls back to 'classic' for any
// preset not listed here (dark-red/dark-pink share light-pink's warm
// palette shape rather than each getting a bespoke one -- diminishing
// returns past a certain point). Read via currentGraphPalette(), which
// also handles the graphFollowTheme toggle.
const GRAPH_PALETTES = {
  classic: {
    bg0: 'rgba(250, 244, 241, 1)', bg1: 'rgba(238, 226, 220, 1)',
    textRgb: '40, 16, 20', labelBgRgb: '255, 255, 255', nodeStrokeRgb: '255, 255, 255', hoverStrokeRgb: '40, 16, 20',
    categories: { 身份: '#c44a30', 项目: '#4a7fc4', 喜好: '#8a4ac4', 习惯: '#4ac48a', 事件: '#c4a04a', 其他: '#888888' },
  },
  'dark-red': {
    bg0: 'rgba(46, 34, 36, 1)', bg1: 'rgba(24, 17, 18, 1)',
    textRgb: '232, 222, 220', labelBgRgb: '46, 34, 36', nodeStrokeRgb: '232, 222, 220', hoverStrokeRgb: '10, 10, 10',
    categories: { 身份: '#e0664a', 项目: '#6a9fe0', 喜好: '#ac6ae0', 习惯: '#6ae0a0', 事件: '#e0bc5a', 其他: '#a8a0a0' },
  },
  'dark-pink': {
    bg0: 'rgba(46, 34, 42, 1)', bg1: 'rgba(24, 17, 21, 1)',
    textRgb: '232, 224, 228', labelBgRgb: '46, 34, 42', nodeStrokeRgb: '232, 224, 228', hoverStrokeRgb: '10, 10, 10',
    categories: { 身份: '#e0664a', 项目: '#6a9fe0', 喜好: '#c26ae0', 习惯: '#6ae0a0', 事件: '#e0bc5a', 其他: '#a8a0a8' },
  },
  'light-pink': {
    bg0: 'rgba(253, 244, 248, 1)', bg1: 'rgba(244, 224, 232, 1)',
    textRgb: '64, 24, 38', labelBgRgb: '255, 255, 255', nodeStrokeRgb: '255, 255, 255', hoverStrokeRgb: '64, 24, 38',
    categories: { 身份: '#c4304a', 项目: '#4a7fc4', 喜好: '#a44ac4', 习惯: '#4ac48a', 事件: '#c4a04a', 其他: '#888888' },
  },
  'cyber-green': {
    bg0: 'rgba(24, 40, 32, 1)', bg1: 'rgba(10, 16, 13, 1)',
    textRgb: '210, 255, 228', labelBgRgb: '16, 28, 22', nodeStrokeRgb: '0, 230, 118', hoverStrokeRgb: '210, 255, 228',
    categories: { 身份: '#ff6a4a', 项目: '#4ad2ff', 喜好: '#c94aff', 习惯: '#4aff9c', 事件: '#ffd24a', 其他: '#7fcf9f' },
  },
  'liquid-glass': {
    bg0: 'rgba(250, 250, 252, 1)', bg1: 'rgba(230, 230, 236, 1)',
    textRgb: '51, 51, 51', labelBgRgb: '255, 255, 255', nodeStrokeRgb: '255, 255, 255', hoverStrokeRgb: '0, 122, 255',
    categories: { 身份: '#ff3b30', 项目: '#007aff', 喜好: '#af52de', 习惯: '#34c759', 事件: '#ff9500', 其他: '#8e8e93' },
  },
};
let graphFollowTheme = true;
function currentGraphPalette() {
  const theme = graphFollowTheme ? (document.documentElement.getAttribute('data-theme') || 'classic') : 'classic';
  return GRAPH_PALETTES[theme] ?? GRAPH_PALETTES.classic;
}
const dashGraphFollowThemeEl = document.getElementById('dashGraphFollowTheme');
dashGraphFollowThemeEl.addEventListener('change', () => {
  graphFollowTheme = dashGraphFollowThemeEl.checked;
  window.dash.setSetting('graphFollowTheme', graphFollowTheme);
  if (graphRunning) drawGraph();
});

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

// Cached once per theme key -- recreating a canvas-sized gradient every
// frame is wasted work when the canvas itself doesn't resize, but it must
// still be invalidated whenever the active theme (or the "跟随主题" toggle)
// changes, or switching themes wouldn't visibly re-tint the graph.
let graphBgGradient = null;
let graphBgGradientKey = '';
function graphBackground(ctx, W, H, palette, key) {
  if (!graphBgGradient || graphBgGradientKey !== key) {
    graphBgGradient = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) / 1.3);
    graphBgGradient.addColorStop(0, palette.bg0);
    graphBgGradient.addColorStop(1, palette.bg1);
    graphBgGradientKey = key;
  }
  ctx.fillStyle = graphBgGradient;
  ctx.fillRect(0, 0, W, H);
}

function drawGraph() {
  const W = memoryGraphCanvasEl.width;
  const H = memoryGraphCanvasEl.height;
  const ctx = memoryGraphCtx;
  const palette = currentGraphPalette();
  const paletteKey = graphFollowTheme ? (document.documentElement.getAttribute('data-theme') || 'classic') : 'classic';
  const categoryColor = palette.categories;
  graphBackground(ctx, W, H, palette, paletteKey);

  // Edges: a soft gradient between each pair's own category colours (rather
  // than one flat line colour for everything) so the connection itself
  // hints at what's being related, and weight modulates thickness/opacity
  // so a strong semantic match reads as a stronger line, not the same as a
  // borderline one.
  for (const [a, b, weight] of graphEdges) {
    const w = weight ?? 0.6;
    const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    const colorA = categoryColor[a.category] ?? categoryColor.其他;
    const colorB = categoryColor[b.category] ?? categoryColor.其他;
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
    const baseColor = categoryColor[n.category] ?? categoryColor.其他;
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
    ctx.strokeStyle = isHover ? `rgba(${palette.hoverStrokeRgb}, 0.7)` : `rgba(${palette.nodeStrokeRgb}, 0.85)`;
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
    ctx.shadowColor = `rgba(${palette.textRgb}, 0.15)`;
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = `rgba(${palette.labelBgRgb}, 0.97)`;
    roundRectPath(ctx, boxX, boxY, boxW, boxH, 5);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = `rgba(${palette.textRgb}, 0.15)`;
    ctx.lineWidth = 1;
    roundRectPath(ctx, boxX, boxY, boxW, boxH, 5);
    ctx.stroke();
    ctx.fillStyle = `rgba(${palette.textRgb}, 0.92)`;
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
  const palette = currentGraphPalette();
  const categoryColor = palette.categories[n.category] ?? palette.categories.其他;
  cat.innerHTML = `<span class="memory-category-badge" style="background:${categoryColor};color:#fff;">${escapeHtml(n.category)}</span> 重要性 ${importanceDots(n.importance)}`;
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
  const palette = currentGraphPalette();
  for (const [cat, color] of Object.entries(palette.categories)) {
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

// --- backup / migration ---------------------------------------------------
// config.json + data/ are both .gitignore'd on purpose (per-machine, not
// code), so moving to a new computer needs its own export/import path --
// see tools/backup-transfer.ps1 for the actual copy+zip work; this just
// collects the checkbox options and reports the result.
const backupExportBtnEl = document.getElementById('backupExportBtn');
const backupImportBtnEl = document.getElementById('backupImportBtn');
const backupExportStatusEl = document.getElementById('backupExportStatus');
const backupImportStatusEl = document.getElementById('backupImportStatus');

backupExportBtnEl?.addEventListener('click', async () => {
  backupExportBtnEl.disabled = true;
  backupExportStatusEl.textContent = '导出中，包含大文件夹时可能需要一两分钟…';
  try {
    const result = await window.dash.exportBackup({
      includeScreenTips: document.getElementById('backupIncludeScreenTips')?.checked,
      includeVocalSplits: document.getElementById('backupIncludeVocalSplits')?.checked,
      includeVoiceSamples: document.getElementById('backupIncludeVoiceSamples')?.checked,
      includeTestSongs: document.getElementById('backupIncludeTestSongs')?.checked,
    });
    if (result.cancelled) {
      backupExportStatusEl.textContent = '';
    } else if (result.error) {
      backupExportStatusEl.textContent = `✗ ${result.error}`;
    } else {
      const mb = (result.sizeBytes / (1024 * 1024)).toFixed(1);
      backupExportStatusEl.textContent = `✓ 已导出到 ${result.output}（${mb} MB）`;
    }
  } finally {
    backupExportBtnEl.disabled = false;
  }
});

backupImportBtnEl?.addEventListener('click', async () => {
  backupImportBtnEl.disabled = true;
  backupImportStatusEl.textContent = '导入中…';
  try {
    const result = await window.dash.importBackup();
    if (result.cancelled) {
      backupImportStatusEl.textContent = '';
    } else if (result.error) {
      backupImportStatusEl.textContent = `✗ ${result.error}`;
    } else {
      backupImportStatusEl.textContent = `✓ 已恢复 ${result.restored.length} 项，请重启应用使设置生效${result.backups.length ? `（原有文件已备份为 .backup 后缀，共 ${result.backups.length} 项）` : ''}`;
    }
  } finally {
    backupImportBtnEl.disabled = false;
  }
});

// --- vocal pipeline: collapsible sections for ①②③④ ──────────────────────
// Add collapse/expand functionality to vocal steps (①②③④)
const initVocalSectionCollapses = () => {
  const vocalSection = document.getElementById('section-vocal');
  if (!vocalSection) return;

  const stepPanels = vocalSection.querySelectorAll('.panel-block');
  stepPanels.forEach((panel, idx) => {
    const h3 = panel.querySelector('h3');
    if (!h3) return;

    const toggleBtn = document.createElement('button');
    toggleBtn.style.cssText = 'background:none; border:none; cursor:pointer; padding:4px 8px; font-size:14px; opacity:0.6;';
    toggleBtn.textContent = '▼';
    toggleBtn.dataset.collapsed = 'false';

    const originalTitle = h3.textContent;
    h3.style.display = 'flex';
    h3.style.alignItems = 'center';
    h3.style.gap = '8px';
    h3.insertBefore(toggleBtn, h3.firstChild);

    // Hide all except first step by default
    if (idx > 0) {
      const allChildren = Array.from(panel.children).slice(1);
      allChildren.forEach((el) => (el.style.display = 'none'));
      toggleBtn.textContent = '▶';
      toggleBtn.dataset.collapsed = 'true';
    }

    toggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const collapsed = toggleBtn.dataset.collapsed === 'true';
      const allChildren = Array.from(panel.children).slice(1);
      allChildren.forEach((el) => {
        el.style.display = collapsed ? '' : 'none';
      });
      toggleBtn.textContent = collapsed ? '▼' : '▶';
      toggleBtn.dataset.collapsed = collapsed ? 'false' : 'true';
    });
  });
};
initVocalSectionCollapses();

// --- vocal pipeline: one-click full automation ──────────────────────────
const vocalFullPipelineHandler = () => {
  if (!voiceFullPipelineBtnEl) return;

  // Update index-rate value label
  if (voiceFullPipelineIndexRateEl) {
    voiceFullPipelineIndexRateEl.addEventListener('input', () => {
      voiceFullPipelineIndexRateValueEl.textContent = Number(voiceFullPipelineIndexRateEl.value).toFixed(2);
    });
  }

  // Pick model button
  voiceFullPipelinePickModelEl?.addEventListener('click', async () => {
    const { ok, modelPath, indexPath } = await window.dash.pickVoiceModel();
    if (ok && modelPath) {
      voiceFullPipelineModelEl.value = modelPath;
      selectedVoiceModelPath = modelPath;
      selectedVoiceIndexPath = indexPath;
    }
  });

  // One-click button
  voiceFullPipelineBtnEl.addEventListener('click', async () => {
    const songPath = voiceFullPipelineSongSelectEl.value;
    const modelPath = selectedVoiceModelPath;
    if (!songPath) {
      alert('请先选择一首歌');
      return;
    }
    if (!modelPath) {
      alert('请先选择 RVC 模型');
      return;
    }

    voiceFullPipelineBtnEl.disabled = true;
    voiceFullPipelineStatusEl.textContent = '生成中（①②③④）…';
    try {
      const result = await window.dash.fullPipelineVocal({
        audioPath: songPath,
        modelPath,
        indexPath: selectedVoiceIndexPath || '',
        pitchShift: Number(voiceFullPipelinePitchEl.value) || 0,
        indexRate: Number(voiceFullPipelineIndexRateEl.value) || 0.75,
      });

      if (result.error) {
        voiceFullPipelineStatusEl.textContent = `✗ ${result.error}`;
      } else {
        voiceFullPipelineStatusEl.textContent = `✓ 成品已生成！`;
        loadVocalHistory();
      }
    } catch (err) {
      voiceFullPipelineStatusEl.textContent = `✗ ${err.message}`;
    } finally {
      voiceFullPipelineBtnEl.disabled = false;
    }
  });
};
vocalFullPipelineHandler();

// --- initial load --------------------------------------------------------
(async () => {
  const data = await window.dash.getData();
  renderOverview(data);
  // The overview section is the one already marked active in the static
  // HTML -- unlike every other tab, nothing clicks into it to trigger
  // showSection('overview') on a fresh window, so its Claude-usage fetch +
  // poll have to be kicked off here explicitly or the panel just sits
  // empty until the user happens to click away and back.
  loadClaudeUsage();
  overviewPollTimer = setInterval(refreshOverview, OVERVIEW_POLL_MS);
  renderSettings(data.settings);
  renderTodos(data.todos);
  renderTasks(data.sessions);
  currentShortcuts = data.shortcuts ?? {};
  renderShortcuts();
  renderPetPacks(data.pets, data.activePet);
  renderActionMapping(data.actionMapping);
})();
