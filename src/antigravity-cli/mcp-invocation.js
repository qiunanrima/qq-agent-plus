import fs from 'node:fs/promises';
import path from 'node:path';
import { createRunToolMcp } from './mcp-run.js';

/** Per-process workspace avoids sharing MCP tokens or catalogs across chats. */
export async function prepareMcpInvocation({ config, tools, toolChoice, mcpRun, signal, isEnabled = () => true }) {
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
  let bridge;
  try {
    const selected = (tools || []).filter(tool => toolChoice !== 'none'
      && (!toolChoice?.function?.name || tool.function?.name === toolChoice.function.name));
    bridge = await createRunToolMcp({ tools: selected.map(tool => tool.function && ({
      name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters
    })), chatKey: mcpRun.chatKey, runId: mcpRun.runId, signal,
    maxCalls: config.maxToolCalls, timeoutMs: config.timeoutMs,
    authorize: () => !signal?.aborted && isEnabled() === true && mcpRun.allowed() === true,
    execute: async call => {
      const result = await mcpRun.execute(call.name, call.arguments, call.signal);
      return result;
    } });
    const agentDir = path.join(workspace, '.agents', 'agents', config.agent);
    await fs.mkdir(agentDir, { recursive: true });
    const template = await fs.readFile(new URL('../../examples/antigravity/qq-mcp/agent.md', import.meta.url), 'utf8');
    await fs.writeFile(path.join(agentDir, 'agent.md'), template.replace('name: qq-mcp', `name: ${config.agent}`));
    await fs.writeFile(path.join(workspace, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: { qq_run: bridge.serverConfig } }), { mode: 0o600 });
    return {
      workspace,
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
      revoke: () => bridge.close(),
      async close() {
        bridge.close();
        await removeWorkspace();
      }
    };
  } catch (error) {
    bridge?.close();
    await removeWorkspace();
    throw error;
  }
}
