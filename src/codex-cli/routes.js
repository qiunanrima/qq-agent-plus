import fs from 'node:fs/promises';
import { normalizeCodexConfig } from './config.js';
import { codexStatus } from './index.js';
export function registerCodexRoutes(router, { json, getConfig }) {
  router.add('GET', '/api/codex-cli/status', async (_req, res) => {
    let valid = true, workspaceReady = false;
    const raw = getConfig().codexCli;
    try { const cfg = normalizeCodexConfig(raw); if (cfg.workspace) { await fs.access(cfg.workspace); workspaceReady = true; } } catch { valid = false; }
    json(res, 200, { ...codexStatus(), enabled: raw?.enabled === true, valid, workspaceReady });
  });
}
