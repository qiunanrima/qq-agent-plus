// Run-scoped local IPC broker. No TCP listener, global tool catalog or credentials.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const LIMIT = 1024 * 1024;

// Preserve mutable host state while giving an in-flight tool its own immutable
// cancellation signal. A cancelled task must never see a later tool's signal.
export function contextWithToolSignal(ctx, signal) {
  if (ctx.signal === signal) return ctx;
  return new Proxy(ctx, {
    get: (target, key, receiver) => key === 'signal' ? signal : Reflect.get(target, key, receiver),
    set: (target, key, value) => key !== 'signal' && Reflect.set(target, key, value)
  });
}

/** Adapt the host's existing audited executor; never replay MCP calls as text. */
export function createMcpHostRun({ chatKey, runId, signal, allowed, execute, transcript }) {
  const { messages, auditMessages, toolResults, imageUserMessages } = transcript;
  return {
    chatKey, runId, allowed,
    execute: async (name, args, callSignal) => {
      const scopedSignal = AbortSignal.any([signal, callSignal]);
      scopedSignal.throwIfAborted();
      const call = { id: `mcp_${randomUUID()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
      const assistant = { role: 'assistant', content: null, tool_calls: [call] };
      messages.push(assistant);
      auditMessages.push(structuredClone(assistant));
      const imageStart = imageUserMessages.length;
      const result = await execute(call, scopedSignal);
      const { role, tool_call_id, content } = toolResults.at(-1);
      messages.push({ role, tool_call_id, name, content }, ...imageUserMessages.slice(imageStart));
      return result;
    }
  };
}

/** Host must supply its run gates (skill, finish, budget, approvals) via authorize. */
export async function createQqRunToolMcp({ toolDefs, ctx, authorize, ...options }) {
  if (!ctx?.chatKey || !ctx?.session?.id) throw new Error('Missing QQ run context');
  const { executeTool } = await import('../tools/tools.js');
  const runCtx = { ...ctx };
  return createRunToolMcp({ ...options, tools: toolDefs.map(({ name, description, parameters }) => ({ name, description, parameters })),
    chatKey: ctx.chatKey, runId: ctx.session.id, signal: ctx.signal, authorize,
    execute: ({ name, arguments: args, signal }) => {
      runCtx.signal = signal;
      return executeTool(toolDefs, runCtx, name, JSON.stringify(args));
    } });
}

export async function createRunToolMcp({ tools, execute, chatKey, runId, signal,
  authorize, timeoutMs = 120000, maxCalls = 16 }) {
  if (!chatKey || !runId || typeof execute !== 'function' || typeof authorize !== 'function') throw new Error('MCP run requires scope, executor and authorization');
  if (!Array.isArray(tools) || tools.length > 128 || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 128
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000) throw new Error('Invalid MCP limits');
  signal?.throwIfAborted();
  const catalog = new Map();
  for (const tool of tools) {
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(tool.name) || catalog.has(`qq_${tool.name}`)) throw new Error('Invalid MCP tool name');
    catalog.set(`qq_${tool.name}`, structuredClone(tool));
  }
  if (Buffer.byteLength(JSON.stringify([...catalog])) > LIMIT / 2) throw new Error('MCP catalog exceeds limit');
  const id = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('hex');
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\qq-agent-${id}` : path.join(os.tmpdir(), `qq-agent-${id}.sock`);
  const controller = new AbortController();
  const scope = Object.freeze({ chatKey: String(chatKey), runId: String(runId), signal: controller.signal });
  const sockets = new Set(), ledger = [], requests = new Map();
  let closed = false, tail = Promise.resolve();
  const reply = (request, result) => ({ jsonrpc: '2.0', id: request.id, result });
  const error = (request, code, message) => ({ jsonrpc: '2.0', id: request?.id ?? null, error: { code, message } });
  const available = () => !closed && !controller.signal.aborted;
  const processRequest = async (request, state) => {
    if (!available()) return error(request, -32000, 'Run revoked');
    if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') return error(request, -32600, 'Invalid request');
    if (request.id == null) return null;
    if (!['string', 'number'].includes(typeof request.id)) return error(request, -32600, 'Invalid request ID');
    if (request.method === 'initialize') {
      state.initialized = true;
      return reply(request, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'qq-agent-run-tools', version: '0.1.0' } });
    }
    if (!state.initialized) return error(request, -32000, 'Initialize first');
    if (request.method === 'ping') return reply(request, {});
    if (request.method === 'tools/list') return reply(request, { tools: [...catalog].map(([name, tool]) => ({ name, description: tool.description || '', inputSchema: tool.parameters || { type: 'object' } })) });
    if (request.method !== 'tools/call') return error(request, -32601, 'Method not supported');
    const tool = catalog.get(request.params?.name);
    const args = request.params?.arguments ?? {};
    if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) return error(request, -32602, 'Unknown tool or invalid arguments');
    const key = `${typeof request.id}:${request.id}`;
    const fingerprint = JSON.stringify(request.params);
    if (requests.has(key)) {
      const cached = requests.get(key);
      return cached.fingerprint === fingerprint ? cached.promise : error(request, -32600, 'Request ID reused');
    }
    if (requests.size >= maxCalls) return error(request, -32000, 'Tool call budget exhausted');
    const entry = { name: tool.name, state: 'queued' };
    ledger.push(entry);
    const promise = tail.then(async () => {
      if (!available() || await authorize({ ...scope, name: tool.name, arguments: args }) !== true || !available()) {
        entry.state = 'denied';
        return error(request, -32000, 'Tool authorization denied or run revoked');
      }
      entry.state = 'unknown'; // Never replay a call that might have performed an external write.
      try {
        const result = await execute({ ...scope, name: tool.name, arguments: args });
        if (!available()) return error(request, -32000, 'Run revoked; outcome must not be retried');
        entry.state = result?.isError ? 'failed' : 'succeeded';
        const content = typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content ?? '');
        if (Buffer.byteLength(content) > LIMIT / 2) {
          close();
          return error(request, -32000, 'Tool result exceeds limit; do not retry');
        }
        return reply(request, { content: [{ type: 'text', text: content }], isError: Boolean(result?.isError) });
      } catch {
        close(); // Revoke the whole capability after an ambiguous external write.
        return error(request, -32000, 'Tool outcome unknown; do not retry');
      }
    }).catch(() => error(request, -32000, 'Tool request failed; do not retry'));
    requests.set(key, { fingerprint, promise });
    tail = promise.then(() => {});
    return promise;
  };
  const server = net.createServer(socket => {
    if (closed || sockets.size >= 8) { socket.destroy(); return; }
    sockets.add(socket);
    const state = { initialized: false, authenticated: false };
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      if (state.authenticated) close(); // No reconnect/replay after losing a run transport.
    });
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > LIMIT) return socket.destroy();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let envelope;
        try { envelope = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!available() || envelope.token !== token) { socket.destroy(); return; }
        state.authenticated = true;
        processRequest(envelope.message, state).then(response => {
          if (socket.writableLength > LIMIT) { socket.destroy(); return; }
          if (response && !socket.destroyed) socket.write(JSON.stringify(response) + '\n');
        }).catch(() => socket.destroy());
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  const close = () => {
    if (closed) return;
    closed = true; controller.abort(new Error('MCP run revoked'));
    clearTimeout(timer); signal?.removeEventListener('abort', close);
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  const timer = setTimeout(close, timeoutMs);
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();
  return {
    serverConfig: { command: process.execPath, args: [fileURLToPath(new URL('./mcp-stdio.js', import.meta.url))],
      env: { QQ_AGENT_RUN_PIPE: endpoint, QQ_AGENT_RUN_TOKEN: token } },
    close, ledger: () => ledger.map(item => ({ ...item }))
  };
}
