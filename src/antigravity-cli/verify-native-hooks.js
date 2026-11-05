import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

/** Inheriting hooks also inherits customizations. Refuse personal rules/plugins
 * instead of silently importing them into a QQ conversation. No files are changed. */
export async function verifyNativeHooks(config, invocation, { run = runFile, home = os.homedir() } = {}) {
  const dirs = ['.gemini/config/rules', '.gemini/config/skills', '.gemini/config/agents', '.gemini/config/plugins', '.gemini/antigravity-cli/plugins'];
  const files = ['.gemini/config/AGENTS.md', '.gemini/config/GEMINI.md', '.gemini/AGENTS.md', '.gemini/GEMINI.md'];
  for (const file of files) {
    try { await fs.stat(path.join(home, file)); throw new Error('Native approval requires isolated CLI customizations'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const dir of dirs) {
    try { if ((await fs.readdir(path.join(home, dir))).length) throw new Error('Native approval requires isolated CLI customizations'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const options = { cwd: invocation.workspace, shell: false, windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024 };
  const version = (await run(config.executable, ['--version'], options)).stdout.trim();
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parts || Number(parts[1]) !== 1 || Number(parts[2]) < 4 || (Number(parts[2]) === 4 && Number(parts[3]) < 12)) throw new Error('Native approval requires supported CLI >= 1.4.12');
  const { stdout } = await run(config.executable, ['-p', '/hooks', '--agent', config.agent, '--output-format', 'json',
    '--settings', JSON.stringify({ ...invocation.settings, disableSlashCommands: false })],
  options);
  const result = JSON.parse(stdout);
  const hooks = result.command?.data?.hooks;
  if (result.status !== 'SUCCESS' || result.num_turns !== 0 || result.command?.name !== 'hooks' || !Array.isArray(hooks)) throw new Error('Cannot verify native approval hooks');
  const enabled = hooks.filter(hook => hook.enabled !== false);
  const expectedSource = path.resolve(invocation.workspace, '.agents/hooks.json');
  if (enabled.length !== 1 || enabled[0].name !== 'qq-run-approval' || path.resolve(enabled[0].source || '') !== expectedSource
    || enabled[0].actions?.length !== 1 || enabled[0].actions[0].event !== 'PreToolUse'
    || enabled[0].actions[0].matcher !== '*' || enabled[0].actions[0].command !== invocation.hookCommand) {
    throw new Error('Unexpected inherited hooks; native approval refused');
  }
}
