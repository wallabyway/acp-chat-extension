// Reduces ACP session/update notifications into a flat list of chat items the
// panel can render. Every mutation returns the indices that changed so the
// background worker can push small incremental updates to open panels.
//
// Item shapes (all have a unique `id` and a `type`):
//   { type: 'user' | 'agent' | 'thought', text }
//   { type: 'tool', toolCallId, title, kind, status, detail, input, locations }
//   { type: 'plan', entries: [{ content, status, priority }] }
//   { type: 'permission', requestId, title, options: [{ optionId, name, kind }], outcome }
//   { type: 'system' | 'error', text }

let uid = 0;
const newId = () => `i${Date.now().toString(36)}${(uid++).toString(36)}`;

export function blockToText(block) {
  if (!block) return '';
  switch (block.type) {
    case 'text':
      return block.text ?? '';
    case 'image':
      return '[image]';
    case 'audio':
      return '[audio]';
    case 'resource_link':
      return `[${block.name ?? block.uri}](${block.uri})`;
    case 'resource':
      return block.resource?.text ?? `[resource ${block.resource?.uri ?? ''}]`;
    default:
      return '';
  }
}

export function toolContentToText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (c.type === 'content') return blockToText(c.content);
      if (c.type === 'diff') return `diff ${c.path}\n` + (c.newText ?? '');
      if (c.type === 'terminal') return `[terminal ${c.terminalId}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Best-effort text for a tool's rawOutput / rawInput. ACP leaves these
 * agent-defined; e.g. kiro-cli puts results in rawOutput.items[].Text rather
 * than in the standard `content` array.
 */
export function rawToText(raw) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(rawToText).filter(Boolean).join('\n');
  if (typeof raw === 'object') {
    for (const key of ['Text', 'text', 'output', 'stdout', 'result']) {
      if (typeof raw[key] === 'string') {
        return key === 'stdout' && raw.stderr ? `${raw.stdout}\n${raw.stderr}` : raw[key];
      }
    }
    if (raw.Json !== undefined) return rawToText(raw.Json);
    for (const key of ['items', 'content', 'contents']) {
      if (Array.isArray(raw[key])) return rawToText(raw[key]);
    }
    if (raw.type === 'text' && typeof raw.text === 'string') return raw.text;
  }
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

function inputToText(rawInput) {
  if (!rawInput || typeof rawInput !== 'object') return rawToText(rawInput);
  // Drop agent bookkeeping fields (e.g. kiro's __tool_use_purpose) from the dump.
  const clean = Object.fromEntries(Object.entries(rawInput).filter(([k]) => !k.startsWith('__')));
  return Object.keys(clean).length ? JSON.stringify(clean, null, 2) : '';
}

const CHUNK_TYPES = {
  user_message_chunk: 'user',
  agent_message_chunk: 'agent',
  agent_thought_chunk: 'thought',
};

export class Transcript {
  constructor(items = []) {
    this.items = items;
    this.commands = [];
    this.modeId = null;
  }

  push(item) {
    this.items.push({ id: newId(), ...item });
    return [this.items.length - 1];
  }

  addUser(text) {
    return this.push({ type: 'user', text, local: true });
  }

  addSystem(text) {
    return this.push({ type: 'system', text });
  }

  addError(text) {
    return this.push({ type: 'error', text });
  }

  /** Apply one `update` object from a session/update notification. */
  apply(update) {
    if (!update) return [];
    const kind = update.sessionUpdate;

    if (CHUNK_TYPES[kind]) {
      const type = CHUNK_TYPES[kind];
      const text = blockToText(update.content);
      const lastIdx = this.items.length - 1;
      const last = this.items[lastIdx];
      // The agent may echo the prompt we already rendered locally; skip it.
      if (type === 'user' && last?.type === 'user' && last.local) return [];
      // Consecutive chunks of the same kind stream into one bubble; any other
      // item in between (tool call, permission, new user turn) starts a new one.
      if (last && last.type === type && !last.local) {
        last.text += text;
        return [lastIdx];
      }
      return this.push({ type, text });
    }

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const idx = this.findTool(update.toolCallId);
      if (idx >= 0) return this.mergeTool(idx, update);
      this.push({
        type: 'tool',
        toolCallId: update.toolCallId,
        title: 'Tool call',
        kind: 'other',
        status: 'pending',
        detail: '',
        input: '',
        locations: '',
      });
      return this.mergeTool(this.items.length - 1, update);
    }

    if (kind === 'plan') {
      // One plan card per turn: replace the latest plan since the last user message.
      for (let i = this.items.length - 1; i >= 0 && this.items[i].type !== 'user'; i--) {
        if (this.items[i].type === 'plan') {
          this.items[i].entries = update.entries ?? [];
          return [i];
        }
      }
      return this.push({ type: 'plan', entries: update.entries ?? [] });
    }

    if (kind === 'available_commands_update') {
      this.commands = update.availableCommands ?? [];
      return [];
    }
    if (kind === 'current_mode_update') {
      this.modeId = update.currentModeId ?? null;
      return [];
    }
    return [];
  }

  findTool(toolCallId) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].type === 'tool' && this.items[i].toolCallId === toolCallId) return i;
    }
    return -1;
  }

  mergeTool(idx, update) {
    const item = this.items[idx];
    if (update.title) item.title = update.title;
    if (update.kind) item.kind = update.kind;
    if (update.status) item.status = update.status;
    // Prefer standard ACP `content`; fall back to the agent-defined rawOutput.
    const fromContent = update.content ? toolContentToText(update.content) : '';
    if (fromContent) item.detail = fromContent;
    else if (update.rawOutput !== undefined) item.detail = rawToText(update.rawOutput);
    if (update.rawInput !== undefined) item.input = inputToText(update.rawInput);
    if (Array.isArray(update.locations) && update.locations.length) {
      item.locations = update.locations.map((l) => (l.line ? `${l.path}:${l.line}` : l.path)).join(', ');
    }
    return [idx];
  }

  addPermission(requestId, params) {
    return this.push({
      type: 'permission',
      requestId,
      title: params?.toolCall?.title ?? 'The agent wants to run a tool',
      options: (params?.options ?? []).map(({ optionId, name, kind }) => ({ optionId, name, kind })),
      outcome: null,
    });
  }

  resolvePermission(requestId, outcomeLabel) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.type === 'permission' && it.requestId === requestId) {
        it.outcome = outcomeLabel;
        return [i];
      }
    }
    return [];
  }
}
