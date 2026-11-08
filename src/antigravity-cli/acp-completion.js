import { createAcpPeer } from './acp-rpc.js';
import { createAcpPermissionHandler } from './acp-permissions.js';
import { verifyNativeHooks } from './verify-native-hooks.js';
import { createAcpNativeClient } from './acp-native-client.js';

/** One ACP session per host run; no permanent permissions or automatic retry. */
export async function acpCompletion({ config, invocation, prompt, mcpRun, signal, isEnabled, spawnProcess }, { verify = verifyNativeHooks, pool } = {}) {
  const controller = new AbortController();
  const scopedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const startedAt = Date.now(), timings = {};
  let sessionId, response = '', hostFinished = false, peer, lease, abortPeer, finishTimer, healthy = false;
  const permit = createAcpPermissionHandler({ sessionId: () => sessionId, mcpRun,
    workspace: invocation.workspace, controlRoot: config.workspace, signal: scopedSignal, isEnabled, maxCalls: config.maxToolCalls,
    imageAccess: invocation.imageAccess });
  const native = createAcpNativeClient({ sessionId: () => sessionId, workspace: invocation.workspace, controlRoot: config.workspace, mcpRun,
    signal: scopedSignal, isEnabled, maxCalls: config.maxToolCalls, onUnknownWrite: error => controller.abort(error) });
  const timer = setTimeout(() => controller.abort(new Error('Antigravity CLI timed out')), config.timeoutMs);
  const guard = setInterval(() => {
    if (!isEnabled() || invocation.policyChanged()) controller.abort(new Error('Antigravity permission policy changed'));
    else if (mcpRun.isFinished?.() && !hostFinished) {
      hostFinished = true;
      if (pool && sessionId) {
        peer?.notify('session/cancel', { sessionId });
        finishTimer = setTimeout(() => controller.abort(new Error('Host finished')), 1500);
      }
      else controller.abort(new Error('Host finished'));
    }
  }, 100);
  try {
    if (!Array.isArray(invocation.acpMcpServers) || invocation.acpMcpServers.length !== 1
      || invocation.acpMcpServers[0].name !== 'qq_run') throw new Error('ACP requires the run-scoped qq_run MCP server');
    const handlers = {
      request: (method, params) => {
        if (method === 'session/request_permission') return permit(params);
        return native.request(method, params);
      },
      update: (method, params) => {
        if (method !== 'session/update' || params?.sessionId !== sessionId) return;
        if (params.update?.sessionUpdate === 'agent_message_chunk' && params.update.content?.type === 'text') response += params.update.content.text || '';
      }
    };
    const create = async entry => {
      await verify(config, invocation, { signal: scopedSignal });
      scopedSignal.throwIfAborted();
      const connection = createAcpPeer(config.executable, ['acp', '--agent', config.agent, '--include-default-customizations=false'], {
        cwd: invocation.workspace, signal: pool ? undefined : scopedSignal, spawnProcess,
        request: (method, params) => {
          const active = pool ? entry.active : handlers;
          if (!active) throw new Error('ACP has no active host run');
          return active.request(method, params);
        },
        update: (method, params) => (pool ? entry.active : handlers)?.update(method, params)
      });
      const abort = () => { void connection.close(); };
      scopedSignal.addEventListener('abort', abort, { once: true });
      try {
        const init = await connection.call('initialize', { protocolVersion: 1, clientCapabilities: mcpRun.platform === 'wechat' && !config.nativeApproval ? {} : native.capabilities, clientInfo: { name: 'qq-agent-plus', version: '0.9' } });
        if (init?.protocolVersion !== 1) throw new Error('Unsupported ACP protocol');
        if (pool) invocation.retainWorkspace();
        return { peer: connection, dispose: () => invocation.releaseWorkspace() };
      } catch (error) { await connection.close(); throw error; }
      finally { scopedSignal.removeEventListener('abort', abort); }
    };
    if (pool) {
      const signature = JSON.stringify(config);
      lease = await pool.acquire(mcpRun.chatKey, signature, create, () => isEnabled() && !invocation.policyChanged());
      lease.entry.active = handlers;
      peer = lease.entry.peer;
    } else peer = (await create()).peer;
    abortPeer = () => { void peer.close(); };
    scopedSignal.addEventListener('abort', abortPeer, { once: true });
    if (scopedSignal.aborted) abortPeer();
    timings.processReadyMs = Date.now() - startedAt;
    const sessionStarted = Date.now();
    const session = await peer.call('session/new', { cwd: invocation.workspace, mcpServers: invocation.acpMcpServers });
    if (typeof session?.sessionId !== 'string' || !session.sessionId) throw new Error('Invalid ACP session');
    sessionId = session.sessionId;
    const discoveryDeadline = Date.now() + 5000;
    while (!invocation.mcpReady?.()) {
      scopedSignal.throwIfAborted();
      if (Date.now() >= discoveryDeadline) throw new Error('ACP qq_run MCP discovery failed before model invocation');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!session.modes?.availableModes?.some(mode => mode.id === 'default')) throw new Error('ACP restricted mode unavailable');
    await peer.call('session/set_mode', { sessionId, modeId: 'default' });
    if (config.model) {
      if (!session.models?.availableModels?.some(model => model.modelId === config.model)) throw new Error('Configured ACP model unavailable');
      await peer.call('session/set_model', { sessionId, modelId: config.model });
    }
    const thought = session.configOptions?.find(option => option.id === 'thought_level');
    if (!thought?.options?.some(option => option.value === config.effort)) throw new Error('ACP thinking option unavailable');
    await peer.call('session/set_config_option', { sessionId, configId: 'thought_level', value: config.effort });
    timings.sessionReadyMs = Date.now() - sessionStarted;
    const promptStarted = Date.now();
    const result = await peer.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
    timings.promptMs = Date.now() - promptStarted;
    if (scopedSignal.aborted) throw scopedSignal.reason;
    if (result?.stopReason !== 'end_turn' && !(hostFinished && result?.stopReason === 'cancelled')) throw new Error('ACP turn did not complete');
    // CLI may report end_turn even when its executor could not be constructed.
    if (/^(?:⚠\s*)?Agent execution terminated due to error\.?$/.test(response.trim())) {
      const error = new Error('Antigravity ACP execution terminated due to error');
      error.code = 'ANTIGRAVITY_ACP_EXECUTION_FAILED';
      throw error;
    }
    if (invocation.finished()) hostFinished = true;
    healthy = true;
    return completed(hostFinished ? 'HOST_FINISHED' : 'SUCCESS');
  } catch (error) {
    if (hostFinished && !signal?.aborted && isEnabled() && !invocation.policyChanged()) return completed('HOST_FINISHED');
    throw scopedSignal.aborted ? scopedSignal.reason : error;
  } finally {
    clearTimeout(timer); clearTimeout(finishTimer); clearInterval(guard);
    scopedSignal.removeEventListener('abort', abortPeer);
    controller.abort();
    await native.close();
    // End every turn's permissions without aborting a healthy pooled process.
    if (lease) await lease.release(healthy);
    else await peer?.close();
  }
  function completed(status) {
    return { message: { role: 'assistant', content: response }, finishReason: 'stop', toolsExecutedViaMcp: true,
      model: config.model || 'antigravity-default', originBaseUrl: 'antigravity-cli://local', usage: undefined,
      raw: { status, driver: 'acp', conversation_id: sessionId, mcpCalls: invocation.calls(), usageUnavailable: true, timings } };
  }
}
