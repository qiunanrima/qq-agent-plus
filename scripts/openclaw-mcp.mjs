import path from 'node:path';
import { readOpenClawMcp } from '../src/plugins/openclaw-mcp.js';

const [pluginDirectory, serverName, ...extra] = process.argv.slice(2);
try {
  if (!pluginDirectory || !serverName || extra.length) {
    throw new Error('用法：node scripts/openclaw-mcp.mjs <插件目录> <MCP 服务名>');
  }
  console.log(JSON.stringify(readOpenClawMcp(path.resolve(pluginDirectory), serverName), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
