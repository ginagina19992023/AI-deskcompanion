import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { friendlyToolName, normalizeAiActivity } from './ai-activity.js';

function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function extractCodexTool(payload) {
  const outerName = payload?.name || '';
  const input = String(payload?.input || payload?.arguments || '');
  const nested = input.match(/tools\.([A-Za-z0-9_]+)/)?.[1];
  return nested || outerName || 'tool';
}

export function parseCodexRollout(text, { threadId = 'unknown', nowMs = Date.now(), lang = 'zh' } = {}) {
  let taskTitle = null;
  let activity = null;
  let contextUsage = null;
  let contextTs = 0;
  const calls = new Map();
  for (const line of String(text || '').split('\n')) {
    const item = safeJson(line);
    if (!item?.payload) continue;
    const ts = Date.parse(item.timestamp) || nowMs;
    const p = item.payload;
    if (item.type === 'event_msg' && p.type === 'token_count') {
      const tokens = Number(p.info?.last_token_usage?.input_tokens);
      const contextWindowMax = Number(p.info?.model_context_window);
      if (tokens > 0 && contextWindowMax > 0) {
        contextUsage = {
          contextTokens: tokens,
          contextWindowMax,
          contextPercent: Math.min(1, tokens / contextWindowMax),
        };
        contextTs = ts;
      }
      continue;
    }
    if (item.type === 'event_msg' && p.type === 'user_message') {
      taskTitle = String(p.message || '').replace(/\s+/g, ' ').trim().slice(0, 80) || taskTitle;
      continue;
    }
    if (item.type === 'event_msg' && p.type === 'task_started') {
      activity = { status: 'working', detail: '正在开始任务', ts, toolName: null };
      continue;
    }
    if (item.type === 'event_msg' && p.type === 'task_complete') {
      activity = { status: 'celebrate', detail: '回合完成', ts, toolName: null };
      continue;
    }
    if (item.type === 'event_msg' && /error|abort|fail/.test(p.type || '')) {
      activity = { status: 'error', detail: '运行出错', ts, toolName: null };
      continue;
    }
    if (item.type !== 'response_item') continue;
    if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      const toolName = extractCodexTool(p);
      calls.set(p.call_id, toolName);
      activity = { status: undefined, detail: friendlyToolName(toolName), ts, toolName };
      continue;
    }
    if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      const toolName = calls.get(p.call_id) || activity?.toolName || 'tool';
      activity = { status: 'working', detail: `整理${friendlyToolName(toolName)}的结果`, ts, toolName };
      continue;
    }
    if (p.type === 'reasoning') {
      activity = { status: 'working', detail: lang === 'en' ? 'Thinking' : '正在思考', ts, toolName: null };
    }
  }
  if (!activity) return null;
  if (contextTs > activity.ts) activity.ts = contextTs;
  return normalizeAiActivity(
    {
      provider: 'codex',
      sessionId: `codex-${threadId}`,
      taskTitle,
      source: 'codex-rollout',
      ...activity,
      ...contextUsage,
    },
    nowMs,
    lang,
  );
}

function readTail(path, maxBytes = 524288) {
  const size = statSync(path).size;
  const length = Math.min(size, maxBytes);
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    return size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    closeSync(fd);
  }
}

function dayPath(root, date) {
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return join(root, y, m, d);
}

export function createCodexActivityReader(sessionsRoot) {
  const cache = new Map();
  return function readCodexActivities(nowMs = Date.now(), lang = 'zh') {
    const files = [];
    for (const offset of [0, -86400000]) {
      const dir = dayPath(sessionsRoot, new Date(nowMs + offset));
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        const path = join(dir, name);
        const stat = statSync(path);
        files.push({ path, name, size: stat.size });
      }
    }
    files.sort((a, b) => b.name.localeCompare(a.name));
    const output = [];
    for (const file of files.slice(0, 12)) {
      const previous = cache.get(file.path);
      if (!previous || previous.size !== file.size) {
        const threadId = basename(file.name, '.jsonl').match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i)?.[1] || file.name;
        const activity = parseCodexRollout(readTail(file.path), { threadId, nowMs, lang });
        // Once a long rollout exceeds the tail window, its original user
        // message may no longer be present. Preserve the title learned from
        // an earlier read instead of turning a named task into “未命名任务”.
        if (activity && !activity.taskTitle && previous?.activity?.taskTitle) {
          activity.taskTitle = previous.activity.taskTitle;
        }
        cache.set(file.path, { size: file.size, activity });
      }
      const activity = cache.get(file.path)?.activity;
      if (activity) output.push(activity);
    }
    return output;
  };
}
