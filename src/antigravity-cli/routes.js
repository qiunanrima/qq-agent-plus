import fs from 'node:fs/promises';
import { normalizeAntigravityConfig } from './config.js';
import { antigravityStatus } from './index.js';

/** Local status only: polling must never spawn the CLI or contact Google. */
export function registerAntigravityRoutes(router, { json, getConfig }) {
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
