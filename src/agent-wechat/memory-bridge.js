import { createHash } from 'node:crypto';
import { memoryDay, personaKey } from '../memory/hippocampus.js';

/** Read-only bridge over explicit bindings; never imports histories or rewrites memory. */
export function crossPlatformMemoryTools({ config, getConfig = () => config, chatKey, wechatPeer = '', participantIds = [], memory, persona }) {
  if (!config?.enabled || !Object.keys(config.bindings || {}).length) return [];
  const group = chatKey.startsWith('group:');
  const identities = new Set(group ? participantIds.map(String) : [wechatPeer || chatKey.replace(/^private:/, '')]);
  const pairs = Object.entries(config.bindings).filter(([wxid, qq]) => identities.has(wxid) || identities.has(qq));
  if (!pairs.length) return [];
  return [{ name: 'cross_platform_memory_lookup', description: '按已确认 wxid↔QQ 绑定，双向查询同一人的另一平台私聊摘要、人物印象和人物卡片。不是完整聊天记录；群聊读取由共享开关控制。',
    parameters: { type: 'object', properties: { userId: { type: 'string', description: '当前成员的 wxid 或 QQ 号；单人可省略' }, query: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false },
    execute: async (ctx, args = {}) => {
      if (ctx.signal?.aborted) return { isError: true, content: '当前回合已停止' };
      const current = getConfig();
      if (!current?.enabled || current.accountId !== config.accountId) return { isError: true, content: '微信绑定记忆共享已停止或账号已切换。' };
      if (group && !current.sharePrivateMemoryInGroups) return { isError: true, reportIncident: false, content: '群聊读取绑定账号私聊来源记忆的开关未开启。' };
      const pair = args.userId ? pairs.find(row => row.includes(String(args.userId))) : pairs.length === 1 ? pairs[0] : null;
      if (!pair) return { isError: true, reportIncident: false, content: '请指定本轮已绑定成员的 wxid 或 QQ 号。' };
      const [wxid, qq] = pair;
      if (current.bindings?.[wxid] !== qq) return { isError: true, content: '该身份绑定已变更，请重新查询。' };
      const fromWechat = !!wechatPeer;
      const target = fromWechat ? qq : wxid;
      const source = fromWechat ? `private:${qq}` : `private:wechat_${createHash('sha256').update(JSON.stringify([config.accountId, wxid])).digest('hex')}`;
      const query = String(args.query || '').slice(0, 300);
      const matches = value => !query || String(value).includes(query);
      const entries = (memory.hippocampus?.episodes?.(true) || []).filter(row => row.persona === personaKey(persona) && row.chat === source && matches(row.summary))
        .map(row => ({ kind: 'episode', day: row.day, summary: row.summary }));
      const cards = (memory.hippocampus?.cards?.({ persona, chatKey: source }) || []).filter(row => row.kind === 'person' && String(row.subject) === target && matches(row.content))
        .map(({ title, content }) => ({ kind: 'person', title, content }));
      const impressions = fromWechat ? (memory.query?.(source, 'memberImpression')?.memberImpression || [])
        .filter(row => String(row.userId) === qq && matches(row.content)).map(({ content }) => ({ kind: 'impression', content })) : [];
      const rows = [...entries, ...cards, ...impressions];
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      return { content: JSON.stringify({ wxid, qq, sourcePlatform: fromWechat ? 'qq' : 'wechat', today: memoryDay(), total: rows.length,
        entries: rows.slice(offset, offset + 20), nextOffset: offset + 20 < rows.length ? offset + 20 : null,
        note: '另一平台的实际记忆资料，不是当前会话发生的事；是否提及由你根据场合判断。空结果不代表没有绑定。' }) };
    } }];
}
