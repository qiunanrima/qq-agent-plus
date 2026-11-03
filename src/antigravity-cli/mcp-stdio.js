// MCP stdio facade. The host retains all context, authorization and side effects.
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function startMcpStdio({ endpoint = process.env.QQ_AGENT_RUN_PIPE, token = process.env.QQ_AGENT_RUN_TOKEN,
  input = process.stdin, output = process.stdout } = {}) {
  if (!endpoint || !token) throw new Error('Missing run capability');
  const socket = net.createConnection(endpoint);
  let buffer = '';
  socket.on('error', () => { process.exitCode = 1; input.destroy(); });
  socket.on('close', () => input.destroy());
  socket.on('data', chunk => output.write(chunk));
  input.setEncoding('utf8');
  input.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) { socket.destroy(); input.destroy(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try { socket.write(JSON.stringify({ token, message: JSON.parse(line) }) + '\n'); }
      catch { socket.destroy(); input.destroy(); return; }
    }
  });
  input.on('end', () => socket.end());
  input.on('error', () => socket.destroy());
  return { close: () => socket.destroy() };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { startMcpStdio(); } catch { process.exitCode = 1; }
}
