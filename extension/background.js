// Background service worker: owns the native messaging port, the ACP client
// and the transcript, so a conversation survives page navigations and can be
// viewed from panels in several tabs at once. Panels are thin views that
// connect with chrome.runtime.connect({ name: 'acp-panel' }).

import { AcpClient } from './lib/acp-client.js';
import { HttpTransport } from './lib/acp-http.js';
import { Transcript } from './lib/transcript.js';

const HOST_NAME = 'dev.acp_chat.host';
const MAX_LOG_LINES = 300;

const panels = new Set();
let nativePort = null;
let client = null;
let transcript = new Transcript();
let logs = [];
let harnesses = { list: [], configPath: null, defaultCwd: null };
let nativeHarnesses = { list: [], configPath: null, defaultCwd: null };
let remoteTransport = null; // HttpTransport when connected to a remote (HTTP) agent

// Remote agents reached over ACP-over-HTTP (POST <url>/acp), no native host.
// Edited from the panel and kept in chrome.storage.local.
const DEFAULT_REMOTES = [{ id: 'pipool', name: 'pipool (remote)', url: 'http://127.0.0.1:18081', sessionId: '' }];
let remotes = DEFAULT_REMOTES;
const remotesReady = chrome.storage.local.get('remotes').then((s) => {
  if (Array.isArray(s.remotes) && s.remotes.length) remotes = s.remotes;
});

function publishHarnesses() {
  const remoteList = remotes.map((r) => ({
    id: r.id,
    name: r.name,
    description: `ACP over HTTP · ${r.url}`,
    remote: true,
    url: r.url,
    sessionId: r.sessionId,
  }));
  harnesses = { ...nativeHarnesses, list: [...remoteList, ...nativeHarnesses.list] };
  broadcast({ type: 'harnesses', harnesses });
}

async function saveRemote(id, patch) {
  remotes = remotes.map((r) => (r.id === id ? { ...r, ...patch } : r));
  await chrome.storage.local.set({ remotes });
  publishHarnesses();
}

// MV3 stops idle service workers after ~30 s; extension API calls reset that
// timer. Keep the worker alive while a remote request (e.g. a long turn) streams.
setInterval(() => {
  if (remoteTransport?.busy) chrome.runtime.getPlatformInfo();
}, 20_000);
const permissionWaiters = new Map(); // JSON-RPC id -> resolve
const chunkBuffers = new Map(); // host chunk id -> string[]
let startWaiter = null;
let agentPid = null; // pid of the harness the current client talks to

const state = {
  status: 'disconnected', // disconnected | connecting | ready | busy | error
  harnessId: null,
  harnessName: null,
  agentInfo: null,
  sessionId: null,
  cwd: null,
  error: null,
};

// ---------- panel fan-out ----------

function broadcast(msg) {
  for (const p of panels) {
    try {
      p.postMessage(msg);
    } catch {
      panels.delete(p);
    }
  }
}

function setState(patch) {
  Object.assign(state, patch);
  broadcast({ type: 'state', state, commands: transcript.commands });
}

function emitItems(indices) {
  if (!indices?.length) return;
  broadcast({ type: 'items', changes: indices.map((index) => ({ index, item: transcript.items[index] })) });
}

function log(stream, text) {
  const lines = String(text).split('\n').filter(Boolean).map((t) => ({ stream, text: t, ts: Date.now() }));
  logs.push(...lines);
  if (logs.length > MAX_LOG_LINES) logs = logs.slice(-MAX_LOG_LINES);
  broadcast({ type: 'log', lines });
}

// ---------- native host ----------

function hostMissingHint(message) {
  if (/not found|forbidden|access/i.test(message ?? '')) {
    return `${message} — run "npm run install-host" in the project folder, then reload the extension.`;
  }
  return message;
}

function ensurePort() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(HOST_NAME);
  nativePort.onMessage.addListener(onHostMessage);
  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    nativePort = null;
    const reason = err ? hostMissingHint(err) : 'Native host disconnected';
    // A missing native host only matters when we are talking to a local harness.
    if (remoteTransport) log('host', reason);
    else if (client || startWaiter) onAgentGone(reason);
    else log('host', reason);
  });
  return nativePort;
}

function onHostMessage(msg) {
  if (msg.type === 'chunk') {
    const parts = chunkBuffers.get(msg.id) ?? [];
    parts.push(msg.data);
    if (!msg.done) return void chunkBuffers.set(msg.id, parts);
    chunkBuffers.delete(msg.id);
    return onHostMessage(JSON.parse(parts.join('')));
  }

  switch (msg.type) {
    case 'recv':
      client?.receive(msg.message);
      break;
    case 'log':
      log(msg.stream, msg.text);
      break;
    case 'harnesses':
      nativeHarnesses = { list: msg.harnesses, configPath: msg.configPath, defaultCwd: msg.defaultCwd };
      publishHarnesses();
      break;
    case 'started':
      agentPid = msg.pid;
      log('host', `started ${msg.name} (pid ${msg.pid}) in ${msg.cwd}`);
      startWaiter?.resolve(msg);
      startWaiter = null;
      break;
    case 'error':
      log('host', msg.message);
      if (startWaiter) {
        startWaiter.reject(new Error(msg.message));
        startWaiter = null;
      } else {
        emitItems(transcript.addError(msg.message));
      }
      break;
    case 'exit':
      // Ignore exits from agents we already replaced or stopped.
      if (msg.pid !== agentPid) break;
      agentPid = null;
      if (startWaiter) {
        startWaiter.reject(new Error(`Agent exited during startup (code ${msg.code ?? msg.signal}). See logs.`));
        startWaiter = null;
      }
      if (client) onAgentGone(`Agent exited (code ${msg.code ?? msg.signal})`, true);
      break;
  }
}

