// Transport-agnostic ACP (Agent Client Protocol) client: JSON-RPC 2.0 peer.
// Spec: https://agentclientprotocol.com
//
// The extension acts as the ACP *client* (like Zed); the CLI harness is the
// *agent*. Messages flow both ways:
//   client -> agent requests:  initialize, session/new, session/prompt, ...
//   client -> agent notifies:  session/cancel
//   agent -> client notifies:  session/update (streamed chunks, tool calls, plans)
//   agent -> client requests:  session/request_permission, fs/*, terminal/*

export const PROTOCOL_VERSION = 1;

export class AcpError extends Error {
  constructor(error) {
    super(error?.message ?? 'ACP error');
    this.code = error?.code;
    this.data = error?.data;
  }
}

export class AcpClient {
  /**
   * @param {(msg: object) => void} send  write one JSON-RPC message to the agent
   * @param {object} handlers
   * @param {(params: object) => void} [handlers.onSessionUpdate]
   * @param {(params: object, id: number|string) => Promise<object>} [handlers.onRequestPermission]
   * @param {(method: string, params: object) => void} [handlers.onExtNotification]  "_"-prefixed vendor notifications
   */
  constructor(send, handlers = {}) {
    this.sendRaw = send;
    this.handlers = handlers;
    this.nextId = 1;
    this.pending = new Map();
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendRaw({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.sendRaw({ jsonrpc: '2.0', method, params });
  }

  /** Feed one decoded JSON-RPC message from the agent. */
  async receive(msg) {
    if (!msg || msg.jsonrpc !== '2.0') return;

    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new AcpError(msg.error));
      else p.resolve(msg.result);
      return;
    }

    // Notification from the agent.
    if (msg.id === undefined) {
      if (msg.method === 'session/update') this.handlers.onSessionUpdate?.(msg.params);
      else this.handlers.onExtNotification?.(msg.method, msg.params);
      return;
    }

    // Request from the agent: we must reply.
    try {
      let result;
      if (msg.method === 'session/request_permission' && this.handlers.onRequestPermission) {
        result = await this.handlers.onRequestPermission(msg.params, msg.id);
      } else {
        // We advertise fs/terminal capabilities as false, so harnesses use their
        // own built-in file and shell tools.
        throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
      }
      this.sendRaw({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
    } catch (err) {
      this.sendRaw({ jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
    }
  }

  /** Reject all in-flight requests (agent exited / connection dropped). */
  failAll(reason) {
    for (const [, p] of this.pending) p.reject(new AcpError({ code: -32000, message: reason }));
    this.pending.clear();
  }

  // --- Convenience wrappers -------------------------------------------------

  initialize() {
    return this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'acp-chat-extension', title: 'ACP Chat (Chrome)', version: '0.1.0' },
    });
  }

  newSession(cwd) {
    return this.request('session/new', { cwd, mcpServers: [] });
  }

  prompt(sessionId, text) {
    return this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  }

  cancel(sessionId) {
    this.notify('session/cancel', { sessionId });
  }
}
