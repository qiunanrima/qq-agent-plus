/** Permit one adapter approval only for a live, correlated host MCP call.
 * The MCP broker remains authoritative for arguments, run gates and execution.
 */
export function createCodexPermissionPolicy({ tools, sessionId, allowed }) {
  const catalog = new Set(tools.map(name => 'qq_' + name));
  const pending = new Set();
  const counts = { hostAllowed: 0, denied: 0 };
  const live = () => { try { return allowed() === true; } catch { return false; } };
  return {
    update(params) {
      if (params.sessionId !== sessionId()) return;
      const call = params.update;
      if (!call || !['tool_call', 'tool_call_update'].includes(call.sessionUpdate)) return;
      if (['completed', 'failed'].includes(call.status)) { pending.delete(call.toolCallId); return; }
      if (call.sessionUpdate !== 'tool_call' || call._meta?.is_mcp_tool_call !== true || !live()) return;
      if (typeof call.toolCallId !== 'string' || pending.size >= 128) return;
      if (call.rawInput?.server === 'qq_run' && catalog.has(call.rawInput.tool)) pending.add(call.toolCallId);
    },
    request(params) {
      const id = params?.toolCall?.toolCallId;
      const correlated = params?.sessionId === sessionId() && pending.delete(id);
      const once = params?.options?.find(option => option.kind === 'allow_once' && typeof option.optionId === 'string');
      if (correlated && live() && params._meta?.is_mcp_tool_approval === true && once) {
        counts.hostAllowed++;
        return { outcome: { outcome: 'selected', optionId: once.optionId } };
      }
      counts.denied++;
      return { outcome: { outcome: 'cancelled' } };
    },
    stats: () => ({ ...counts })
  };
}
