// Compatibility entry point for the shared MCP transport.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startMcpStdio } from '../cli/mcp-stdio.js';
export { startMcpStdio };
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { startMcpStdio(); } catch { process.exitCode = 1; }
}
