export const WECHAT_DEFAULTS = Object.freeze({ enabled: false, graduated: false,
  endpoint: 'http://127.0.0.1:6174', accountId: '', tokenFile: '', allow: [], groups: [], nativeApproval: false, sharePrivateMemoryInGroups: false, bindings: {} });
export const validWechatGroup = id => typeof id === 'string' && /^\d{1,64}@chatroom$/.test(id);
export const validWxid = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) && !['filehelper', '__proto__', 'constructor', 'prototype'].includes(id);
export function normalizeWechatConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('微信配置必须为对象');
  const c = { ...WECHAT_DEFAULTS, ...raw };
  if (typeof c.enabled !== 'boolean' || typeof c.graduated !== 'boolean') throw new Error('微信开关无效');
  const url = new URL(c.endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('微信服务仅允许本机 HTTP 地址');
  if (typeof c.accountId !== 'string' || !/^[A-Za-z0-9_-]{0,128}$/.test(c.accountId)) throw new Error('微信账号无效');
  if (typeof c.tokenFile !== 'string' || /[\r\n\0]/.test(c.tokenFile)) throw new Error('微信令牌路径无效');
  if (!Array.isArray(c.allow) || c.allow.length > 100 || c.allow.some(id => !validWxid(id))) throw new Error('微信白名单必须为 wxid 列表');
  if (!Array.isArray(c.groups) || c.groups.length > 100 || c.groups.some(id => !validWechatGroup(id))) throw new Error('微信群白名单无效');
  if (typeof c.nativeApproval !== 'boolean') throw new Error('微信原生审批开关无效');
  if (typeof c.sharePrivateMemoryInGroups !== 'boolean') throw new Error('微信群私聊记忆共享开关无效');
  if (!c.bindings || typeof c.bindings !== 'object' || Array.isArray(c.bindings) || Object.entries(c.bindings).length > 100
    || Object.entries(c.bindings).some(([id, qq]) => !validWxid(id) || typeof qq !== 'string' || !/^[1-9]\d{4,14}$/.test(qq))) throw new Error('微信绑定必须为 wxid → QQ 号');
  if (c.enabled && (!c.accountId || !c.tokenFile)) throw new Error('请先配置本地微信服务账号和令牌路径');
  return { enabled: c.enabled, graduated: c.graduated, endpoint: url.origin, accountId: c.accountId,
    tokenFile: c.tokenFile, allow: [...new Set(c.allow)], groups: [...new Set(c.groups)], nativeApproval: c.nativeApproval,
    sharePrivateMemoryInGroups: c.sharePrivateMemoryInGroups, bindings: { ...c.bindings } };
}

export function wechatBindingContext(raw, { chatKey, wechatPeer = '', participantIds = [] }) {
  if (!raw?.enabled) return '';
  const group = chatKey.startsWith('group:');
  const relevant = new Set(group ? participantIds.map(String) : [wechatPeer || chatKey.replace(/^private:/, '')]);
  const pairs = Object.entries(raw.bindings || {}).filter(([wxid, qq]) => relevant.has(wxid) || relevant.has(qq));
  if (!pairs.length) return wechatPeer ? '【跨平台身份】当前微信联系人未绑定 QQ，按 wxid 独立处理。' : '';
  return '【已确认的 QQ / 微信身份绑定，仅作身份资料】\n'
    + JSON.stringify(pairs.map(([wxid, qq]) => ({ wxid, qq })))
    + '\n同一绑定对应同一个人。双方可用 cross_platform_memory_lookup 查询另一平台的实际摘要及人物记忆；微信端也可用 memory_query / person_memory_lookup 查询绑定 QQ 的人物记忆。有结果才能声称记得。'
    + (group ? raw.sharePrivateMemoryInGroups ? '\n已开启微信群读取绑定成员私聊来源的人物记忆，由你结合场合决定是否说出。' : '\n当前微信群只可查询群内来源的人物印象，私聊来源未开放。' : '')
    + '\n共享的是可见人物记忆，并非完整聊天记录或全部双向记忆；绑定不授予跨平台发消息或管理权限。';
}
