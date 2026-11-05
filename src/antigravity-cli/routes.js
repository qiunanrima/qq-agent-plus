import fs from 'node:fs/promises';
import { normalizeAntigravityConfig } from './config.js';
import { antigravityStatus } from './index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

/** Local status only: polling must never spawn the CLI or contact Google. */
export function registerAntigravityRoutes(router, { json, getConfig }) {
  let catalog, fetching = false;
  router.add('POST', '/api/antigravity-cli/models', async (_req, res) => {
    const cfg = normalizeAntigravityConfig(getConfig().antigravityCli);
    if (catalog?.executable === cfg.executable && Date.now() - catalog.at < 60000) return json(res, 200, { models: catalog.models });
    if (fetching) return json(res, 409, { error: '模型列表正在获取，请稍后查看' });
    fetching = true;
    try {
      const { stdout } = await runFile(cfg.executable, ['models'], { timeout: 15000, maxBuffer: 128 * 1024, windowsHide: true, shell: false });
      const models = stdout.split(/\r?\n/).flatMap(line => {
        const match = /^([a-zA-Z0-9][a-zA-Z0-9._/-]{0,99})\t([^\t\r\n]{1,120})$/.exec(line);
        return match ? [{ id: match[1], name: match[2] }] : [];
      }).slice(0, 128);
      if (!models.length) throw new Error('Empty catalog');
      catalog = { executable: cfg.executable, at: Date.now(), models };
      return json(res, 200, { models });
    } catch { return json(res, 502, { error: '模型列表获取失败，请检查 CLI 路径与登录状态' }); }
    finally { fetching = false; }
  });
  router.add('GET', '/api/antigravity-cli/status', async (_req, res) => {
    let cfg;
    try { cfg = normalizeAntigravityConfig(getConfig().antigravityCli); }
    catch { return json(res, 200, { enabled: false, valid: false, active: antigravityStatus().active }); }
    let workspaceReady = false;
    try { workspaceReady = (await fs.stat(cfg.workspace)).isDirectory(); } catch { /* not prepared */ }
    return json(res, 200, { enabled: cfg.enabled, valid: true, workspaceReady,
      active: antigravityStatus().active, transport: cfg.transport,
      model: cfg.model || '', agent: cfg.agent });
  });
}
