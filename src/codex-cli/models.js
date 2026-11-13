import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createAcpPeer } from '../cli/acp-rpc.js';
import { normalizeCodexConfig } from './config.js';
import { verifyCodexWorkspace, codexEnvironment } from './environment.js';

const queries = new Set();
export async function closeCodexModelQueries() { await Promise.all([...queries].map(stop => stop())); }

export function parseCodexModels(session) {
  const option = session.configOptions?.find(item => item.category === 'model' || item.id === 'model');
  const flat = (items, depth = 0) => depth > 4 ? [] : (items || []).flatMap(item =>
    Array.isArray(item.options) ? flat(item.options, depth + 1) : [item]);
  const models = [], seen = new Set();
  for (const item of flat(option?.options)) {
    if (typeof item.value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,199}$/.test(item.value) || seen.has(item.value)) continue;
    seen.add(item.value);
    models.push({ id: item.value, name: typeof item.name === 'string' ? item.name.slice(0, 200) : item.value });
    if (models.length === 128) break;
  }
  if (!models.length) throw new Error('Codex model catalog unavailable');
  return { models, currentModel: models.some(m => m.id === option.currentValue) ? option.currentValue : '' };
}

export const readCodexModels = (config, options) => readCodexMetadata(config, options);
export const readCodexQuotaStatus = (config, options) => readCodexMetadata(config, { ...options, kind: 'quota' });

/** No model turn: catalog discovery or the adapter's advertised local /status command. */
async function readCodexMetadata(config, { spawnProcess = spawn, timeoutMs = 20000, kind = 'models' } = {}) {
  const cfg = normalizeCodexConfig(config);
  const home = await verifyCodexWorkspace(cfg.workspace);
  if (queries.size) throw new Error('Codex model query busy');
  const controller = new AbortController();
  let peer, workspace, sessionId, statusText = '';
  const commands = new Map();
  const stop = async () => { controller.abort(); await peer?.close(); };
  queries.add(stop);
  const timer = setTimeout(stop, timeoutMs);
  try {
    workspace = await fs.mkdtemp(path.join(cfg.workspace, 'codex-models-'));
    controller.signal.throwIfAborted();
    const env = codexEnvironment(home, cfg.effort);
    peer = createAcpPeer(cfg.executable, cfg.adapterScript ? [cfg.adapterScript] : [], {
      cwd: workspace, signal: controller.signal,
      spawnProcess: (exe, args, options) => spawnProcess(exe, args, { ...options, env }),
      request: async () => { throw new Error('Codex discovery client operation denied'); },
      update: (method, params) => {
        if (method !== 'session/update') return;
        const update = params.update;
        if (update?.sessionUpdate === 'available_commands_update') commands.set(params.sessionId, update.availableCommands || []);
        if (params.sessionId === sessionId && update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') statusText += update.content.text || '';
      }
    });
    const init = await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'qq-agent-plus', version: '0.9' } });
    if (init.protocolVersion !== 1) throw new Error('Unsupported Codex ACP protocol');
    const session = await peer.call('session/new', { cwd: workspace, mcpServers: [] });
    if (kind === 'quota') {
      sessionId = session.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid Codex status session');
      const deadline = Date.now() + 3000;
      while (!commands.get(sessionId)?.some(command => command.name === 'status')) {
        controller.signal.throwIfAborted();
        if (Date.now() > deadline) throw new Error('Codex local status command unavailable');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const result = await peer.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/status' }] });
      if (result.stopReason !== 'end_turn') throw new Error('Codex status query incomplete');
      return statusText;
    }
    return parseCodexModels(session);
  } finally {
    clearTimeout(timer); await stop();
    try {
      if (workspace) {
        const target = path.resolve(workspace);
        if (path.dirname(target) !== path.resolve(cfg.workspace) || !path.basename(target).startsWith('codex-models-')) throw new Error('Invalid Codex discovery cleanup target');
        await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
    finally { queries.delete(stop); }
  }
}
