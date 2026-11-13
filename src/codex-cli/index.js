import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createAcpPeer } from '../cli/acp-rpc.js';
import { createRunToolMcp } from '../cli/mcp-run.js';
import { normalizeCodexConfig } from './config.js';
import { verifyCodexWorkspace, codexEnvironment } from './environment.js';
import { closeCodexModelQueries } from './models.js';
import { createCodexPermissionPolicy } from './permissions.js';
export { verifyCodexWorkspace } from './environment.js';

const running = new Map();
export function codexStatus() { return { active: running.size, queued: 0, driver: 'acp' }; }
export async function closeCodexProcesses() { await Promise.all([closeCodexModelQueries(), ...[...running.values()].map(run => run.stop())]); }

/** Fresh process and ACP session per turn. Host MCP is the only external-write path. */
export async function codexCompletion({ config, messages, tools = [], toolChoice = 'auto', signal, isEnabled = () => true, mcpRun }, { spawnProcess = spawn } = {}) {
  const cfg = normalizeCodexConfig(config);
  signal?.throwIfAborted();
  if (!cfg.enabled || !isEnabled()) throw new Error('Codex CLI disabled');
  if (!mcpRun?.chatKey || !mcpRun.runId || typeof mcpRun.execute !== 'function' || typeof mcpRun.allowed !== 'function') throw new Error('Codex requires an authorized host run');
  for (const message of messages || []) if (Array.isArray(message.content) && message.content.some(p => p.type !== 'text')) throw new Error('Codex CLI currently supports text only');
  const prompt = 'Act as the supplied conversation role, respecting system messages, role card and memory. Use only qq_run MCP host tools. qq_send_message delivers to the current conversation; qq_finish ends this run. Never repeat successful or unknown external writes. Stop after finish. Do not use native tools. Conversation data:\n' + JSON.stringify({ messages, toolChoice });
  if (Buffer.byteLength(prompt) > 4 * 1024 * 1024) throw new Error('Codex prompt exceeds limit');
  if (running.has(mcpRun.chatKey) || running.size >= cfg.maxConcurrent) throw new Error('Codex CLI busy');
  const controller = new AbortController();
  const scoped = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let peer, bridge, workspace, sessionId, permissionPolicy, response = '', hostFinished = false;
  const entry = { stop: async () => { controller.abort(); await peer?.close(); } };
  running.set(mcpRun.chatKey, entry);
  const timer = setTimeout(() => controller.abort(new Error('Codex CLI timed out')), cfg.timeoutMs);
  const allowed = () => !scoped.aborted && isEnabled() && mcpRun.allowed() && !mcpRun.isFinished?.();
  const guard = setInterval(() => {
    if (!isEnabled() || !mcpRun.allowed()) controller.abort(new Error('Codex CLI disabled or cancelled'));
    else if (mcpRun.isFinished?.()) { hostFinished = true; controller.abort(); }
  }, 50);
  try {
    const home = await verifyCodexWorkspace(cfg.workspace);
    scoped.throwIfAborted();
    workspace = await fs.mkdtemp(path.join(cfg.workspace, 'codex-run-'));
    const selected = (tools || []).filter(t => toolChoice !== 'none' && (!toolChoice?.function?.name || t.function?.name === toolChoice.function.name));
    permissionPolicy = createCodexPermissionPolicy({ tools: selected.map(t => t.function.name), sessionId: () => sessionId, allowed });
    bridge = await createRunToolMcp({ tools: selected.map(t => t.function), chatKey: mcpRun.chatKey, runId: mcpRun.runId,
      signal: scoped, maxCalls: cfg.maxToolCalls, timeoutMs: cfg.timeoutMs, authorize: allowed,
      execute: async call => {
        try { return await mcpRun.execute(call.name, call.arguments, call.signal); }
        catch (error) { controller.abort(new Error('Codex host tool outcome unknown')); throw error; }
      } });
    const env = codexEnvironment(home, cfg.effort);
    peer = createAcpPeer(cfg.executable, cfg.adapterScript ? [cfg.adapterScript] : [], {
      cwd: workspace, signal: scoped,
      spawnProcess: (exe, args, options) => spawnProcess(exe, args, { ...options, env }),
      request: async (method, params) => {
        if (method === 'session/request_permission') return permissionPolicy.request(params);
        throw new Error('Codex native client operation denied');
      },
      update: (method, params) => {
        if (method === 'session/update') permissionPolicy.update(params);
        if (method === 'session/update' && params.sessionId === sessionId && params.update?.sessionUpdate === 'agent_message_chunk' && params.update.content?.type === 'text') response += params.update.content.text || '';
      }
    });
    const init = await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'qq-agent-plus', version: '0.9' } });
    if (init.protocolVersion !== 1) throw new Error('Unsupported Codex ACP protocol');
    const server = bridge.serverConfig;
    const session = await peer.call('session/new', { cwd: workspace, mcpServers: [{ name: 'qq_run', command: server.command, args: server.args, env: Object.entries(server.env).map(([name, value]) => ({ name, value })) }] });
    if (typeof session.sessionId !== 'string' || !session.sessionId) throw new Error('Invalid Codex ACP session');
    sessionId = session.sessionId;
    if (!session.modes?.availableModes?.some(m => m.id === 'read-only')) throw new Error('Codex restricted mode unavailable');
    await peer.call('session/set_mode', { sessionId, modeId: 'read-only' });
    const modelOption = session.configOptions?.find(option => option.category === 'model' || option.id === 'model');
    let configOptions = session.configOptions;
    if (cfg.model) {
      if (!modelOption?.options?.some(option => option.value === cfg.model)) throw new Error('Codex model unavailable; refresh model list');
      const updated = await peer.call('session/set_config_option', { sessionId, configId: modelOption.id, value: cfg.model });
      configOptions = updated.configOptions;
    }
    const effort = configOptions?.find(option => option.id === 'reasoning_effort');
    if (!effort?.options?.some(option => option.value === cfg.effort)) throw new Error('Codex reasoning effort unavailable');
    await peer.call('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: cfg.effort });
    const deadline = Date.now() + 5000;
    while (!bridge.isDiscovered()) {
      scoped.throwIfAborted();
      if (Date.now() > deadline) throw new Error('Codex MCP discovery failed');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const result = await peer.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
    scoped.throwIfAborted();
    if (mcpRun.isFinished?.()) hostFinished = true;
    if (toolChoice === 'required' && !bridge.ledger().length) throw new Error('Codex omitted required host tool');
    if (result.stopReason !== 'end_turn') throw new Error('Codex ACP turn did not complete');
    if (/Agent execution terminated due to error|Model produced invalid output/.test(response)) throw new Error('Codex execution failed');
    if (!response.trim() && !bridge.ledger().length) throw new Error('Empty Codex turn');
    return completed();
  } catch (error) {
    if ((hostFinished || mcpRun.isFinished?.()) && !signal?.aborted && isEnabled() && mcpRun.allowed()) { hostFinished = true; return completed(); }
    const failure = new Error(scoped.aborted ? 'Codex CLI cancelled or timed out' : error.message);
    failure.code = 'CODEX_NO_RETRY';
    throw failure;
  } finally {
    clearTimeout(timer); clearInterval(guard); controller.abort(); bridge?.close(); await peer?.close();
    if (workspace) {
      const target = path.resolve(workspace);
      if (path.dirname(target) !== path.resolve(cfg.workspace) || !path.basename(target).startsWith('codex-run-')) throw new Error('Invalid Codex cleanup target');
      try { await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      finally { running.delete(mcpRun.chatKey); }
    }
    running.delete(mcpRun.chatKey);
  }
  function completed() { return { message: { role: 'assistant', content: response }, finishReason: 'stop', toolsExecutedViaMcp: true,
    model: cfg.model || 'codex-default', originBaseUrl: 'codex-cli://local', usage: undefined,
    raw: { driver: 'acp', status: hostFinished ? 'HOST_FINISHED' : 'SUCCESS', usageUnavailable: true, permissions: permissionPolicy?.stats() } }; }
}
