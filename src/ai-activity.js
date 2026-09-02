const STATUS_ALIASES = new Map([
  ['start', 'working'],
  ['started', 'working'],
  ['thinking', 'working'],
  ['running', 'working'],
  ['tool_start', 'working'],
  ['tool_call', 'working'],
  ['reading', 'review'],
  ['reviewing', 'review'],
  ['approval', 'waiting'],
  ['permission', 'waiting'],
  ['input_required', 'waiting'],
  ['done', 'celebrate'],
  ['complete', 'celebrate'],
  ['completed', 'celebrate'],
  ['failed', 'error'],
  ['failure', 'error'],
  ['stopped', 'idle'],
]);

export const PROVIDER_LABELS = Object.freeze({
  claude: 'Claude',
  codex: 'Codex',
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  openai: 'OpenAI',
  ollama: 'Ollama',
  custom: 'AI',
});

const READ_ONLY_TOOL = /(read|grep|glob|search|fetch|open|find|list|inspect|review|view|screenshot|query)/i;
const WAIT_TOOL = /(approval|permission|ask[_-]?user|request[_-]?input|confirm)/i;
const TOOL_LABELS = {
  zh: [
    [/apply[_-]?patch|edit|write|replace/i, '修改文件'],
    [/shell|terminal|bash|command|exec/i, '运行终端命令'],
    [/web.*search|search.*web|browser.*search/i, '搜索网页'],
    [/web.*open|fetch|browser/i, '查看网页'],
    [/read|view[_-]?image|inspect/i, '查看文件'],
    [/grep|glob|find|list/i, '搜索文件'],
    [/github|git/i, '操作 GitHub'],
    [/wait/i, '等待后台任务'],
    [/agent|task|delegate/i, '运行子任务'],
  ],
  en: [
    [/apply[_-]?patch|edit|write|replace/i, 'Editing files'],
    [/shell|terminal|bash|command|exec/i, 'Running a terminal command'],
    [/web.*search|search.*web|browser.*search/i, 'Searching the web'],
    [/web.*open|fetch|browser/i, 'Browsing a page'],
    [/read|view[_-]?image|inspect/i, 'Reading files'],
    [/grep|glob|find|list/i, 'Searching files'],
    [/github|git/i, 'Working with GitHub'],
    [/wait/i, 'Waiting on a background task'],
    [/agent|task|delegate/i, 'Running a subtask'],
  ],
};

export function normalizeProvider(value) {
  const raw = String(value || 'custom').trim().toLowerCase();
  if (raw.includes('claude') || raw.includes('anthropic')) return 'claude';
  if (raw.includes('codex')) return 'codex';
  if (raw.includes('deepseek')) return 'deepseek';
  if (raw.includes('kimi') || raw.includes('moonshot')) return 'kimi';
  if (raw.includes('openai') || raw.includes('gpt')) return 'openai';
  if (raw.includes('ollama')) return 'ollama';
  return raw.replace(/[^a-z0-9_-]/g, '-').slice(0, 32) || 'custom';
}

export function canonicalStatus(value, toolName = '') {
  const raw = String(value || '').trim().toLowerCase().replace(/[ -]+/g, '_');
  if (['working', 'review', 'waiting', 'error', 'celebrate', 'idle'].includes(raw)) return raw;
  if (STATUS_ALIASES.has(raw)) return STATUS_ALIASES.get(raw);
  if (WAIT_TOOL.test(toolName)) return 'waiting';
  if (READ_ONLY_TOOL.test(toolName)) return 'review';
  return toolName ? 'working' : 'idle';
}

export function friendlyToolName(toolName, lang = 'zh') {
  const name = String(toolName || '').replace(/^mcp__/, '').replace(/__/g, ' · ');
  const labels = TOOL_LABELS[lang] ?? TOOL_LABELS.zh;
  for (const [pattern, label] of labels) if (pattern.test(name)) return label;
  return name ? (lang === 'en' ? `Using ${name.slice(0, 36)}` : `使用 ${name.slice(0, 36)}`) : '';
}

const FALLBACK_TEXT = {
  zh: { working: '正在处理', review: '正在审阅', waitingWithAction: (a) => `等待批准：${a}`, waitingNoAction: '等待你的输入', errorWithAction: (a) => `${a}时出错`, errorNoAction: '运行出错', celebrate: '任务完成', idle: '空闲' },
  en: { working: 'Working', review: 'Reviewing', waitingWithAction: (a) => `Waiting for approval: ${a}`, waitingNoAction: 'Waiting for your input', errorWithAction: (a) => `Error during ${a}`, errorNoAction: 'Something went wrong', celebrate: 'Task complete', idle: 'Idle' },
};

