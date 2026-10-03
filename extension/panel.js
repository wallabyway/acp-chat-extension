// Chat panel UI (runs inside the extension iframe). Alpine's CSP build is used
// because MV3 extension pages forbid eval; expressions in panel.html are kept
// to simple property access and method calls.
import Alpine from './vendor/alpine-csp.esm.js';
import { renderInto } from './lib/markdown.js';

const SIZES = ['small', 'medium', 'large'];
const SIZE_LABELS = { small: 'S', medium: 'M', large: 'L' };
const embedded = window.parent !== window;

// Kept outside Alpine state: reactive proxies break native Chrome objects
// ("Illegal invocation" when calling Port methods through a Proxy).
let port = null;

// Panel -> content script control channel. chrome.tabs.sendMessage can't be
// spoofed by the host page (unlike window.postMessage). frameId 0 targets the
// top-level content script in the tab that embeds this iframe.
let tabIdPromise = null;
async function toContent(msg) {
  if (!embedded) return null;
  tabIdPromise ??= chrome.tabs.getCurrent().then((t) => t?.id);
  const tabId = await tabIdPromise;
  if (tabId === undefined) return null;
  return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => null);
}

// x-markdown="expr": render expr as safe markdown (DOM nodes, no innerHTML).
Alpine.directive('markdown', (el, { expression }, { effect, evaluateLater }) => {
  const get = evaluateLater(expression);
  effect(() => get((value) => renderInto(el, value ?? '')));
});

