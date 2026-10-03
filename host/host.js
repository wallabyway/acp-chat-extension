#!/usr/bin/env node
// ACP Chat native messaging host.
//
// A deliberately thin relay: Chrome talks to this process over native
// messaging (length-prefixed JSON on stdio); this process spawns one ACP agent
// harness (e.g. `kiro-cli acp`) and pipes newline-delimited JSON-RPC between
// the two. All ACP decoding happens in the browser.
//
// Security: the browser can only pick a harness by *id*. Commands, args and
// env come exclusively from the local config file, never from the extension.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameDecoder, LineDecoder, encodeMessage } from './framing.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function expandHome(p) {
  if (!p) return p;
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

export function configPath() {
  const candidates = [
    process.env.ACP_CHAT_CONFIG,
    join(homedir(), '.config', 'acp-chat', 'harnesses.json'),
    join(HERE, 'harnesses.json'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? candidates.at(-1);
}

export function loadConfig(path = configPath()) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const defaultCwd = expandHome(raw.defaultCwd ?? '~');
  const configDir = dirname(path);
  const sub = (s) => String(s).replaceAll('${configDir}', configDir);
  const harnesses = (raw.harnesses ?? []).map((h) => ({
    ...h,
    // "${configDir}" in command/args expands to the config file's directory
    // (used by the bundled mock agent).
    command: sub(h.command),
    args: (h.args ?? []).map(sub),
    cwd: expandHome(h.cwd ?? defaultCwd),
  }));
  return { path, defaultCwd, harnesses };
}

function main() {
  let config;
  let child = null;

  const send = (msg) => {
    for (const frame of encodeMessage(msg)) process.stdout.write(frame);
  };

  const stopChild = () => {
    if (!child) return;
    const c = child;
    child = null;
    c.stdin.end();
    c.kill('SIGTERM');
    setTimeout(() => c.exitCode === null && c.kill('SIGKILL'), 3000).unref();
  };

  const start = ({ harnessId }) => {
    stopChild();
    config = loadConfig();
    const h = config.harnesses.find((x) => x.id === harnessId);
    if (!h) return send({ type: 'error', message: `Unknown harness "${harnessId}" (config: ${config.path})` });

    let proc;
    try {
      proc = spawn(h.command, h.args, {
        cwd: h.cwd,
        env: { ...process.env, ...(h.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Don't crash the host if the agent dies while we're writing to it.
      proc.stdin.on('error', (err) => send({ type: 'log', stream: 'host', text: `stdin: ${err.message}` }));
    } catch (err) {
      return send({ type: 'error', message: `Failed to spawn ${h.command}: ${err.message}` });
    }
    child = proc;

    const lines = new LineDecoder((line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return send({ type: 'log', stream: 'stdout', text: line });
      }
      send({ type: 'recv', message });
    });
    proc.stdout.on('data', (d) => lines.push(d));
    proc.stderr.on('data', (d) => send({ type: 'log', stream: 'stderr', text: d.toString('utf8') }));
    proc.on('error', (err) => {
      if (child === proc) child = null;
      send({ type: 'error', message: `${h.command}: ${err.message}` });
    });
    proc.on('spawn', () => send({ type: 'started', harnessId: h.id, name: h.name, pid: proc.pid, cwd: h.cwd }));
    proc.on('exit', (code, signal) => {
      if (child === proc) child = null;
      send({ type: 'exit', harnessId: h.id, pid: proc.pid, code, signal });
    });
  };

  const handle = (msg) => {
    switch (msg?.type) {
      case 'list': {
        try {
          config = loadConfig();
          send({
            type: 'harnesses',
            configPath: config.path,
            defaultCwd: config.defaultCwd,
            harnesses: config.harnesses.map(({ id, name, cwd, description }) => ({ id, name, cwd, description })),
          });
        } catch (err) {
          send({ type: 'error', message: `Config error: ${err.message}` });
        }
        break;
      }
      case 'start':
        start(msg);
        break;
      case 'send':
        if (!child) return send({ type: 'error', message: 'No agent running' });
        child.stdin.write(JSON.stringify(msg.message) + '\n');
        break;
      case 'stop':
        stopChild();
        break;
      case 'ping':
        send({ type: 'pong' });
        break;
      default:
        send({ type: 'error', message: `Unknown host command: ${msg?.type}` });
    }
  };

  const decoder = new FrameDecoder(handle, (err) => send({ type: 'error', message: `Bad frame: ${err.message}` }));
  process.stdin.on('data', (d) => decoder.push(d));
  // Chrome closed the port: take the agent down with us.
  process.stdin.on('end', () => {
    stopChild();
    setTimeout(() => process.exit(0), 200);
  });
  process.on('SIGTERM', () => {
    stopChild();
    process.exit(0);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
