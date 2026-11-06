import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function nativeHookDecision(payload) {
  const call = payload?.toolCall;
  let args = call?.args;
  try { if (typeof args === 'string') args = JSON.parse(args); } catch { return { decision: 'deny' }; }
  if (call?.name === 'call_mcp_tool') {
    let server = args?.ServerName || args?.serverName || args?.server_name;
    try { server = JSON.parse(server); } catch { /* plain name */ }
    return { decision: server === 'qq_run' ? 'allow' : 'deny' };
  }
  if (/^(?:mcp[:_])?qq_run(?:\/|_)/.test(call?.name || '')) return { decision: 'allow' };
  if (['read_file', 'view_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'run_command'].includes(call?.name)) {
    return { decision: 'force_ask', reason: 'QQ Agent administrator must approve this operation once through ACP.' };
  }
  return { decision: 'deny', reason: 'This native tool is not enabled for QQ Agent.' };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let input = '';
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Oversize');
    }
    process.stdout.write(JSON.stringify(nativeHookDecision(JSON.parse(input))));
  } catch { process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'Invalid approval hook input' })); }
}