Alpine.data('chat', () => ({
  status: 'disconnected',
  error: null,
  agentName: '',
  sessionCwd: '',
  harnesses: [],
  configPath: '',
  harnessId: '',
  cwd: '',
  items: [],
  commands: [],
  logs: [],
  input: '',
  showLogs: false,
  showThoughts: true,
  size: 'medium',
  embedded,

  init() {
    chrome.storage.local.get(['harnessId', 'cwd', 'showThoughts']).then((s) => {
      if (s.harnessId) this.harnessId = s.harnessId;
      if (s.cwd) this.cwd = s.cwd;
      if (typeof s.showThoughts === 'boolean') this.showThoughts = s.showThoughts;
    });
    this.connect();

    toContent({ type: 'acp-chat-get-size' }).then((res) => {
      if (SIZES.includes(res?.size)) this.size = res.size;
    });
    // Content script asks us to focus the composer when the panel opens.
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'acp-chat-focus') this.focusInput();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  },

  connect() {
    port = chrome.runtime.connect({ name: 'acp-panel' });
    port.onMessage.addListener((msg) => this.onMessage(msg));
    // The service worker can be restarted by Chrome; reattach.
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(() => this.connect(), 500);
    });
    this.post({ type: 'listHarnesses' });
  },

  post(msg) {
    port?.postMessage(msg);
  },

  onMessage(msg) {
    switch (msg.type) {
      case 'snapshot':
        this.items = msg.items;
        this.logs = msg.logs ?? [];
        this.applyHarnesses(msg.harnesses);
        this.applyState(msg.state, msg.commands);
        this.scrollToBottom(true);
        break;
      case 'state':
        this.applyState(msg.state, msg.commands);
        break;
      case 'items': {
        const stick = this.isNearBottom();
        for (const { index, item } of msg.changes) this.items[index] = item;
        if (stick) this.scrollToBottom(true);
        break;
      }
      case 'harnesses':
        this.applyHarnesses(msg.harnesses);
        break;
      case 'log':
        this.logs = this.logs.concat(msg.lines).slice(-300);
        break;
    }
  },

  applyState(s, commands) {
    if (!s) return;
    this.status = s.status;
    this.error = s.error;
    this.agentName = s.agentInfo?.title ?? s.agentInfo?.name ?? s.harnessName ?? '';
    this.sessionCwd = s.cwd ?? '';
    if (s.harnessId && this.isConnected()) this.harnessId = s.harnessId;
    if (commands) this.commands = commands;
  },

  applyHarnesses(h) {
    if (!h?.list?.length) return;
    this.harnesses = h.list;
    this.configPath = h.configPath ?? '';
    if (!this.harnesses.some((x) => x.id === this.harnessId)) this.harnessId = this.harnesses[0].id;
  },

  // ---------- derived state (methods keep CSP expressions simple) ----------

  isConnected() {
    return this.status === 'ready' || this.status === 'busy';
  },
  isBusy() {
    return this.status === 'busy';
  },
  isConnecting() {
    return this.status === 'connecting';
  },
  canSend() {
    return this.status === 'ready' && this.input.trim().length > 0;
  },
  statusLabel() {
    return { disconnected: 'Not connected', connecting: 'Connecting…', ready: 'Ready', busy: 'Working…', error: 'Error' }[this.status] ?? this.status;
  },
  statusDot() {
    return {
      ready: 'bg-emerald-500',
      busy: 'bg-amber-500 animate-pulse',
      connecting: 'bg-sky-500 animate-pulse',
      error: 'bg-rose-500',
    }[this.status] ?? 'bg-slate-400';
  },
  sizeLabel() {
    return SIZE_LABELS[this.size] ?? 'M';
  },
  sizeTitle() {
    const next = SIZES[(SIZES.indexOf(this.size) + 1) % SIZES.length];
    return `Size: ${this.size} (click for ${next})`;
  },
  harnessDescription() {
    return this.harnesses.find((h) => h.id === this.harnessId)?.description ?? '';
  },
  cwdPlaceholder() {
    return this.harnesses.find((h) => h.id === this.harnessId)?.cwd ?? 'Working directory';
  },
  hasItems() {
    return this.items.length > 0;
  },
  isVisible(item) {
    return item.type !== 'thought' || this.showThoughts;
  },
  toolStatusClass(item) {
    return {
      completed: 'bg-emerald-100 text-emerald-800',
      failed: 'bg-rose-100 text-rose-800',
      in_progress: 'bg-amber-100 text-amber-800',
    }[item.status] ?? 'bg-slate-100 text-slate-700';
  },
  toolStatusLabel(item) {
    return (item.status ?? 'pending').replaceAll('_', ' ');
  },
  planMark(entry) {
    return { completed: '✓', in_progress: '◐' }[entry.status] ?? '○';
  },
  planClass(entry) {
    return entry.status === 'completed' ? 'text-slate-400 line-through' : 'text-slate-700';
  },
  optionClass(opt) {
    return opt.kind?.startsWith('allow')
      ? 'bg-indigo-600 text-white hover:bg-indigo-500'
      : 'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50';
  },
  logClass(line) {
    return line.stream === 'stderr' ? 'text-amber-300' : line.stream === 'host' ? 'text-sky-300' : 'text-slate-300';
  },
  commandHint() {
    return this.commands.length ? `${this.commands.length} slash commands available` : '';
  },

  // ---------- actions ----------

  start() {
    chrome.storage.local.set({ harnessId: this.harnessId, cwd: this.cwd });
    this.post({ type: 'start', harnessId: this.harnessId, cwd: this.cwd });
  },
  stop() {
    this.post({ type: 'stop' });
  },
  refreshHarnesses() {
    this.post({ type: 'listHarnesses' });
  },
  clearChat() {
    this.post({ type: 'clear' });
  },
  send() {
    if (!this.canSend()) return;
    this.post({ type: 'prompt', text: this.input });
    this.input = '';
    this.scrollToBottom(true);
  },
  cancel() {
    this.post({ type: 'cancel' });
  },
  choose(item, opt) {
    this.post({ type: 'permission', requestId: item.requestId, optionId: opt.optionId });
  },
  dismissPermission(item) {
    this.post({ type: 'permission', requestId: item.requestId, optionId: null });
  },
  onKeydown(e) {
    // Enter sends; Shift+Enter inserts a newline; ignore IME composition.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.send();
    }
  },
  toggleLogs() {
    this.showLogs = !this.showLogs;
  },
  toggleThoughts() {
    this.showThoughts = !this.showThoughts;
    chrome.storage.local.set({ showThoughts: this.showThoughts });
  },
  cycleSize() {
    const next = SIZES[(SIZES.indexOf(this.size) + 1) % SIZES.length];
    this.size = next;
    toContent({ type: 'acp-chat-resize', size: next });
  },
  close() {
    toContent({ type: 'acp-chat-close' });
  },

  // ---------- scrolling ----------

  isNearBottom() {
    const el = this.$refs.scroller;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  },
  scrollToBottom(force = false) {
    this.$nextTick(() => {
      const el = this.$refs.scroller;
      if (el && (force || this.isNearBottom())) el.scrollTop = el.scrollHeight;
    });
  },
  focusInput() {
    this.$nextTick(() => this.$refs.input?.focus());
  },
}));

Alpine.start();
