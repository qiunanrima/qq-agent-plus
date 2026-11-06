import { randomUUID } from 'node:crypto';
import { redactText } from '../core/redact.js';

// Single-use decisions belong to a live run, never to future/restarted runs.
const pending = new Map();
export function requiresQqApproval(config) { return config.antigravityCli?.enabled === true && config.antigravityCli?.qqApproval === true; }
export function listCliApprovals() {
  return [...pending.values()].map(entry => structuredClone(entry.view));
}
export function decideCliApproval(id, approved) {
  const entry = pending.get(id);
  if (!entry || entry.view.expiresAt <= Date.now() || typeof approved !== 'boolean') return false;
  if (!entry.canApprove()) { entry.settle(false); return false; }
  entry.settle(approved);
  return true;
}
export function requestCliApproval({ category, chatKey, runId, tool, args, signal, timeoutMs = 60000, allowed = () => true, notify }) {
  if (!['qq', 'native'].includes(category) || !chatKey || !runId || !tool || !args || typeof args !== 'object') return Promise.resolve(false);
  const canApprove = () => { try { return !signal?.aborted && allowed() === true; } catch { return false; } };
  if (!canApprove() || pending.size >= 32) return Promise.resolve(false);
  const preview = JSON.stringify(args);
  if (!preview || Buffer.byteLength(preview) > 8192 || redactText(preview, preview.length) !== preview) return Promise.resolve(false);
  return new Promise(resolve => {
    const id = randomUUID();
    let settled = false;
    const settle = approved => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(guard);
      signal?.removeEventListener('abort', abort); pending.delete(id);
      resolve(approved === true && canApprove());
    };
    const abort = () => settle(false);
    const duration = Math.min(60000, Math.max(1, timeoutMs));
    const timer = setTimeout(abort, duration);
    const guard = setInterval(() => { if (!canApprove()) abort(); }, 100);
    pending.set(id, { settle, canApprove, view: { id, category, chatKey, runId, tool, preview, expiresAt: Date.now() + duration } });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else Promise.resolve().then(() => pending.has(id) && notify?.(id)).catch(() => {});
  });
}

export function bindRunApprovalPolicy(run, { getConfig, sender }) {
  run.approvalAllowed = category => (category === 'qq' && getConfig().antigravityCli?.qqApproval === true)
    || (category === 'native' && getConfig().antigravityCli?.nativeApproval === true);
  run.notifyApproval = async id => {
    const owner = String(getConfig().admin?.ownerUin || '');
    if (!/^\d{5,15}$/.test(owner)) return;
    const entry = pending.get(id)?.view;
    if (!entry) return;
    const short = entry.preview.length <= 1500;
    const text = [`CLI ${entry.category === 'native' ? '原生' : 'QQ 宿主'}工具待审批：${entry.tool}`,
      `会话：${entry.chatKey}；本轮：${entry.runId}`,
      short ? `参数（数据）：${entry.preview}` : '参数较长，请到控制台核对完整参数后批准。',
      short ? `仅批准本次：批准CLI ${id}` : '', `拒绝本次：拒绝CLI ${id}`,
      '也可打开控制台 → 设置 → Antigravity CLI。最长等待 60 秒，超时或结束后失效。'].filter(Boolean).join('\n');
    await sender.sendTextBatch(`private:${owner}`, [text], {});
  };
  return run;
}
