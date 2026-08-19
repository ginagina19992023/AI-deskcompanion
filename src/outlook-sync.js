// Outlook (Microsoft To Do) two-way sync -- main process only (needs
// filesystem access for the token cache, a local HTTP server for the OAuth
// redirect, and Electron's shell.openExternal to launch the system
// browser).
//
// Auth: MSAL Node's PublicClientApplication with the "public client"
// (mobile/desktop) app type -- no client secret involved, ever. Azure
// requires the app registration's redirect URI to be exactly
// "http://localhost" with the platform type "Mobile and desktop
// applications" for this flow; MSAL is then allowed to bind that to any
// free local port at runtime. The whole point of this app type is that a
// secret isn't needed and wouldn't be safe to ship in a local Electron app
// anyway.
//
// Token persistence: MSAL's serialized cache (which contains real refresh
// tokens) is encrypted at rest with Electron's safeStorage (OS-level --
// Windows DPAPI, macOS Keychain, etc.) before touching disk. Never stored
// in config.json.
//
// Sync model: continuous two-way. Each local todo gets externalId/
// externalProvider once it's been created on the Graph side; conflict
// resolution is last-write-wins via todos.js's resolveSyncConflict
// (compares local updatedAt against the remote task's
// lastModifiedDateTime). A todo deleted locally that has an externalId
// gets deleted on Graph too, and vice versa (a task that's disappeared
// from Graph but still has a local record gets removed locally) -- kept
// genuinely in sync, not a one-way import.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { shell, safeStorage } from 'electron';
import { PublicClientApplication } from '@azure/msal-node';
import { todoToGraphTask, graphTaskToTodo, resolveSyncConflict, addTodo } from './todos.js';

const GRAPH_SCOPES = ['Tasks.ReadWrite'];
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TASK_LIST_NAME = 'Sebastian 桌面宠物';

let msalApp = null;
let cachedAccount = null;
let tokenCachePath = null;

function loadCache() {
  if (!existsSync(tokenCachePath)) return null;
  try {
    const encrypted = readFileSync(tokenCachePath);
    if (!safeStorage.isEncryptionAvailable()) return null; // no OS keystore available -- don't touch a possibly-foreign-format file
    return safeStorage.decryptString(encrypted);
  } catch {
    return null; // corrupt/undecryptable cache -- treat as logged out rather than crash
  }
}

function saveCache(serialized) {
  try {
    mkdirSync(join(tokenCachePath, '..'), { recursive: true });
    if (!safeStorage.isEncryptionAvailable()) return;
    writeFileSync(tokenCachePath, safeStorage.encryptString(serialized));
  } catch {
    /* best-effort -- a failed cache write just means the next sync re-authenticates */
  }
}

function ensureApp(clientId, tenantId, dataDir) {
  tokenCachePath = join(dataDir, 'outlook-token-cache.bin');
  if (msalApp && msalApp.__clientId === clientId && msalApp.__tenantId === tenantId) return msalApp;
  msalApp = new PublicClientApplication({
    auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId || 'common'}` },
    cache: {
      cachePlugin: {
        beforeCacheAccess: async (ctx) => {
          const cached = loadCache();
          if (cached) ctx.tokenCache.deserialize(cached);
        },
        afterCacheAccess: async (ctx) => {
          if (ctx.cacheHasChanged) saveCache(ctx.tokenCache.serialize());
        },
      },
    },
  });
  msalApp.__clientId = clientId;
  msalApp.__tenantId = tenantId;
  cachedAccount = null;
  return msalApp;
}

// Interactive login: opens the system browser to Microsoft's consent page,
// listens on a random local port for the "http://localhost:<port>/?code=..."
// redirect, exchanges the code for tokens. Resolves once tokens are
// acquired and the account is cached for future silent refreshes.
async function interactiveLogin(app) {
  const server = createServer();
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const redirectUri = `http://localhost:${port}`;

  const codePromise = new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url, redirectUri);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error_description') || url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(code ? '<h2>登录成功，可以关闭这个页面了。</h2>' : `<h2>登录失败：${error ?? '未知错误'}</h2>`);
      if (code) resolve(code);
      else reject(new Error(error ?? '登录被取消或失败'));
    });
  });

  const authUrl = await app.getAuthCodeUrl({ scopes: GRAPH_SCOPES, redirectUri });
  await shell.openExternal(authUrl);

  try {
    const code = await codePromise;
    const result = await app.acquireTokenByCode({ code, scopes: GRAPH_SCOPES, redirectUri });
    cachedAccount = result.account;
    return result;
  } finally {
    server.close();
  }
}

async function getAccessToken(app, { interactive = false } = {}) {
  if (!cachedAccount) {
    const accounts = await app.getTokenCache().getAllAccounts();
    if (accounts.length) cachedAccount = accounts[0];
  }
  if (cachedAccount) {
    try {
      const result = await app.acquireTokenSilent({ scopes: GRAPH_SCOPES, account: cachedAccount });
      return result.accessToken;
    } catch {
      /* silent refresh failed (expired refresh token, revoked consent, etc.) -- fall through to interactive if allowed */
    }
  }
  if (!interactive) throw new Error('未登录 Outlook，需要先连接账号');
  const result = await interactiveLogin(app);
  return result.accessToken;
}