// Passed in from main.js's cfg.chat.replyLanguage rather than read from cfg
// directly -- this module stays pure/config-agnostic so it can be unit
// tested without touching the filesystem.
export function normalizeAiActivity(payload, nowMs = Date.now(), lang = 'zh') {
  if (!payload || typeof payload !== 'object') return null;
  const provider = normalizeProvider(payload.provider ?? payload.agent ?? payload.model);
  const providerLabel = PROVIDER_LABELS[provider] ?? String(payload.providerLabel || provider || 'AI');
  const toolName = String(payload.toolName ?? payload.tool_name ?? payload.tool ?? '').slice(0, 80);
  const status = canonicalStatus(payload.status ?? payload.phase ?? payload.event, toolName);
  const action = friendlyToolName(toolName, lang);
  const t = FALLBACK_TEXT[lang] ?? FALLBACK_TEXT.zh;
  const fallback = {
    working: action || t.working,
    review: action || t.review,
    waiting: action ? t.waitingWithAction(action) : t.waitingNoAction,
    error: action ? t.errorWithAction(action) : t.errorNoAction,
    celebrate: t.celebrate,
    idle: t.idle,
  }[status];
  const detailText = String(payload.detail || fallback || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const rawContextPercent = Number(payload.contextPercent);
  const contextPercent = Number.isFinite(rawContextPercent)
    ? Math.max(0, Math.min(1, rawContextPercent > 1 ? rawContextPercent / 100 : rawContextPercent))
    : undefined;
  return {
    provider,
    providerLabel,
    status,
    detail: detailText.startsWith(`${providerLabel} ·`) ? detailText : `${providerLabel} · ${detailText}`,
    taskTitle: payload.taskTitle ? String(payload.taskTitle).replace(/\s+/g, ' ').trim().slice(0, 80) : null,
    toolName: toolName || null,
    sessionId: String(payload.sessionId ?? payload.session_id ?? `${provider}-default`).slice(0, 160),
    ts: Number.isFinite(Number(payload.ts)) ? Number(payload.ts) : nowMs,
    source: String(payload.source || 'external').slice(0, 32),
    contextTokens: Number.isFinite(Number(payload.contextTokens)) ? Number(payload.contextTokens) : undefined,
    contextWindowMax: Number.isFinite(Number(payload.contextWindowMax)) ? Number(payload.contextWindowMax) : undefined,
    contextPercent,
    cwd: payload.cwd ? String(payload.cwd) : undefined,
    ppid: Number.isInteger(payload.ppid) ? payload.ppid : undefined,
    ancestorChain: Array.isArray(payload.ancestorChain) ? payload.ancestorChain : undefined,
  };
}

const STATUS_PRIORITY = Object.freeze({ waiting: 60, error: 55, working: 40, review: 35, celebrate: 25, idle: 0 });

export function pickPrimaryActivity(activities, { nowMs = Date.now(), staleMs = 120000 } = {}) {
  return (activities || [])
    .filter((item) => item && Number.isFinite(item.ts) && nowMs - item.ts <= staleMs && item.status !== 'idle')
    .sort((a, b) => (STATUS_PRIORITY[b.status] ?? 0) - (STATUS_PRIORITY[a.status] ?? 0) || b.ts - a.ts)[0] ?? null;
}

// Confirmed live bug, twice over: first "fullest wins" silently showed
// whichever session had used the most of its window even while you were
// typing in a different one; switching to "most recent wins" still
// flickered between two sessions used within the same few seconds of each
// other (confirmed live: real hooks ~500ms apart). Both were guesses at
// "which ONE session do I show" -- the actual fix is to stop guessing:
// return every fresh session with real context data and let the caller
// render one ring per session, so each window's own badge always reflects
// that window, full stop.
export function pickAllContextActivities(activities, { nowMs = Date.now(), staleMs = 120000 } = {}) {
  const fresh = (activities || []).filter(
    (item) =>
      item &&
      Number.isFinite(item.ts) &&
      nowMs - item.ts <= staleMs &&
      item.status !== 'idle' &&
      Number.isFinite(item.contextPercent),
  );
  const bySession = new Map();
  for (const item of fresh) {
    const previous = bySession.get(item.sessionId);
    if (!previous || item.ts > previous.ts) bySession.set(item.sessionId, item);
  }
  return [...bySession.values()].sort((a, b) => b.ts - a.ts);
}
