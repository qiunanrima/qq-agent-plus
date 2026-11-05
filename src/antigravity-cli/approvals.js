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
  if (category !== 'qq') return Promise.resolve(false);
  const canApprove = () => { try { return !signal?.aborted && allowed() === true; } catch { return false; } };
  if (!canApprove() || pending.size >= 32) return Promise.resolve(false);
  const preview = JSON.stringify(args);
  if (!preview || Buffer.byteLength(preview) > 8192 || redactText(preview) !== preview) return Promise.resolve(false);
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
  run.approvalAllowed = category => category === 'qq' && getConfig().antigravityCli?.qqApproval === true;
  run.notifyApproval = async id => {
    const owner = String(getConfig().admin?.ownerUin || '');
    if (!/^\d{5,15}$/.test(owner)) return;
    await sender.sendTextBatch(`private:${owner}`, [`有 CLI 工具等待你确认，请打开控制台 → 设置 → Antigravity CLI 查看。审批编号：${id}。本轮最多等待 60 秒。`], {});
  };
  return run;
}
