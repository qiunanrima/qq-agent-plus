// Trusted PreToolUse hook: only the proposed call reaches the host, never prompt/history.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function runNativeApprovalHook() {
let input = '';
try {
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Oversize');
  }
  const proposed = JSON.parse(input).toolCall;
  if (!proposed?.name || !proposed.args) throw new Error('Invalid hook request');
  // MCP permissions are enforced by the broker, including QQ approval if enabled.
  if (proposed.name === 'call_mcp_tool' || /^(?:mcp[:_])?qq_run(?:\/|_)/.test(proposed.name)) {
    if (proposed.name === 'call_mcp_tool') {
      let server = proposed.args.ServerName || proposed.args.server_name || proposed.args.server;
      try { server = JSON.parse(server); } catch { /* plain server name */ }
      if (server !== 'qq_run') throw new Error('Unapproved MCP server');
    }
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
  } else {
    const capability = JSON.parse(fs.readFileSync(process.argv[2] || '.agents/qq-approval.json', 'utf8'));
    const approved = await new Promise(resolve => {
      const socket = net.createConnection(capability.QQ_AGENT_RUN_PIPE);
      let buffer = '', settled = false;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
      const timer = setTimeout(() => finish(false), 60000);
      const send = message => socket.write(JSON.stringify({ token: capability.QQ_AGENT_RUN_TOKEN, message }) + '\n');
      socket.on('connect', () => send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
      socket.on('error', () => finish(false));
      socket.on('close', () => finish(false));
      socket.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 65536) return finish(false);
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const response = JSON.parse(line);
            if (response.error) { finish(false); continue; }
            if (response.id === 1 && response.result) send({ jsonrpc: '2.0', id: 2, method: 'qq/native-approval', params: { name: proposed.name, arguments: proposed.args } });
            else if (response.id === 2) finish(response.result?.approved === true);
          } catch { finish(false); }
        }
      });
    });
    process.stdout.write(JSON.stringify({ decision: approved ? 'auto_approve' : 'deny', reason: approved ? 'Approved once by QQ Agent administrator' : 'Not approved for this run' }));
  }
} catch {
  process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'Approval channel unavailable' }));
}
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await runNativeApprovalHook();
