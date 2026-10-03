#!/usr/bin/env node
// Minimal fake ACP agent (JSON-RPC 2.0 over newline-delimited stdio).
// Used as the offline "Mock agent" harness for UI work (and by local tests).
//
// Prompt behaviour:
//   - contains "tool"  -> emits a plan, a tool call and a permission request
//   - contains "slow"  -> streams slowly (useful for testing cancel)
//   - otherwise        -> streams a short markdown reply echoing the prompt

let nextId = 1000;
const pending = new Map();
const sessions = new Map();

const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const notify = (method, params) => write({ method, params });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    write({ id, method, params });
  });
const update = (sessionId, u) => notify('session/update', { sessionId, update: u });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamText(sessionId, text, delay, state) {
  for (const piece of text.match(/.{1,12}/gs) ?? []) {
    if (state.cancelled) return;
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } });
    await sleep(delay);
  }
}

async function prompt(id, { sessionId, prompt: blocks }) {
  const state = { cancelled: false };
  sessions.set(sessionId, state);
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const delay = /slow/i.test(text) ? 250 : 5;

  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking about the request…' } });

  if (/tool/i.test(text)) {
    update(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read the file', priority: 'high', status: 'in_progress' },
        { content: 'Summarise it', priority: 'medium', status: 'pending' },
      ],
    });
    const toolCall = { toolCallId: 'call_1', title: 'Read README.md', kind: 'read', status: 'pending' };
    update(sessionId, { sessionUpdate: 'tool_call', ...toolCall });
    const res = await request('session/request_permission', {
      sessionId,
      toolCall,
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const allowed = res?.outcome?.outcome === 'selected' && res.outcome.optionId === 'allow';
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: allowed ? 'completed' : 'failed',
      // kiro-cli style: result in agent-defined rawOutput rather than `content`.
      rawOutput: { items: [{ Text: allowed ? '-rw-r--r--  README.md\n-rw-r--r--  package.json' : 'Permission denied' }] },
    });
    update(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read the file', priority: 'high', status: 'completed' },
        { content: 'Summarise it', priority: 'medium', status: 'completed' },
      ],
    });
  }

  const reply =
    `## Mock reply\n\nYou said: **${text.replace(/[*_`]/g, '')}**\n\n` +
    '- item one\n- item `two`\n\n```js\nconsole.log("hello from the mock agent");\n```\n\n' +
    'See [ACP](https://agentclientprotocol.com).';
  await streamText(sessionId, reply, delay, state);
  write({ id, result: { stopReason: state.cancelled ? 'cancelled' : 'end_turn' } });
}

function handle(msg) {
  if (msg.id !== undefined && !msg.method) {
    pending.get(msg.id)?.(msg.result);
    pending.delete(msg.id);
    return;
  }
  switch (msg.method) {
    case 'initialize':
      return write({
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
          authMethods: [],
          agentInfo: { name: 'mock-agent', title: 'Mock Agent', version: '0.1.0' },
        },
      });
    case 'session/new':
      return write({ id: msg.id, result: { sessionId: `mock-${Date.now()}` } });
    case 'session/prompt':
      return void prompt(msg.id, msg.params);
    case 'session/cancel': {
      const s = sessions.get(msg.params?.sessionId);
      if (s) s.cancelled = true;
      // Spec: client must answer outstanding permission requests with "cancelled";
      // resolve locally too in case it doesn't.
      for (const [, resolve] of pending) resolve({ outcome: { outcome: 'cancelled' } });
      pending.clear();
      return;
    }
    default:
      if (msg.id !== undefined) write({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
