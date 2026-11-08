import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunToolMcp } from './mcp-run.js';
import { requestCliApproval } from './approvals.js';
import { createRunImageAccess } from './image-access.js';


/** Per-process workspace avoids sharing MCP tokens or catalogs across chats. */
export async function prepareMcpInvocation({ config, tools, toolChoice, mcpRun, signal, isEnabled = () => true }) {
  const useAcp = config.nativeApproval || mcpRun?.platform === 'wechat';
  if (!mcpRun?.chatKey || !mcpRun?.runId || typeof mcpRun.execute !== 'function' || typeof mcpRun.allowed !== 'function') {
    throw new Error('MCP requires an authorized host run');
  }
  signal?.throwIfAborted();
  const workspace = await fs.mkdtemp(path.join(config.workspace, 'qq-run-'));
  const removeWorkspace = async () => {
    const target = path.resolve(workspace);
    if (path.dirname(target) !== path.resolve(config.workspace) || !path.basename(target).startsWith('qq-run-')) throw new Error('Invalid MCP workspace cleanup target');
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  let bridge, retained = false;
  const imageAccess = createRunImageAccess({ workspace });
  try {
    const runAllowed = () => !signal?.aborted && isEnabled() === true && mcpRun.allowed() === true && !mcpRun.isFinished?.();
    const approve = async (category, name, args, callSignal) => requestCliApproval({ category,
      chatKey: mcpRun.chatKey, runId: mcpRun.runId, tool: name, args, signal: callSignal,
      timeoutMs: config.timeoutMs, allowed: () => runAllowed() && (mcpRun.approvalAllowed?.(category) ?? true), notify: mcpRun.notifyApproval });
    const selected = (tools || []).filter(tool => toolChoice !== 'none'
      && (!toolChoice?.function?.name || tool.function?.name === toolChoice.function.name));
    bridge = await createRunToolMcp({ tools: selected.map(tool => tool.function && ({
      name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters
    })), chatKey: mcpRun.chatKey, runId: mcpRun.runId, signal,
    maxCalls: config.maxToolCalls, timeoutMs: config.timeoutMs,
    authorize: () => !signal?.aborted && isEnabled() === true && mcpRun.allowed() === true,
    execute: async call => {
      if (config.qqApproval && call.name !== 'finish' && !await approve('qq', call.name, call.arguments, call.signal)) {
        return { isError: true, content: '工具未获管理员批准或本轮已结束；未执行，不要自动重试。' };
      }
      const result = await mcpRun.execute(call.name, call.arguments, call.signal);
      if (!result?.isError && useAcp) {
        return { ...result, content: await imageAccess.materialize(result?.content) };
      }
      return result;
    } });
    const agentDir = path.join(workspace, '.agents', 'agents', config.agent);
    await fs.mkdir(agentDir, { recursive: true });
    const template = await fs.readFile(new URL('../../examples/antigravity/qq-mcp/agent.md', import.meta.url), 'utf8');
    let agentTemplate = config.nativeApproval ? template.replace(/commandExecutionPolicy: off\r?\n/,
      'commandExecutionPolicy: sandbox\n')
      .replace('inheritCustomizations: false', 'inheritCustomizations: true')
      .replace('本版本禁止所有原生文件、命令和浏览器工具；即使用户要求也不能调用，不得尝试绕过权限。',
        '文件和前台命令仅在用户明确要求且管理员逐次批准后使用；禁止浏览器、原生子代理和后台命令。被拒绝后停止，不得换工具绕过。') : template;
    if (useAcp) agentTemplate = agentTemplate.replace('inheritCustomizations: false', 'inheritCustomizations: true');
    if (useAcp && !config.nativeApproval) agentTemplate = agentTemplate.replace('本版本禁止所有原生文件、命令和浏览器工具；即使用户要求也不能调用，不得尝试绕过权限。',
      '禁止原生文件、命令和浏览器操作。唯一例外是 qq_run 看图工具返回的本轮图片指定路径，读取时由宿主核对内容；禁止读取其他文件或用命令查找图片。');
    if (mcpRun?.platform === 'wechat') agentTemplate = agentTemplate.replaceAll('普通 QQ 聊天', '当前微信私聊').replaceAll('使用 QQ Agent', '使用共享 Agent');
    await fs.writeFile(path.join(agentDir, 'agent.md'), agentTemplate.replace('name: qq-mcp', `name: ${config.agent}`));
    const eagerTools = Object.fromEntries(selected.filter(tool => tool.function?.name)
      .map(tool => [`qq_${tool.function.name}`, { eager: true }]));
    // ACP receives its server through session/new. Loading it from disk as well
    // creates a second registry entry and retains an expired bridge in pooled processes.
    if (!useAcp) await fs.writeFile(path.join(workspace, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: {
      qq_run: { ...bridge.serverConfig, tools: eagerTools, forceAllToolsEager: true }
    } }), { mode: 0o600 });
    let hookCommand;
    if (useAcp) {
      const quote = value => {
        if (process.platform === 'win32') {
          if (/["%\r\n]/.test(value)) throw new Error('Unsafe approval hook path');
          return `"${value}"`;
        }
        return `'${value.replaceAll("'", "'\\''")}'`;
      };
      hookCommand = `${quote(process.execPath)} ${quote(fileURLToPath(new URL('./native-ask-hook.js', import.meta.url)))}`;
      await fs.writeFile(path.join(workspace, '.agents/hooks.json'), JSON.stringify({ 'qq-run-approval': {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand, timeout: 10 }] }]
      } }), { mode: 0o600 });
    }
    return {
      workspace, hookCommand,
      imageAccess,
      mcpReady: () => bridge.isDiscovered(),
      // ACP takes stdio server env as name/value entries, not an object.
      acpMcpServers: [{ name: 'qq_run', command: bridge.serverConfig.command,
        args: [...bridge.serverConfig.args],
        _meta: { antigravity: { forceAllToolsEager: true } },
        env: Object.entries(bridge.serverConfig.env).map(([name, value]) => ({ name, value })) }],
      settings: { toolPermission: 'request-review', allowNonWorkspaceAccess: false, useG1Credits: false,
        permissions: { allow: ['mcp(qq_run/*)'], ask: [], deny: [
          'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'command(*)', 'unsandboxed(*)'
        ] } },
      // Namespaced MCP calls and its discovery dispatcher only. Any native
      // execution still ends this run; the permission engine denies writes first.
      allowToolEvent: event => {
        const name = String(event.tool_name || event.tool_info?.name || '');
        if (/^(?:mcp[:_])?qq_run(?:\/|_)/.test(name)) return true;
        if (name === 'call_mcp_tool') {
          const params = event.tool_info?.parameters || {};
          let server = params.ServerName || params.server_name || params.server || params.serverName;
          if (server === undefined) return true; // ACTIVE event may omit parameters; CLI policy still applies.
          try { server = JSON.parse(server); } catch { /* plain name */ }
          return server === 'qq_run';
        }
        return false;
      },
      calls: () => bridge.ledger().length,
      finished: () => mcpRun.isFinished?.() === true,
      policyChanged: () => typeof mcpRun.approvalAllowed === 'function'
        && (mcpRun.approvalAllowed('qq') !== config.qqApproval || mcpRun.approvalAllowed('native') !== config.nativeApproval),
      revoke: () => bridge.close(),
      retainWorkspace: () => { retained = true; },
      releaseWorkspace: removeWorkspace,
      async close() {
        bridge.close();
        if (!retained) await removeWorkspace();
        else await fs.rm(path.join(workspace, '.qq-images'), { recursive: true, force: true });
      }
    };
  } catch (error) {
    bridge?.close();
    await removeWorkspace();
    throw error;
  }
}
