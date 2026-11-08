// Local ACP peer: records effects only after the client selects allow_once.
import readline from 'node:readline';
import { McpStdioClient } from '../../src/mcp/client.js';
const mode = process.argv[2];
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let promptId, mcp, sessionId = 'session', sessionCount = 0;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (!message.method) {
    if (mode === 'hang') continue;
    const allowed = message.result?.outcome?.optionId === 'once';
    if ((allowed || mode === 'mcp-only') && mcp) {
      const result = await mcp.callTool('qq_probe', {});
      if (result.isError || result.content?.[0]?.text !== 'host-probe-ok') process.exit(4);
    }
    if (mode === 'pool-cancel') continue;
    send({ method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: mode === 'mcp-only' ? 'native-denied-mcp-ok' : allowed ? 'effect-confirmed' : 'effect-blocked' }
    } } });
    send({ id: promptId, result: { stopReason: 'end_turn' } });
    continue;
  }
  const { method, id } = message;
  if (method === 'initialize') send({ id, result: { protocolVersion: 1 } });
  else if (method === 'session/new') {
    if (mode === 'pool-probe' || mode === 'pool-cancel') sessionId = `session-${++sessionCount}`;
    const server = message.params?.mcpServers?.[0];
    if (message.params?.mcpServers?.length !== 1 || server?.name !== 'qq_run' || !server.command || !Array.isArray(server.env)) process.exit(3);
    if (['mcp-probe', 'pool-probe', 'pool-cancel', 'mcp-only'].includes(mode)) {
      mcp = new McpStdioClient({ id: server.name, command: server.command, args: server.args,
        env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])), timeoutMs: 3000,
        log: { info() {}, warn() {}, error() {} } });
      await mcp.start();
      if (!mcp.tools.some(tool => tool.name === 'qq_probe')) process.exit(5);
    }
    send({ id, result: { sessionId,
    modes: { availableModes: [{ id: 'default' }] },
    models: { currentModelId: 'fake-model', availableModels: [{ modelId: 'fake-model' }] },
    configOptions: [{ id: 'thought_level', options: [{ value: 'low' }] }] } });
  }
  else if (method === 'session/cancel') send({ id: promptId, result: { stopReason: 'cancelled' } });
  else if (method === 'session/prompt') {
    promptId = id;
    if (mode === 'executor-error') {
      send({ method: 'session/update', params: { sessionId: 'session', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ Agent execution terminated due to error.' }
      } } });
      send({ id, result: { stopReason: 'end_turn' } });
      continue;
    }
    send({ id: 900, method: 'session/request_permission', params: { sessionId,
      toolCall: mode === 'mcp-only' ? { toolCallId: 'tool-1', name: 'read_file', kind: 'read', rawInput: { Path: '/not-authorized' } }
        : { toolCallId: 'tool-1', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'echo offline-probe' } },
      options: [{ kind: 'allow_always', optionId: 'always' }, { kind: 'allow_once', optionId: 'once' },
        ...(mode === 'mcp-only' ? [{ kind: 'reject_once', optionId: 'deny' }] : [])] } });
  } else send({ id, result: {} });
}
