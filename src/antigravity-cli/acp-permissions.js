import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { requestCliApproval } from './approvals.js';

const nativeNames = new Set(['read_file', 'view_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'run_command']);
const decode = value => { try { return JSON.parse(value); } catch { return value; } };
const inside = (target, root) => { const relative = path.relative(root, target); return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };

export function describeAcpPermission(toolCall) {
  let args = toolCall?.rawInput;
  if (typeof args === 'string') args = decode(args);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const name = toolCall.name || toolCall._meta?.toolName;
  if (name === 'call_mcp_tool') {
    const server = decode(args.ServerName || args.serverName || args.server_name);
    return server === 'qq_run' ? { category: 'mcp', tool: name, args } : null;
  }
  if (/^(?:mcp[:_])?qq_run(?:\/|_)/.test(name || '')) return { category: 'mcp', tool: name, args };
  const inferred = toolCall.kind === 'execute' && Object.hasOwn(args, 'CommandLine') ? 'run_command'
    : toolCall.kind === 'read' && Object.hasOwn(args, 'Path') ? 'read_file'
      : toolCall.kind === 'read' && Object.hasOwn(args, 'AbsolutePath') ? 'view_file'
      : toolCall.kind === 'edit' && Object.hasOwn(args, 'TargetFile')
        ? Object.hasOwn(args, 'CodeContent') ? 'write_to_file'
          : Object.hasOwn(args, 'ReplacementChunks') ? 'multi_replace_file_content'
            : Object.hasOwn(args, 'ReplacementContent') ? 'replace_file_content' : null : null;
  const tool = nativeNames.has(name) ? name : !name ? inferred : null;
  return tool ? { category: 'native', tool, args } : null;
}

export function createAcpPermissionHandler({ sessionId, mcpRun, workspace, controlRoot, signal, isEnabled, maxCalls, imageAccess }) {
  let calls = 0;
  const decisions = new Set();
  const allowed = () => !signal.aborted && isEnabled() && mcpRun.allowed() && !mcpRun.isFinished?.()
    && (mcpRun.approvalAllowed?.('native') ?? true);
  return async params => {
    const cancelled = { outcome: { outcome: 'cancelled' } };
    if (!sessionId() || params?.sessionId !== sessionId() || !allowed()) return cancelled;
    const description = describeAcpPermission(params.toolCall);
    const option = params.options?.find(item => item.kind === 'allow_once');
    if (!description || !option?.optionId) return cancelled;
    if (description.category === 'mcp') return { outcome: { outcome: 'selected', optionId: option.optionId } };
    const id = params.toolCall?.toolCallId;
    if (typeof id !== 'string' || !id) return cancelled;
    if (decisions.has(id)) return cancelled;
    if (calls++ >= maxCalls) return cancelled;
    decisions.add(id);
    const promise = (async () => {
      // CLI 1.4 uses read_file/Path; retain view_file/AbsolutePath compatibility.
      // This exact, content-bound read is part of the already authorized MCP tool.
      const field = description.tool === 'read_file' ? 'Path' : description.tool === 'view_file' ? 'AbsolutePath' : 'TargetFile';
      const isRead = ['read_file', 'view_file'].includes(description.tool);
      if (isRead && await imageAccess?.allows(decode(description.args[field]), sessionId()) && allowed())
        return { outcome: { outcome: 'selected', optionId: option.optionId } };
      if (description.tool !== 'run_command' && !Object.hasOwn(description.args, field)) return cancelled;
      if (description.tool === 'run_command' && (typeof decode(description.args.CommandLine) !== 'string' || !decode(description.args.CommandLine).trim())) return cancelled;
      for (const key of ['Path', 'AbsolutePath', 'TargetFile']) {
        if (!Object.hasOwn(description.args, key)) continue;
        const file = decode(description.args[key]);
        if (typeof file !== 'string' || !path.isAbsolute(file)) return cancelled;
        let target = path.resolve(file);
        try { target = await fs.realpath(target); }
        catch { try { target = path.join(await fs.realpath(path.dirname(target)), path.basename(target)); } catch { return cancelled; } }
        if ((controlRoot && inside(target, controlRoot) && path.relative(controlRoot, target).split(path.sep).includes('.agents'))
          || inside(target, path.join(workspace, '.agents')) || inside(target, path.join(os.homedir(), '.ssh'))
          || inside(target, path.join(os.homedir(), '.gemini'))) return cancelled;
      }
      if (decode(description.args.RunPersistent) === true || decode(description.args.IsDaemon) === true || description.args.RequestedTerminalID) return cancelled;
      const approved = await requestCliApproval({ ...description, chatKey: mcpRun.chatKey, runId: mcpRun.runId,
        signal, allowed, notify: mcpRun.notifyApproval });
      return approved && allowed() ? { outcome: { outcome: 'selected', optionId: option.optionId } } : cancelled;
    })();
    return promise;
  };
}
