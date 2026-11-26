import { createHash } from 'node:crypto';
import { UnifiedMemoryStore } from './store.js';

export function recordSettledMailFollowUps(filename, scope, jobs) {
  if (!jobs.length) return;
  const summaries = { replied: '邮件已收到回复', due: '邮件到期未回，已进入跟进流程', unverified: '到期时无法核实邮件回复' };
  const store = new UnifiedMemoryStore(filename);
  try {
    for (const { id, status, deadline } of jobs) {
      store.record({ scope, kind: 'task', subject: 'mail-followup:' + id,
        source: 'mail-followup:' + id + ':' + status, timestamp: Date.now(),
        body: { topic: '邮件跟进', summary: summaries[status], status, deadline, followUpId: id },
        closed: status === 'replied' });
    }
  } finally { store.close(); }
}

function workResult(name, args, result) {
  if (result.isError || typeof result.content !== 'string') return null;
  let data;
  try { data = JSON.parse(result.content); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  if (name === 'linux_import_qq_file' || name === 'linux_export_calendar_invitation') {
    const file = data.file || data.path;
    if (typeof file !== 'string' || !file.startsWith('/workspace/') || file.length > 1024) return null;
    return { key: file, topic: '工作区文件', summary: '文件已保存到 ' + file, file };
  }
  if (name !== 'personal_mail_search') return null;
  if (['follow_up_create', 'follow_up_cancel', 'follow_up_reschedule'].includes(args.action)
    && typeof data.id === 'string' && ['pending', 'canceled'].includes(data.status)) {
    const canceled = data.status === 'canceled';
    return { key: 'mail-followup:' + data.id, topic: '邮件跟进', summary: canceled ? '跟进已取消' : '已登记邮件跟进',
      deadline: data.deadline, followUpId: data.id, closed: canceled };
  }
  if (args.action === 'send_calendar_invitation' && ['sent', 'unknown'].includes(data.status)) {
    return { key: data.uid ? 'invitation:' + data.uid : '', topic: String(args.title || '日历邀请').slice(0, 150),
      summary: data.status === 'sent' ? '邀请已发送' : '邀请发送结果未知，需核对原发送记录',
      messageId: data.messageId, status: data.status };
  }
  return null;
}

export function withWorkResults(tools, { filename, scope, sessionId, enabled, onError }) {
  return tools.map(tool => {
    if (!['linux_import_qq_file', 'linux_export_calendar_invitation', 'personal_mail_search'].includes(tool.name)) return tool;
    return { ...tool, async execute(ctx, args) {
      const result = await tool.execute(ctx, args);
      try {
        const work = enabled() && ctx.chatKey === scope && workResult(tool.name, args, result);
        if (work) {
          const { key, closed = false, ...body } = work;
          const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
          const store = new UnifiedMemoryStore(filename);
          try {
            store.record({ scope, subject: key || sessionId, kind: 'task', closed, timestamp: Date.now(),
              source: 'tool:' + sessionId + ':' + tool.name + ':' + digest, body });
          } finally { store.close(); }
        }
      } catch (error) { onError(error); }
      return result;
    } };
  });
}
