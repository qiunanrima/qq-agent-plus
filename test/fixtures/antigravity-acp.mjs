// Local ACP peer: records effects only after the client selects allow_once.
import readline from 'node:readline';
const mode = process.argv[2];
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let promptId;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (!message.method) {
    if (mode === 'hang') continue;
    const allowed = message.result?.outcome?.optionId === 'once';
    send({ method: 'session/update', params: { sessionId: 'session', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'effect-confirmed' : 'effect-blocked' }
    } } });
    send({ id: promptId, result: { stopReason: 'end_turn' } });
    continue;
  }
  const { method, id } = message;
  if (method === 'initialize') send({ id, result: { protocolVersion: 1 } });
  else if (method === 'session/new') send({ id, result: { sessionId: 'session',
    modes: { availableModes: [{ id: 'default' }] },
    models: { currentModelId: 'fake-model', availableModels: [{ modelId: 'fake-model' }] },
    configOptions: [{ id: 'thought_level', options: [{ value: 'low' }] }] } });
  else if (method === 'session/prompt') {
    promptId = id;
    send({ id: 900, method: 'session/request_permission', params: { sessionId: 'session',
      toolCall: { toolCallId: 'tool-1', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'echo offline-probe' } },
      options: [{ kind: 'allow_always', optionId: 'always' }, { kind: 'allow_once', optionId: 'once' }] } });
  } else send({ id, result: {} });
}
