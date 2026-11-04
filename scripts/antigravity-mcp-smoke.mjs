// Explicit --live opts into one real CLI invocation. Otherwise local MCP only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { antigravityCompletion } from '../src/antigravity-cli/index.js';
import { createQqRunToolMcp } from '../src/antigravity-cli/mcp-run.js';
import { McpStdioClient } from '../src/mcp/client.js';

function exePath() { return process.env.AGY_EXE || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe') : 'agy'); }

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mcp-smoke-'));
process.env.QQ_AGENT_DATA_DIR = path.join(workspace, 'test-data');
let calls = 0;
const bridge = await createQqRunToolMcp({
  toolDefs: [{ name: 'probe', description: 'Harmless offline probe returning pong. No QQ connection.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async ctx => {
      if (ctx.chatKey !== 'test:offline') throw new Error('Scope mismatch');
      calls += 1; return { content: 'pong', isError: false };
    } }],
  ctx: { chatKey: 'test:offline', session: { id: 'mcp-smoke' } },
  authorize: () => calls === 0, maxCalls: 1, timeoutMs: 120000
});
try {
  if (!process.argv.includes('--live')) {
    const client = new McpStdioClient({ id: 'qq_run', ...bridge.serverConfig });
    try { await client.start(); const result = await client.callTool('qq_probe', {}); console.log(JSON.stringify({ ok: calls === 1, result, ledger: bridge.ledger() })); }
    finally { client.stop(); }
  } else {
    // Exercise the actual production adapter, not a separate CLI command path.
    const { executeTool } = await import('../src/tools/tools.js');
    const toolDefs = [{ name: 'probe', description: 'Harmless probe returning pong; no QQ connection.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => { calls += 1; return { content: 'pong', isError: false }; }
    }];
    const result = await antigravityCompletion({
      config: { enabled: true, workspace, transport: 'mcp', agent: 'qq-mcp', executable: exePath(), effort: 'low', timeoutMs: 90000, maxToolCalls: 1 },
      messages: [{ role: 'user', content: 'Call qq_run MCP tool qq_probe exactly once with {}. Reply with its result. Do not use native tools.' }],
      tools: toolDefs.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } })),
      toolChoice: 'required',
      mcpRun: { chatKey: 'test:offline', runId: 'mcp-smoke', allowed: () => calls === 0,
        execute: (name, args, signal) => executeTool(toolDefs, { chatKey: 'test:offline', session: { id: 'mcp-smoke' }, signal }, name, JSON.stringify(args))
      }
    });
    const outcome = { status: 'SUCCESS', response: result.message.content };
    const ok = outcome.status === 'SUCCESS' && calls === 1;
    console.log(JSON.stringify({ ok, ...outcome, calls }));
    if (!ok) process.exitCode = 1;
  }
} finally { bridge.close(); }
