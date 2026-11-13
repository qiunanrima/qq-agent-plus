import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexPermissionPolicy } from '../src/codex-cli/permissions.js';

test('host approvals require live session, scoped tool, matching MCP event and single-use allow_once', () => {
  let active = true;
  const policy = createCodexPermissionPolicy({ tools: ['send_message'], sessionId: () => 'current', allowed: () => active });
  const event = { sessionId: 'current', update: { sessionUpdate: 'tool_call', toolCallId: 'call', kind: 'execute', status: 'pending', _meta: { is_mcp_tool_call: true }, rawInput: { server: 'qq_run', tool: 'qq_send_message' } } };
  const request = { sessionId: 'current', toolCall: { toolCallId: 'call', kind: 'execute' }, _meta: { is_mcp_tool_approval: true }, options: [{ optionId: 'always', kind: 'allow_always' }, { optionId: 'once', kind: 'allow_once' }] };
  const denied = value => assert.equal(value.outcome.outcome, 'cancelled');
  denied(policy.request(request)); // No corresponding tool event.
  for (const rawInput of [{ server: 'other', tool: 'qq_send_message' }, { server: 'qq_run', tool: 'qq_not_authorized' }, { command: 'sh' }]) {
    policy.update({ ...event, update: { ...event.update, rawInput } }); denied(policy.request(request));
  }
  policy.update(event); denied(policy.request({ ...request, sessionId: 'old' }));
  assert.deepEqual(policy.request(request), { outcome: { outcome: 'selected', optionId: 'once' } });
  denied(policy.request(request)); // Never remember or reuse an approval.
  policy.update(event); active = false; denied(policy.request(request)); active = true;
  policy.update(event); denied(policy.request({ ...request, _meta: {} }));
  policy.update(event); denied(policy.request({ ...request, options: [{ optionId: 'always', kind: 'allow_always' }] }));
  policy.update(event); policy.update({ sessionId: 'current', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call', status: 'completed' } }); denied(policy.request(request));
});
