import fs from 'node:fs/promises';
import { normalizeCodexConfig } from './config.js';
import { codexStatus } from './index.js';
import { readCodexModels } from './models.js';
import { codexQuotaReader } from './quota.js';
export function registerCodexRoutes(router, { json, getConfig, listModels = readCodexModels }) {
  router.add('GET', '/api/codex-cli/quota', async (_req, res) => json(res, 200, codexQuotaReader.peek(getConfig().codexCli)));
  router.add('POST', '/api/codex-cli/quota', async (_req, res) => {
    try { return json(res, 200, await codexQuotaReader.read(getConfig().codexCli)); }
    catch { return json(res, 502, { error: '额度查询失败，请检查专属目录登录、CLI 版本和网络；15 秒后可重试' }); }
  });
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
