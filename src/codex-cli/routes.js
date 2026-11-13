import fs from 'node:fs/promises';
import { normalizeCodexConfig } from './config.js';
import { codexStatus } from './index.js';
import { readCodexModels } from './models.js';
export function registerCodexRoutes(router, { json, getConfig, listModels = readCodexModels }) {
  let fetching = false;
  router.add('POST', '/api/codex-cli/models', async (_req, res) => {
    if (fetching) return json(res, 409, { error: '模型列表正在获取，请稍后再试' });
    fetching = true;
    try { return json(res, 200, await listModels(getConfig().codexCli)); }
    catch { return json(res, 502, { error: '模型列表获取失败，请先保存 CLI 绝对路径、独立工作目录，并在对应 codex-home 登录；检查网络后重试' }); }
    finally { fetching = false; }
  });
  router.add('GET', '/api/codex-cli/status', async (_req, res) => {
    let valid = true, workspaceReady = false;
    const raw = getConfig().codexCli;
    try { const cfg = normalizeCodexConfig(raw); if (cfg.workspace) { await fs.access(cfg.workspace); workspaceReady = true; } } catch { valid = false; }
    json(res, 200, { ...codexStatus(), enabled: raw?.enabled === true, valid, workspaceReady });
  });
}
