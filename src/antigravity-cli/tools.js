import { antigravityQuotaReader } from './quota.js';
import { normalizeAntigravityConfig } from './config.js';

export function antigravityQuotaTools(getConfig, { readQuota = antigravityQuotaReader } = {}) {
  if (getConfig().antigravityCli?.enabled !== true) return [];
  return [{ name: 'antigravity_quota',
    description: '用户询问额度时，查看当前 Antigravity 账号剩余额度（模型分组、重置时间与额外积分）；不要后台周期调用。默认读取五分钟内缓存；用户明确要求刷新时传 refresh=true，刷新最多每分钟一次。仅使用官方只读额度命令，不启动额外模型回合、不购买积分。未知不等于零，按 checkedAt 说明查询时间。',
    parameters: { type: 'object', properties: { refresh: { type: 'boolean', description: '用户明确要求刷新额度时设为 true' } }, additionalProperties: false },
    async execute(ctx, args = {}) {
      ctx.signal?.throwIfAborted();
      const before = getConfig().antigravityCli;
      if (before?.enabled !== true) return { isError: true, reportIncident: false, content: 'CLI 已停用，额度工具不可用。' };
      if (Object.hasOwn(args, 'refresh') && typeof args.refresh !== 'boolean') return { isError: true, noEffect: true, errorCode: 'INVALID_TOOL_ARGUMENTS', reportIncident: false, content: 'refresh 必须是布尔值。' };
      try {
        const cfg = normalizeAntigravityConfig(before);
        const result = await readQuota(cfg.executable, { refresh: args.refresh === true });
        ctx.signal?.throwIfAborted();
        const current = getConfig().antigravityCli;
        if (current?.enabled !== true || normalizeAntigravityConfig(current).executable !== cfg.executable) return { isError: true, reportIncident: false, content: 'CLI 配置已变化，本次结果不再使用。' };
        return { content: JSON.stringify({ ...result, note: '额度比例为 0–1；积分与模型额度分开计算。缺失项表示未知，不要解释为额度耗尽。' }) };
      } catch { return { isError: true, reportIncident: false, content: '额度查询失败或本轮已取消；请检查 CLI 登录和网络，一分钟后可重试。不要重复自动刷新。' }; }
    }
  }];
}
