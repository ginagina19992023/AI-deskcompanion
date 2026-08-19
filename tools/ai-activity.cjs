#!/usr/bin/env node
// Provider-neutral activity bridge for DeepSeek, Kimi and any agent/client
// that can run a lifecycle command. It posts to the desktop pet when it is
// running and falls back to a local session file when it is not.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
function flag(name, fallback = '') {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
function safePart(value) {
  return String(value || 'default').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 96);
}
function fromFlags() {
  return {
    provider: flag('provider', process.env.AI_PROVIDER || 'custom'),
    sessionId: flag('session', process.env.AI_SESSION_ID || `${process.pid}`),
    status: flag('status', flag('event', 'working')),
    toolName: flag('tool'),
    detail: flag('detail'),
    taskTitle: flag('title'),
    ts: Date.now(),
    source: 'ai-activity-cli',
  };
}
function persist(payload) {
  try {
    const dir = path.join(os.homedir(), '.ai-activity', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safePart(payload.provider)}-${safePart(payload.sessionId)}.json`);
    if (String(payload.status).toLowerCase() === 'idle') {
      try { fs.unlinkSync(file); } catch {}
    } else {
      fs.writeFileSync(file, JSON.stringify(payload));
    }
  } catch {}
}
function send(payload) {
  const body = JSON.stringify(payload);
  const req = http.request(
    { host: '127.0.0.1', port: 47811, path: '/activity', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 800 },
    (res) => res.resume(),
  );
  req.on('error', () => persist(payload));
  req.on('timeout', () => req.destroy());
  req.end(body);
}

if (process.stdin.isTTY) {
  send(fromFlags());
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => {
    let payload = fromFlags();
    if (input.trim()) {
      try { payload = { ...payload, ...JSON.parse(input) }; } catch {}
    }
    send(payload);
  });
}