function onAgentGone(reason, informational = false) {
  if (startWaiter) {
    startWaiter.reject(new Error(reason));
    startWaiter = null;
  }
  const hadAgent = !!client;
  client?.failAll(reason);
  client = null;
  remoteTransport?.close();
  remoteTransport = null;
  resolveAllPermissions();
  if (hadAgent || !informational) {
    emitItems(informational ? transcript.addSystem(reason) : transcript.addError(reason));
  }
  setState({ status: informational ? 'disconnected' : 'error', sessionId: null, error: informational ? null : reason });
}

// ---------- ACP lifecycle ----------

function sessionHandlers() {
  return {
    onSessionUpdate: ({ update }) => {
      emitItems(transcript.apply(update));
      if (update?.sessionUpdate === 'available_commands_update' || update?.sessionUpdate === 'current_mode_update') {
        broadcast({ type: 'state', state, commands: transcript.commands });
      }
    },
    onRequestPermission: (params, requestId) =>
      new Promise((resolve) => {
        permissionWaiters.set(requestId, resolve);
        emitItems(transcript.addPermission(requestId, params));
      }),
  };
}

/** Connect to a remote agent over ACP-over-HTTP; resume `sessionId` if given. */
async function startRemote(remoteId, { url, sessionId }) {
  if (state.status === 'connecting') return;
  stopAgent(true);
  await remotesReady;
  const r = remotes.find((x) => x.id === remoteId);
  if (!r) return setState({ status: 'error', error: `Unknown remote "${remoteId}"` });
  url = (url || r.url || '').trim();
  sessionId = (sessionId ?? '').trim();
  setState({ status: 'connecting', harnessId: remoteId, harnessName: r.name, error: null, agentInfo: null });
  await saveRemote(remoteId, { url });

  const transport = new HttpTransport({ url, onMessage: (m) => c.receive(m), onLog: (t) => log('http', t) });
  const c = new AcpClient((m) => transport.send(m), sessionHandlers());
  remoteTransport = transport;
  client = c;
  try {
    const init = await c.initialize();
    let id = null;
    if (sessionId && init?.agentCapabilities?.loadSession) {
      // Replay the saved conversation into a fresh transcript.
      const previous = transcript;
      transcript = new Transcript();
      broadcast({ type: 'snapshot', state, items: transcript.items, harnesses, logs, commands: transcript.commands });
      try {
        await c.request('session/load', { sessionId, cwd: '/', mcpServers: [] });
        id = sessionId;
        emitItems(transcript.addSystem(`Resumed session ${sessionId}`));
      } catch (err) {
        transcript = previous;
        broadcast({ type: 'snapshot', state, items: transcript.items, harnesses, logs, commands: transcript.commands });
        emitItems(transcript.addSystem(`Could not resume ${sessionId} (${err.message}); starting a new session.`));
      }
    }
    if (!id) {
      id = (await c.newSession('/')).sessionId;
      emitItems(transcript.addSystem(`New session ${id}`));
    }
    if (client !== c) return; // stopped meanwhile
    await saveRemote(remoteId, { sessionId: id });
    emitItems(transcript.addSystem(`Connected to ${init?.agentInfo?.title ?? r.name} · ${url}`));
    setState({ status: 'ready', agentInfo: init?.agentInfo ?? null, sessionId: id, cwd: `${url} · ${id}` });
  } catch (err) {
    if (client === c) {
      client = null;
      remoteTransport = null;
    }
    transport.close();
    emitItems(transcript.addError(err.message));
    setState({ status: 'error', error: err.message, sessionId: null });
  }
}

async function startAgent(harnessId, cwd) {
  if (state.status === 'connecting') return;
  stopAgent(true);
  const h = harnesses.list.find((x) => x.id === harnessId);
  setState({ status: 'connecting', harnessId, harnessName: h?.name ?? harnessId, error: null, agentInfo: null });

  try {
    const port = ensurePort();
    const started = new Promise((resolve, reject) => (startWaiter = { resolve, reject }));
    port.postMessage({ type: 'start', harnessId });
    const info = await started;

    client = new AcpClient((message) => nativePort?.postMessage({ type: 'send', message }), sessionHandlers());

    const init = await client.initialize();
    const sessionCwd = cwd || info.cwd;
    let session;
    try {
      session = await client.newSession(sessionCwd);
    } catch (err) {
      if (init?.authMethods?.length) {
        const names = init.authMethods.map((m) => m.name ?? m.id).join(', ');
        throw new Error(`${err.message}. This agent needs authentication (${names}); log in with its CLI first.`);
      }
      throw err;
    }
    emitItems(transcript.addSystem(`Connected to ${init?.agentInfo?.title ?? h?.name ?? harnessId} · ${sessionCwd}`));
    setState({
      status: 'ready',
      agentInfo: init?.agentInfo ?? null,
      sessionId: session.sessionId,
      cwd: sessionCwd,
    });
  } catch (err) {
    nativePort?.postMessage({ type: 'stop' });
    client = null;
    emitItems(transcript.addError(err.message));
    setState({ status: 'error', error: err.message, sessionId: null });
  }
}

