import readline from 'node:readline';
import { McpStdioClient } from '../../src/mcp/client.js';
const mode = process.argv[2] || 'ok';
const configOptions = [{ id: 'model', category: 'model', currentValue: 'test-model', options: [{ value: 'test-model', name: 'Test model' }, { value: 'other-model', name: '<Other>' }] }, { id: 'reasoning_effort', options: [{ value: 'low' }] }];
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let mcp, promptId;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line), { id, method, params } = message;
  if (!method) {
    if (mode === 'approval' && id === 801) {
      if (message.result?.outcome?.outcome !== 'selected' || message.result.outcome.optionId !== 'once') process.exit(11);
    } else {
      if (message.result?.outcome?.outcome !== 'cancelled') process.exit(5);
      if (mode === 'approval') {
        send({ method: 'session/update', params: { sessionId: 'codex-test', update: { sessionUpdate: 'tool_call', toolCallId: 'host-probe', kind: 'execute', status: 'pending', rawInput: { server: 'qq_run', tool: 'qq_probe', arguments: {} }, _meta: { is_mcp_tool_call: true } } } });
        send({ id: 801, method: 'session/request_permission', params: { sessionId: 'codex-test', toolCall: { toolCallId: 'host-probe', kind: 'execute' }, _meta: { is_mcp_tool_approval: true }, options: [{ optionId: 'once', kind: 'allow_once' }] } });
        continue;
      }
    }
    await mcp.callTool('qq_probe', {});
    if (mode === 'finish') { await mcp.callTool('qq_finish', { summary: 'done' }); continue; }
    send({ method: 'session/update', params: { sessionId: 'codex-test', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'native-denied-mcp-ok' } } } });
    send({ id: promptId, result: { stopReason: 'end_turn' } });
  } else if (method === 'initialize') {
    if (process.env.INITIAL_AGENT_MODE !== 'read-only') process.exit(6);
    send({ id, result: { protocolVersion: 1 } });
  } else if (method === 'session/new') {
    if (mode === 'catalog-hang') continue;
    if (mode === 'catalog' || mode.startsWith('quota')) {
      if (params.mcpServers.length) process.exit(7);
      if (mode === 'quota') send({ method: 'session/update', params: { sessionId: 'catalog', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'status' }] } } });
      send({ id, result: { sessionId: 'catalog', configOptions } });
      continue;
    }
    const server = params.mcpServers[0];
    mcp = new McpStdioClient({ id: server.name, command: server.command, args: server.args, env: Object.fromEntries(server.env.map(e => [e.name, e.value])), timeoutMs: 3000, log: { info() {}, warn() {}, error() {} } });
    await mcp.start();
    send({ id, result: { sessionId: 'codex-test', modes: { availableModes: [{ id: 'read-only' }] }, configOptions } });
  } else if (method === 'session/set_model') {
    process.exit(10); // Base IDs must use the model config option, not legacy model[effort].
  } else if (method === 'session/set_config_option') {
    if (params.configId === 'model' && params.value !== 'test-model') process.exit(8);
    send({ id, result: { configOptions } });
  } else if (method === 'session/prompt') {
    if (mode.startsWith('quota')) {
      if (mode !== 'quota' || params.prompt[0].text !== '/status') process.exit(12);
      send({ method: 'session/update', params: { sessionId: 'catalog', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '**Account:** ChatGPT pro (private@example.com)\n**5h limit:** 73% left (resets 18:30)\n**Weekly limit:** 49% left (resets 12:00 on Nov 17)\n**Credits:** 0' } } } });
      send({ id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (mode.startsWith('catalog')) process.exit(9);
    promptId = id;
    if (mode === 'finish-draft') {
      await mcp.callTool('qq_finish', { summary: '未向我提问，保持旁听。' });
      send({ method: 'session/update', params: { sessionId: 'codex-test', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '我先看一下当前对话状态' } } } });
      send({ id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (mode === 'hang') continue;
    if (mode === 'empty') { send({ id, result: { stopReason: 'end_turn' } }); continue; }
    send({ id: 800, method: 'session/request_permission', params: { sessionId: 'codex-test', options: [{ optionId: 'once', kind: 'allow_once' }], toolCall: { kind: 'execute', rawInput: { command: 'forbidden' } } } });
  } else send({ id, result: {} });
}
await mcp?.stop();
