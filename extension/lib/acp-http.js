// ACP over HTTP: one POST per JSON-RPC message to `<url>/acp`, used for remote
// agents such as pipool (no native host, no local process).
//
// The server answers each POST with one of:
//   202                 notification or client response accepted
//   application/json    a single JSON-RPC response (initialize, session/new)
//   text/event-stream   JSON-RPC messages as SSE `data:` lines: session/update
//                       notifications, then the response for this request id
//                       (session/prompt, session/load)
//
// `listen(sessionId)` additionally holds `GET <url>/acp?sessionId=…` open: the
// server pushes turns nobody prompted (schedules, webhooks) as notifications.
// It reconnects with backoff until close().
//
// Every message received is handed to `onMessage`, so AcpClient sees the same
// stream it would get from a stdio harness. If a request fails at the HTTP
// level, or its stream ends without a response, a JSON-RPC error response is
// synthesized so the pending request still settles.

export class HttpTransport {
  /**
   * @param {object} opts
   * @param {string} opts.url   base URL of the agent server, e.g. https://pool.example.com
   * @param {(msg: object) => void} opts.onMessage
   * @param {(text: string) => void} [opts.onLog]
   */
  constructor({ url, onMessage, onLog }) {
    this.endpoint = `${String(url).replace(/\/+$/, '')}/acp`;
    this.onMessage = onMessage;
    this.onLog = onLog ?? (() => {});
    this.inflight = new Set(); // AbortControllers
    this.closed = false;
    this.listening = false;
  }

  get busy() {
    return this.inflight.size > 0;
  }

  /** Hold the session's push stream open (background turns). */
  async listen(sessionId) {
    if (this.listening) return;
    this.listening = true;
    const url = `${this.endpoint}?sessionId=${encodeURIComponent(sessionId)}`;
    let delay = 1000;
    while (!this.closed) {
      const ctrl = new AbortController();
      this.listenCtrl = ctrl;
      try {
        const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: ctrl.signal });
        if (res.status === 404) {
          this.onLog('push stream: session no longer exists');
          break;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        delay = 1000;
        await readSse(res.body, (m) => !this.closed && this.onMessage(m));
      } catch (err) {
        if (this.closed) break;
        this.onLog(`push stream dropped (${err.message}); retrying in ${delay / 1000}s`);
      }
      if (this.closed) break;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
    this.listening = false;
  }

  send(msg) {
    this.post(msg).catch((err) => {
      if (this.closed) return;
      this.onLog(`${msg.method ?? 'response'} failed: ${err.message}`);
      this.fail(msg, err.message);
    });
  }

  close() {
    this.closed = true;
    this.listenCtrl?.abort();
    for (const c of this.inflight) c.abort();
    this.inflight.clear();
  }

  async post(msg) {
    const ctrl = new AbortController();
    this.inflight.add(ctrl);
    let answered = false;
    const deliver = (m) => {
      if (msg.id !== undefined && m?.id === msg.id && m.method === undefined) answered = true;
      if (!this.closed) this.onMessage(m);
    };
    try {
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      const res = await fetch(this.endpoint, { method: 'POST', headers, body: JSON.stringify(msg), signal: ctrl.signal });
      if (res.status === 202) return;
      if (res.status === 401) {
        throw new Error('The server requires client auth (PIPOOL_API_KEYS is set). Unset it on the server to connect.');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).trim()}`.trim());
      if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        await readSse(res.body, deliver);
      } else {
        const text = await res.text();
        if (text.trim()) deliver(JSON.parse(text));
      }
      if (msg.id !== undefined && msg.method !== undefined && !answered && !this.closed) {
        this.fail(msg, 'stream ended without a response');
      }
    } finally {
      this.inflight.delete(ctrl);
    }
  }

  fail(msg, message) {
    if (msg.id === undefined || msg.method === undefined) return; // notifications / our replies
    this.onMessage({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } });
  }
}

/** Parse an SSE body, calling onData with each event's JSON `data`. */
async function readSse(body, onData) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) onData(JSON.parse(data));
    }
  }
}
