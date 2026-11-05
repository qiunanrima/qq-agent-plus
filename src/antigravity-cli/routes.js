import fs from 'node:fs/promises';
import { normalizeAntigravityConfig } from './config.js';
import { antigravityStatus } from './index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createQuotaReader } from './quota.js';
import { listCliApprovals, decideCliApproval } from './approvals.js';

const runFile = promisify(execFile);

/** Local status only: polling must never spawn the CLI or contact Google. */
export function registerAntigravityRoutes(router, { json, getConfig, readBody, auditWrite }) {
  router.add('GET', '/api/antigravity-cli/approvals', async (_req, res) => json(res, 200, { pending: listCliApprovals() }));
  router.add('POST', '/api/antigravity-cli/approvals/:id', async (req, res, params) => {
    if (typeof readBody !== 'function' || typeof auditWrite !== 'function') return json(res, 503, { error: '审批审计接口尚未就绪' });
    const body = await readBody(req);
    if (typeof body.approved !== 'boolean') return json(res, 400, { error: '需要明确批准或拒绝' });
    const entry = listCliApprovals().find(item => item.id === params.id);
    if (!entry) return json(res, 409, { error: '该审批已失效或已处理' });
    // Audit before releasing the waiting operation; failed audit never grants access.
    await auditWrite('antigravity.approval', `cli:${params.id}`, { req, approved: body.approved, category: entry.category, tool: entry.tool, chatKey: entry.chatKey, runId: entry.runId });
    if (!decideCliApproval(params.id, body.approved)) return json(res, 409, { error: '该审批已失效或已处理' });
    return json(res, 200, { ok: true });
  });
  const readQuota = createQuotaReader();
  router.add('GET', '/api/antigravity-cli/quota', async (_req, res) => {
    const cfg = getConfig().antigravityCli;
    return json(res, 200, readQuota.peek(cfg?.executable || 'agy'));
  });
  router.add('POST', '/api/antigravity-cli/quota', async (_req, res) => {
    try {
      const cfg = normalizeAntigravityConfig(getConfig().antigravityCli);
      return json(res, 200, await readQuota(cfg.executable));
    } catch { return json(res, 503, { error: '额度查询失败，请检查 CLI 版本、登录状态和网络；一分钟后可重试' }); }
  });
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
      pendingApprovals: listCliApprovals().length,
      model: cfg.model || '', agent: cfg.agent });
  });
}