async function graphFetch(token, path, options = {}) {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Graph API ${options.method ?? 'GET'} ${path} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function findOrCreateTaskList(token) {
  const lists = await graphFetch(token, '/me/todo/lists');
  const existing = lists.value.find((l) => l.displayName === TASK_LIST_NAME);
  if (existing) return existing.id;
  const created = await graphFetch(token, '/me/todo/lists', {
    method: 'POST',
    body: JSON.stringify({ displayName: TASK_LIST_NAME }),
  });
  return created.id;
}

// Connect (or reconnect) an account -- the only function that can trigger
// the interactive browser flow. Everything else (syncOnce) only ever does
// silent token refresh and fails with a clear "not logged in" error
// instead of popping a browser window on its own during a background sync
// tick.
export async function connectOutlookAccount({ clientId, tenantId, dataDir }) {
  const app = ensureApp(clientId, tenantId, dataDir);
  const result = await interactiveLogin(app);
  return { ok: true, account: result.account.username };
}

export async function disconnectOutlookAccount({ clientId, tenantId, dataDir }) {
  const app = ensureApp(clientId, tenantId, dataDir);
  const accounts = await app.getTokenCache().getAllAccounts();
  for (const acc of accounts) await app.getTokenCache().removeAccount(acc);
  cachedAccount = null;
  return { ok: true };
}

export async function getOutlookAccountStatus({ clientId, tenantId, dataDir }) {
  if (!clientId) return { connected: false };
  const app = ensureApp(clientId, tenantId, dataDir);
  const accounts = await app.getTokenCache().getAllAccounts();
  return { connected: accounts.length > 0, account: accounts[0]?.username ?? null };
}

// One full sync pass: pull remote changes, push local changes, reconcile
// deletions on both sides. Returns the updated todos array (caller is
// responsible for persisting/broadcasting it) plus a short summary for
// logging/UI feedback. Never triggers interactive login -- a sync tick
// that can't silently refresh its token just reports that and stops.
export async function syncOnce({ clientId, tenantId, dataDir, todos }) {
  const app = ensureApp(clientId, tenantId, dataDir);
  const token = await getAccessToken(app, { interactive: false });
  const listId = await findOrCreateTaskList(token);
  const remote = await graphFetch(token, `/me/todo/lists/${listId}/tasks?$top=200`);
  const remoteTasks = remote.value ?? [];
  const remoteById = new Map(remoteTasks.map((t) => [t.id, t]));

  let next = [...todos];
  let pulled = 0;
  let pushed = 0;
  let deletedLocally = 0;
  let deletedRemotely = 0;

  // Local todos with an externalId that no longer exists remotely -- the
  // task was deleted on the Outlook side, so remove it locally too.
  next = next.filter((t) => {
    if (t.externalProvider === 'outlook' && t.externalId && !remoteById.has(t.externalId)) {
      deletedLocally++;
      return false;
    }
    return true;
  });

  // Existing linked todos: pull or push per resolveSyncConflict.
  for (let i = 0; i < next.length; i++) {
    const t = next[i];
    if (t.externalProvider !== 'outlook' || !t.externalId) continue;
    const remoteTask = remoteById.get(t.externalId);
    if (!remoteTask) continue; // handled by the filter above
    const remoteUpdatedAt = remoteTask.lastModifiedDateTime ? new Date(remoteTask.lastModifiedDateTime).getTime() : 0;
    const decision = resolveSyncConflict(t, remoteUpdatedAt);
    if (decision === 'pull') {
      const patch = graphTaskToTodo(remoteTask);
      next[i] = { ...t, ...patch };
      pulled++;
    } else {
      await graphFetch(token, `/me/todo/lists/${listId}/tasks/${t.externalId}`, {
        method: 'PATCH',
        body: JSON.stringify(todoToGraphTask(t)),
      });
      pushed++;
    }
    remoteById.delete(t.externalId);
  }

  // Local todos never linked yet -- create them on Graph.
  for (let i = 0; i < next.length; i++) {
    const t = next[i];
    if (t.externalProvider) continue;
    const created = await graphFetch(token, `/me/todo/lists/${listId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(todoToGraphTask(t)),
    });
    next[i] = { ...t, externalId: created.id, externalProvider: 'outlook' };
    pushed++;
  }

  // Remaining remote tasks (not matched to any local todo) -- new tasks
  // created directly in Outlook/To Do, pull them in.
  for (const remoteTask of remoteById.values()) {
    const patch = graphTaskToTodo(remoteTask);
    next = addTodo(next, patch.text, Date.now());
    const created = next[next.length - 1];
    next[next.length - 1] = { ...created, ...patch, externalId: remoteTask.id, externalProvider: 'outlook' };
    pulled++;
  }

  return { todos: next, summary: { pulled, pushed, deletedLocally, deletedRemotely } };
}

// Called when a todo with an externalId is removed locally (see main.js's
// pet:todo-remove) -- deletes the matching Graph task so the removal
// propagates instead of the task quietly reappearing on the next pull.
export async function deleteOutlookTask({ clientId, tenantId, dataDir, externalId }) {
  const app = ensureApp(clientId, tenantId, dataDir);
  const token = await getAccessToken(app, { interactive: false });
  const listId = await findOrCreateTaskList(token);
  await graphFetch(token, `/me/todo/lists/${listId}/tasks/${externalId}`, { method: 'DELETE' });
}
