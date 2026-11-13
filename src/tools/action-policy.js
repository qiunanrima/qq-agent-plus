import { getConfig } from '../core/config.js';

/**
 * 动作策略：同一种动作在会话内冷却 + 整轮次数上限。
 * gate 只检查、不扣配额；真正发送成功后再调 actionDone —— 失败/校验拒绝不能白占冷却。
 */
export function actionGate(ctx, kind) {
  const cfg = getConfig().humanize;
  if (cfg?.enabled !== true || cfg?.actions?.enabled === false) return { ok: true };
  const run = ctx.session?.actionPolicy || (ctx.session.actionPolicy = { count: 0 });
  const max = Math.max(1, Number(cfg.actions?.maxPerRun) || 4);
  if (run.count >= max) {
    return { ok: false, reason: `本轮动作次数已达上限（${max} 次），先把话说完`, code: 'action-run-limit' };
  }
  const cooldownKey = kind === 'voice' ? 'voiceCooldownMs' : `${kind}CooldownMs`;
  const cooldown = Math.max(0, Number(cfg.actions?.[cooldownKey]) || 0);
  const mem = ctx.actionMemory?.get(ctx.chatKey);
  const last = Number(mem?.at?.[kind]) || 0;
  if (cooldown > 0 && Date.now() - last < cooldown) {
    const wait = Math.ceil((cooldown - (Date.now() - last)) / 1000);
    return { ok: false, reason: `这个动作刚刚用过，${wait} 秒后再试`, code: 'action-cooldown' };
  }
  return { ok: true };
}

export function actionDone(ctx, kind) {
  const cfg = getConfig().humanize;
  if (cfg?.enabled !== true || cfg?.actions?.enabled === false) return;
  const run = ctx.session?.actionPolicy || (ctx.session.actionPolicy = { count: 0 });
  run.count += 1;
  if (ctx.actionMemory) {
    const mem = ctx.actionMemory.get(ctx.chatKey) || { at: {} };
    mem.at[kind] = Date.now();
    ctx.actionMemory.set(ctx.chatKey, mem);
  }
}

