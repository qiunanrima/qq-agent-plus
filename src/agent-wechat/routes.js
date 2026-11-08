import { normalizeWechatConfig, validWxid } from './config.js';
import { readOwnerUin } from '../core/notify-owner.js';

export function registerAgentWechatRoutes(router, { runtime, getConfig, updateConfig, json, readBody, auditWrite }) {
  router.add('GET', '/api/agent-wechat/contacts', async (req, res) => {
    try {
      const cursor = new URL(req.url, 'http://localhost').searchParams.get('cursor') || '';
      return json(res, 200, await runtime.contacts(cursor, new URL(req.url, 'http://localhost').searchParams.get('kind') === 'groups'));
    } catch { return json(res, 502, { error: '微信联系人读取失败，请检查账号登录和本地协议服务后重试；原白名单保留' }); }
  });
  router.add('GET', '/api/agent-wechat/status', async (_req, res) => {
    try { return json(res, 200, runtime.status()); }
    catch { return json(res, 200, { enabled: false, running: false, online: false, error: '微信配置无效；QQ 继续运行', peers: [] }); }
  });
  router.add('POST', '/api/agent-wechat/config', async (req, res) => {
    try {
      const body = await readBody(req);
      if (body.confirm !== true) return json(res, 400, { error: '请确认微信渠道设置变更' });
      const next = normalizeWechatConfig({ ...getConfig().agentWechat, ...body.config });
      await auditWrite('agent-wechat.config', 'agent-wechat', { req });
      await runtime.stop();
      updateConfig({ agentWechat: { __replace__: next } });
      await runtime.sync();
      return json(res, 200, { ok: true, ...runtime.status() });
    } catch (error) { return json(res, 400, { error: error?.message?.startsWith('微信') || error?.message?.startsWith('请先') ? error.message : '微信设置保存失败，请检查输入与本地服务' }); }
  });
}

/** Owner-only direct QQ commands; never handled through an LLM or forwarded text. */
export async function handleWechatAdminCommand(event, { getConfig, updateConfig, runtime, audit, reply }) {
  const owner = readOwnerUin(getConfig());
  if (!owner || event?.post_type !== 'message' || event.message_type !== 'private' || String(event.user_id) !== owner
    || String(event.self_id) === owner || Array.isArray(event.message) && event.message.some(s => s.type !== 'text')) return false;
  const text = (Array.isArray(event.message) ? event.message.map(s => s.data?.text || '').join('') : String(event.raw_message || event.message || '')).trim();
  const binding = /^绑定微信\s+(\S+)\s+([1-9]\d{4,14})$/.exec(text);
  const unbind = /^解绑微信\s+(\S+)$/.exec(text);
  const allow = /^微信白名单\s+(添加|移除)\s+(\S+)$/.exec(text);
  const listing = text === '微信绑定' || text === '微信白名单';
  if (!binding && !unbind && !allow && !listing) return false;
  let note;
  try {
    const c = normalizeWechatConfig(getConfig().agentWechat);
    if (listing) note = c.allow.map(id => `${id} → ${c.bindings[id] || '未绑定，按 wxid 处理'}`).join('\n') || '微信白名单为空。';
    else {
      const id = binding?.[1] || unbind?.[1] || allow?.[2];
      if (!validWxid(id)) throw new Error('wxid 无效');
      if (binding) c.bindings[id] = binding[2];
      if (unbind) delete c.bindings[id];
      if (allow) c.allow = allow[1] === '添加' ? [...new Set([...c.allow, id])] : c.allow.filter(x => x !== id);
      const next = normalizeWechatConfig(c);
      const recorded = await audit({ action: 'agent-wechat.identity', target: 'agent-wechat', after: { channel: 'qq-private', decidedBy: owner, wxid: id,
        operation: binding ? 'bind' : unbind ? 'unbind' : allow[1] === '添加' ? 'allow' : 'remove' } });
      if (!recorded) throw new Error('审计未写入');
      await runtime.stop(); updateConfig({ agentWechat: { __replace__: next } }); await runtime.sync();
      note = binding ? `已绑定 ${id} → ${binding[2]}。白名单独立设置，管理权限不会继承。`
        : unbind ? `已解除 ${id} 的 QQ 绑定，原记忆保留；后续按 wxid 处理。`
          : `已${allow[1]}微信白名单：${id}。`;
    }
  } catch { note = '微信设置未完成，请在控制台检查配置和审计；不会自动重试。'; }
  try { await reply(owner, note); } catch { /* Never replay an identity change on notification failure. */ }
  return true;
}
