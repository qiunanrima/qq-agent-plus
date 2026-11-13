import readline from 'node:readline';
import { McpStdioClient } from '../../src/mcp/client.js';
const mode = process.argv[2] || 'ok';
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let mcp, promptId;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line), { id, method, params } = message;
  if (!method) {
    if (message.result?.outcome?.outcome !== 'cancelled') process.exit(5);
    await mcp.callTool('qq_probe', {});
    if (mode === 'finish') { await mcp.callTool('qq_finish', { summary: 'done' }); continue; }
    send({ method: 'session/update', params: { sessionId: 'codex-test', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'native-denied-mcp-ok' } } } });
    send({ id: promptId, result: { stopReason: 'end_turn' } });
  } else if (method === 'initialize') {
    if (process.env.INITIAL_AGENT_MODE !== 'read-only') process.exit(6);
    send({ id, result: { protocolVersion: 1 } });
  } else if (method === 'session/new') {
    const server = params.mcpServers[0];
    mcp = new McpStdioClient({ id: server.name, command: server.command, args: server.args, env: Object.fromEntries(server.env.map(e => [e.name, e.value])), timeoutMs: 3000, log: { info() {}, warn() {}, error() {} } });
    await mcp.start();
    send({ id, result: { sessionId: 'codex-test', modes: { availableModes: [{ id: 'read-only' }] }, configOptions: [{ id: 'reasoning_effort', options: [{ value: 'low' }] }] } });
  } else if (method === 'session/prompt') {
    promptId = id;
    if (mode === 'hang') continue;
    if (mode === 'empty') { send({ id, result: { stopReason: 'end_turn' } }); continue; }
    send({ id: 800, method: 'session/request_permission', params: { sessionId: 'codex-test', options: [{ optionId: 'once', kind: 'allow_once' }], toolCall: { kind: 'execute', rawInput: { command: 'forbidden' } } } });
  } else send({ id, result: {} });
}
await mcp?.stop();
