// Content script: injects a floating chat button and a right-hand panel that
// hosts the extension's panel.html in an iframe. The iframe runs in the
// extension origin, so the page (and its CSP) can't read or script it.
(() => {
  if (window.__acpChatInjected) return;
  window.__acpChatInjected = true;

  const SIZES = ['small', 'medium', 'large'];
  const DEFAULT_SIZE = 'medium';

  const host = document.createElement('div');
  host.id = 'acp-chat-root';
  // Closed shadow root: page scripts and styles can't reach inside.
  const root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .fab {
      position: fixed; right: 24px; bottom: 24px; z-index: 2147483646;
      width: 56px; height: 56px; border-radius: 9999px; border: none; cursor: pointer;
      background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff;
      box-shadow: 0 10px 25px -5px rgb(0 0 0 / .35); display: grid; place-items: center;
      transition: transform .15s ease;
    }
    .fab:hover { transform: scale(1.06); }
    .fab[hidden] { display: none; }
    .fab:focus-visible { outline: 3px solid #a5b4fc; outline-offset: 2px; }
    .fab svg { width: 26px; height: 26px; }
    .panel {
      position: fixed; z-index: 2147483647; background: #fff; overflow: hidden;
      box-shadow: 0 25px 50px -12px rgb(0 0 0 / .4); border-radius: 16px;
      transition: width .2s ease, height .2s ease, top .2s ease, bottom .2s ease, right .2s ease;
    }
    .panel[hidden] { display: none; }
    .panel.small  { right: 24px; bottom: 24px; width: 360px; height: min(480px, calc(100vh - 48px)); }
    .panel.medium { right: 24px; bottom: 24px; width: 440px; height: min(720px, calc(100vh - 48px)); }
    .panel.large  { right: 0; top: 0; bottom: 0; width: 40vw; min-width: 360px; height: 100vh; border-radius: 0; }
    iframe { border: 0; width: 100%; height: 100%; display: block; color-scheme: normal; }
  `;

  const fab = document.createElement('button');
  fab.className = 'fab';
  fab.type = 'button';
  fab.title = 'Open ACP Chat';
  fab.setAttribute('aria-label', 'Open ACP Chat');
  // Build the icon with DOM APIs (pages like google.com enforce Trusted Types).
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  })) svg.setAttribute(k, v);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z');
  svg.appendChild(path);
  fab.appendChild(svg);

  const panel = document.createElement('div');
  panel.className = `panel ${DEFAULT_SIZE}`;
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'ACP Chat');

  let iframe = null;
  let size = DEFAULT_SIZE;

  function applySize(next) {
    size = SIZES.includes(next) ? next : DEFAULT_SIZE;
    panel.classList.remove(...SIZES);
    panel.classList.add(size);
  }

  function open() {
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.title = 'ACP Chat';
      iframe.allow = 'clipboard-write';
      iframe.src = chrome.runtime.getURL('panel.html');
      panel.appendChild(iframe);
    }
    panel.hidden = false;
    fab.hidden = true;
    chrome.runtime.sendMessage({ type: 'acp-chat-focus' }).catch(() => {});
  }

  function close() {
    panel.hidden = true;
    fab.hidden = false;
    fab.focus();
  }

  const toggle = () => (panel.hidden ? open() : close());

  fab.addEventListener('click', open);

  // Control messages come only from our own extension (panel iframe or the
  // toolbar button via the service worker), never from the host page.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    switch (msg?.type) {
      case 'acp-chat-toggle':
        toggle();
        break;
      case 'acp-chat-close':
        close();
        break;
      case 'acp-chat-resize':
        applySize(msg.size ?? SIZES[(SIZES.indexOf(size) + 1) % SIZES.length]);
        chrome.storage.local.set({ panelSize: size });
        sendResponse({ size });
        break;
      case 'acp-chat-get-size':
        sendResponse({ size });
        break;
    }
  });

  chrome.storage.local.get('panelSize').then(({ panelSize }) => applySize(panelSize ?? DEFAULT_SIZE));

  root.append(style, fab, panel);
  document.documentElement.appendChild(host);
})();
