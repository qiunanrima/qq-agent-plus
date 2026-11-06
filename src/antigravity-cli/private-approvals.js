import { listCliApprovals, decideCliApproval } from './approvals.js';

/** Handle directly at ingress so approval never waits behind the active chat. */
export async function handlePrivateCliApproval(event, { getConfig, audit, reply }) {
  const owner = String(getConfig().admin?.ownerUin || '');
  if (!owner || event?.post_type !== 'message' || event.message_type !== 'private'
    || String(event.user_id) !== owner || String(event.user_id) === String(event.self_id)) return false;
  if (Array.isArray(event.message) && event.message.some(part => part.type !== 'text')) return false;
  const text = Array.isArray(event.message) ? event.message.map(part => part.data?.text || '').join('')
    : String(event.raw_message || event.message || '');
  const match = /^\s*\/?(批准|同意|拒绝)\s*CLI\s+([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\s*$/i.exec(text);
  if (!match) return false;
  const id = match[2].toLowerCase(), approved = match[1] !== '拒绝';
  const entry = listCliApprovals().find(item => item.id === id);
  let note = '该 CLI 审批已失效或已处理，未执行新操作。';
  if (entry) {
    if (approved && entry.preview.length > 1500) note = '参数较长，请在控制台核对完整参数后批准；私聊仍可拒绝。';
    else {
      let recorded = false;
      try {
        recorded = Boolean(await audit({ action: 'antigravity.approval', target: `cli:${id}`,
          after: { channel: 'qq-private', decidedBy: owner, approved, category: entry.category,
            tool: entry.tool, chatKey: entry.chatKey, runId: entry.runId } }));
      } catch { /* No audit, no permission grant. */ }
      if (!recorded) note = '审批审计写入失败，未批准；请稍后在控制台处理。';
      else if (String(getConfig().admin?.ownerUin || '') === owner && decideCliApproval(id, approved))
        note = approved ? `已批准这一次 CLI 工具调用：${entry.tool}。` : `已拒绝 CLI 工具调用：${entry.tool}。`;
    }
  }
  try { await reply(owner, note); } catch { /* Never replay a decision on delivery failure. */ }
  return true;
}
