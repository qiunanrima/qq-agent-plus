import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = (executable, args, options) => {
  const pending = promisify(execFile)(executable, args, options);
  pending.child.stdin.end();
  return pending.catch(() => { throw new Error('CLI metadata check failed; verify CLI login manually'); });
};

/** Metadata-only check; never changes credentials, personal permissions or settings. */
export async function verifyNativeHooks(config, invocation, { run = runFile, home = os.homedir(), signal } = {}) {
  for (const file of ['.gemini/config/AGENTS.md', '.gemini/config/GEMINI.md', '.gemini/AGENTS.md', '.gemini/GEMINI.md']) {
    try { await fs.stat(path.join(home, file)); throw new Error('Native approval requires isolated CLI customizations'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const dir of ['.gemini/config/rules', '.gemini/config/skills', '.gemini/config/agents', '.gemini/config/plugins', '.gemini/antigravity-cli/plugins']) {
    try { if ((await fs.readdir(path.join(home, dir))).length) throw new Error('Native approval requires isolated CLI customizations'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (let ancestor = path.dirname(invocation.workspace);;) {
    for (const name of ['AGENTS.md', 'GEMINI.md', '.agents/rules', '.agents/skills', '.agents/agents', '.agents/plugins']) {
      try {
        await fs.stat(path.join(ancestor, name));
        throw new Error('Native approval requires a standalone workspace without inherited customizations');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  try {
    const text = await fs.readFile(path.join(home, '.gemini/config/mcp_config.json'), 'utf8');
    if (text.trim()) {
      const servers = JSON.parse(text).mcpServers || {};
      if (Object.values(servers).some(server => server?.disabled !== true)) throw new Error('Native approval requires no additional global MCP servers');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // ACP has no --settings flag. Refuse paid-credit opt-in rather than inheriting it.
  for (const file of ['.gemini/config/config.json', '.gemini/antigravity-cli/settings.json']) {
    try {
      const settings = JSON.parse(await fs.readFile(path.join(home, file), 'utf8'));
      if (settings.useG1Credits === true || settings.userSettings?.useG1Credits === true) throw new Error('Disable CLI AI credit spending before enabling native approval');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const options = { cwd: invocation.workspace, shell: false, windowsHide: true, signal, timeout: 15000, maxBuffer: 256 * 1024 };
  const version = (await run(config.executable, ['--version'], options)).stdout.trim();
  if (!/^1\.(?:[5-9]|[1-9]\d+)\.\d+$/.test(version) && !/^1\.4\.(?:1[2-9]|[2-9]\d|\d{3,})$/.test(version)) throw new Error('Native approval requires CLI >= 1.4.12 (major 1)');
  const { stdout } = await run(config.executable, ['-p', '/hooks', '--agent', config.agent, '--output-format', 'json'], options);
  const result = JSON.parse(stdout);
  if (result.status !== 'SUCCESS' || result.num_turns !== 0 || result.command?.name !== 'hooks' || !Array.isArray(result.command?.data?.hooks)) throw new Error('Cannot verify native approval hooks');
  const enabled = result.command.data.hooks.filter(hook => hook.enabled !== false);
  const hook = enabled[0];
  if (enabled.length !== 1 || hook.name !== 'qq-run-approval' || path.resolve(hook.source || '') !== path.resolve(invocation.workspace, '.agents/hooks.json')
    || hook.actions?.length !== 1 || hook.actions[0].event !== 'PreToolUse' || hook.actions[0].matcher !== '*'
    || hook.actions[0].command !== invocation.hookCommand) throw new Error('Unexpected inherited hooks; native approval refused');
}
