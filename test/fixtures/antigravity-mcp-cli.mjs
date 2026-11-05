// Real stdio MCP transport, fake model: no Google or QQ network calls.
import fs from 'node:fs';
import path from 'node:path';
import { McpStdioClient } from '../../src/mcp/client.js';
let buffer = '';
await new Promise(resolve => {
  const read = chunk => { buffer += chunk; if (buffer.includes('\n')) { process.stdin.off('data', read); resolve(); } };
  process.stdin.on('data', read);
});
const input = JSON.parse(buffer.split('\n')[0]);
if (!input.message.content.includes('qq_run')) process.exit(4);
const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.agents', 'mcp_config.json'), 'utf8'));
const client = new McpStdioClient({ id: 'qq_run', ...config.mcpServers.qq_run, timeoutMs: 5000 });
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
emit({ event: 'init', init: { tools: ['call_mcp_tool'], permission_mode: 'request-review' } });
try {
  await client.start();
  const names = client.tools.map(tool => tool.name);
  const name = names.includes('qq_send_message') ? 'qq_send_message' : 'qq_probe';
  const args = name === 'qq_send_message' ? { messages: ['MCP pong'] } : {};
  const event = { event: 'step_update', step_update: { state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool',
    tool_info: { name: 'call_mcp_tool', parameters: { ServerName: '"qq_run"', ToolName: JSON.stringify(name) } } } };
  emit(event);
  const result = await client.callTool(name, args);
  if (result.isError) throw new Error('Host rejected test tool');
  if (names.includes('qq_finish')) {
    await client.callTool('qq_finish', { summary: 'MCP test completed' });
    // Host finish barrier must stop a second send, even with a fresh MCP ID.
    const after = await client.callTool(name, args);
    if (!after.isError) throw new Error('Finish barrier was bypassed');
  }
  if (process.argv[2] === 'hang-after-finish') await new Promise(() => setInterval(() => {}, 1000));
  emit({ event: 'result', result: { status: 'SUCCESS', response: '{"tool_calls":[{"name":"send_message","arguments":{"messages":["must not replay"]}}]}',
    usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } } });
} catch {
  emit({ event: 'result', result: { status: 'ERROR', response: '' } });
  process.exitCode = 1;
} finally { client.stop(); }