function stopAgent(silent = false) {
  if (!client && !nativePort) return;
  resolveAllPermissions();
  const c = client;
  const remote = remoteTransport;
  client = null;
  remoteTransport = null;
  agentPid = null;
  c?.failAll('Stopped');
  if (remote) remote.close();
  else nativePort?.postMessage({ type: 'stop' });
  if (!silent && c) emitItems(transcript.addSystem('Agent stopped'));
  setState({ status: 'disconnected', sessionId: null });
}

async function sendPrompt(text) {
  if (!client || !state.sessionId || state.status !== 'ready') return;
  emitItems(transcript.addUser(text));
  setState({ status: 'busy' });
  try {
    const res = await client.prompt(state.sessionId, text);
    if (res?.stopReason && res.stopReason !== 'end_turn') {
      emitItems(transcript.addSystem(`Stopped: ${res.stopReason.replaceAll('_', ' ')}`));
    }
    if (client) setState({ status: 'ready' });
  } catch (err) {
    if (client) {
      emitItems(transcript.addError(err.message));
      setState({ status: 'ready' });
    }
  }
}

function cancelTurn() {
  if (!client || !state.sessionId) return;
  // Spec: on cancel, the client answers pending permission requests with "cancelled".
  resolveAllPermissions();
  client.cancel(state.sessionId);
}

function resolvePermission(requestId, optionId) {
  const resolve = permissionWaiters.get(requestId);
  if (!resolve) return;
  permissionWaiters.delete(requestId);
  const item = transcript.items.find((i) => i.type === 'permission' && i.requestId === requestId);
  const label = optionId ? (item?.options.find((o) => o.optionId === optionId)?.name ?? optionId) : 'Cancelled';
  emitItems(transcript.resolvePermission(requestId, label));
  resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
}

function resolveAllPermissions() {
  for (const id of [...permissionWaiters.keys()]) resolvePermission(id, null);
}

// ---------- panel connections ----------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'acp-panel') return;
  // Only our own extension pages may drive the agent.
  if (port.sender?.id !== chrome.runtime.id || !port.sender?.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) {
    port.disconnect();
    return;
  }
  panels.add(port);
  port.onDisconnect.addListener(() => panels.delete(port));
  port.postMessage({ type: 'snapshot', state, items: transcript.items, harnesses, logs, commands: transcript.commands });

  port.onMessage.addListener((msg) => {
    switch (msg?.type) {
      case 'listHarnesses':
        remotesReady.then(publishHarnesses);
        try {
          ensurePort().postMessage({ type: 'list' });
        } catch (err) {
          log('host', err.message); // remote agents still work without the native host
        }
        break;
      case 'start': {
        const id = String(msg.harnessId ?? '');
        if (remotes.some((r) => r.id === id)) {
          const str = (v) => (typeof v === 'string' ? v : undefined);
          startRemote(id, { url: str(msg.url), sessionId: str(msg.sessionId) });
        } else {
          startAgent(id, typeof msg.cwd === 'string' ? msg.cwd.trim() : '');
        }
        break;
      }
      case 'stop':
        stopAgent();
        break;
      case 'prompt':
        if (typeof msg.text === 'string' && msg.text.trim()) sendPrompt(msg.text);
        break;
      case 'cancel':
        cancelTurn();
        break;
      case 'permission':
        resolvePermission(msg.requestId, typeof msg.optionId === 'string' ? msg.optionId : null);
        break;
      case 'clear':
        transcript = new Transcript();
        broadcast({ type: 'snapshot', state, items: transcript.items, harnesses, logs, commands: transcript.commands });
        break;
    }
  });
});

// ---------- after install/reload/update: replace orphaned panels ----------
// Chrome doesn't re-run content scripts in open tabs, so tabs keep a dead
// button/panel from the previous version. Re-inject into the declared sites;
// content.js removes the stale UI and attaches a live one.
chrome.runtime.onInstalled.addListener(async () => {
  const matches = chrome.runtime.getManifest().content_scripts?.flatMap((c) => c.matches) ?? [];
  const tabs = await chrome.tabs.query({ url: matches });
  for (const tab of tabs) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
  }
});

// ---------- toolbar button: toggle the panel on any tab ----------

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'acp-chat-toggle' });
  } catch {
    // Not injected on this site yet: activeTab grants a one-off injection.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'acp-chat-toggle' });
    } catch (err) {
      console.warn('ACP Chat cannot run on this page:', err.message);
    }
  }
});
