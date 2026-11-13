import fs from 'node:fs/promises';
import path from 'node:path';

// Dedicated CODEX_HOME: the service user logs in here explicitly. Never copy credentials.
export async function verifyCodexWorkspace(workspace) {
  if (!path.isAbsolute(workspace)) throw new Error('Codex requires an absolute workspace');
  const home = path.join(workspace, 'codex-home');
  await fs.access(home);
  for (const file of ['config.toml', 'AGENTS.md']) {
    try { await fs.access(path.join(home, file)); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    throw new Error('Codex dedicated home must not contain config.toml or AGENTS.md');
  }
  for (let dir = path.resolve(workspace); ; dir = path.dirname(dir)) {
    try { await fs.access(path.join(dir, '.codex', 'config.toml')); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (path.dirname(dir) === dir) break;
      continue;
    }
    throw new Error('Codex workspace must be outside project configuration trees');
  }
  return home;
}

export function codexEnvironment(home, effort) {
  const env = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || ''), CODEX_HOME: home, INITIAL_AGENT_MODE: 'read-only', NO_BROWSER: '1',
    CODEX_CONFIG: JSON.stringify({ model_reasoning_effort: effort, web_search: 'disabled',
      features: { shell_tool: false, apply_patch_freeform: false, multi_agent: false, apps: false },
      hooks: {}, apps: { _default: { enabled: false } }, project_doc_max_bytes: 0 }) };
  for (const key of ['CODEX_PATH', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'DEFAULT_AUTH_REQUEST', 'MODEL_PROVIDER', 'APP_SERVER_LOGS']) delete env[key];
  return env;
}
