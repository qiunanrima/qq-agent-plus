// 动态与私信：只经宿主 HTTP；审批、配额和写入审计由 manifest + 宿主执行。
import crypto from 'node:crypto';
import { allowsUid } from './message-policy.mjs';

const IM = 'https://api.vc.bilibili.com';

function ownerOnly(context) {
  if (context?.channel !== 'console' && context?.senderIsOwner !== true) {
    throw new Error('只有管理员可以发布动态或读写 B 站私信');
  }
}

function approvedWrite(context, action, target = '') {
  // approved 只来自宿主通过审批门后的 context；批准后的自动执行不再带原聊天 owner 身份。
  if (context?.approved?.action === action && context.approved.target === target) return;
  ownerOnly(context);
}

function decimal(value, label, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  // 拒绝 number：动态/消息序号可能超过 JS 安全整数，必须从头保留字符串。
  if (typeof value !== 'string' || !/^[1-9]\d{0,24}$/.test(value)) {
    throw new Error(`${label} 必须是正整数字符串`);
  }
  return value;
}

function messageRow(item = {}) {
  const withdrawn = Number(item.msg_status) === 1;
  let text = '';
  if (!withdrawn && Number(item.msg_type) === 1) {
    try { text = String(JSON.parse(item.content).content || '').slice(0, 2000); } catch { text = '[消息内容无法解析]'; }
  }
  return {
    senderMid: String(item.sender_uid ?? ''),
    seqno: String(item.msg_seqno ?? ''),
    timestamp: Number(item.timestamp) || 0,
    type: Number(item.msg_type) || 0,
    withdrawn,
    text: withdrawn ? '[已撤回]' : text || '[非文字消息]'
  };
}

function bodyText(value, maxBytes) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('正文不能为空');
  const text = value.trim();
  if (Buffer.byteLength(JSON.stringify({ content: text }), 'utf8') > maxBytes) {
    throw new Error(`正文过长（UTF-8 编码后最多 ${maxBytes} 字节，含消息结构）`);
  }
  return text;
}

export function createPublishingTools({ httpJson, wbiUrl, requireLogin, requireWriteAuth, navIdentity, num, getSettings = () => ({}) }) {
  return {
    async dynamic_publish({ text } = {}, context = {}) {
      approvedWrite(context, 'dynamic_publish');
      const content = bodyText(text, 6000);
      const auth = await requireWriteAuth();
      const result = await httpJson('https://api.bilibili.com/x/dynamic/feed/create/dyn', {
        method: 'POST', auth: true,
        json: { dyn_req: { content: { contents: [{ raw_text: content, type: 1, biz_id: '' }] }, scene: 1 } },
        // CSRF 放查询参数是 B 站该接口的契约；不得记录 URL query。
        query: { csrf: auth.bili_jct }
      });
      const id = result?.data?.dyn_id_str;
      if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) {
        throw Object.assign(new Error('发布请求已返回，但缺少动态 ID；请到 B 站核对，勿重复发布'), { code: 'E_WRITE_UNKNOWN' });
      }
      return { ok: true, id, url: `https://t.bilibili.com/${id}`, verified: false };
    },

    async messages({ what = 'sessions', mid, cursor, limit } = {}, context = {}) {
      ownerOnly(context);
      if (!['sessions', 'history'].includes(what)) throw new Error('what 必须是 sessions 或 history');
      const target = what === 'history' ? decimal(mid, 'mid') : '';
      if (target && !allowsUid(getSettings(), 'receive', target)) throw new Error('对方 UID 不在收信白名单');
      const offset = decimal(cursor, 'cursor', true);
      await requireLogin({ write: false });
      const query = new URLSearchParams({ size: String(num(limit, 20, 1, 50)), mobi_app: 'web' });
      if (what === 'sessions') {
        query.set('session_type', '1');
        if (offset) query.set('end_ts', offset);
        const result = await httpJson(`${IM}/session_svr/v1/session_svr/get_sessions?${query}`, { auth: true });
        if (!result?.data || (result.data.session_list != null && !Array.isArray(result.data.session_list))) {
          throw new Error('B 站会话列表响应不完整');
        }
        const rows = (result.data.session_list || []).slice(0, num(limit, 20, 1, 50));
        return {
          what, results: rows.filter((item) => allowsUid(getSettings(), 'receive', String(item.talker_id))).map((item) => ({
            mid: String(item.talker_id ?? ''), unread: Number(item.unread_count) || 0,
            lastMessage: item.last_msg ? messageRow(item.last_msg) : null
          })),
          hasMore: Boolean(result.data.has_more), nextCursor: String(rows.at(-1)?.session_ts ?? '')
        };
      }
      query.set('talker_id', target);
      query.set('session_type', '1');
      if (offset) query.set('end_seqno', offset);
      const result = await httpJson(`${IM}/svr_sync/v1/svr_sync/fetch_session_msgs?${query}`, { auth: true });
      if (!result?.data || (result.data.messages != null && !Array.isArray(result.data.messages))) {
        throw new Error('B 站私信历史响应不完整');
      }
      return {
        what, mid: target,
        results: (result.data.messages || []).slice(0, num(limit, 20, 1, 50)).map(messageRow),
        hasMore: Boolean(result.data.has_more), nextCursor: String(result.data.min_seqno ?? ''),
        note: '读取不会标记已读；这里只展示文字，已撤回的消息不展示原文。'
      };
    },

    async message_send({ mid, text } = {}, context = {}) {
      const target = decimal(mid, 'mid');
      approvedWrite(context, 'message_send', target);
      if (!allowsUid(getSettings(), 'send', target)) throw new Error('对方 UID 不在发信白名单');
      const content = bodyText(text, 2000);
      const auth = await requireWriteAuth();
      const who = await navIdentity();
      if (!who.isLogin || !/^[1-9]\d*$/.test(who.mid)) throw new Error('登录态无效，请重新扫码登录');
      const channelAccount = /^private:bilibili_([1-9]\d{0,24})_([1-9]\d{0,24})$/.exec(String(context.chatKey || ''));
      if (channelAccount && (channelAccount[1] !== who.mid || channelAccount[2] !== target)) throw new Error('B 站登录账号或会话目标已变化，拒绝发送');
      const devId = crypto.randomUUID();
      const url = await wbiUrl('/web_im/v1/web_im/send_msg', {
        w_sender_uid: who.mid, w_receiver_id: target, w_dev_id: devId
      }, IM);
      if (!allowsUid(getSettings(), 'send', target)) throw new Error('对方 UID 已从发信白名单移除');
      const result = await httpJson(url, {
        method: 'POST', auth: true,
        form: {
          'msg[sender_uid]': who.mid, 'msg[receiver_id]': target, 'msg[receiver_type]': 1,
          'msg[msg_type]': 1, 'msg[msg_status]': 0, 'msg[dev_id]': devId,
          'msg[timestamp]': Math.floor(Date.now() / 1000), 'msg[new_face_version]': 1,
          'msg[content]': JSON.stringify({ content }), csrf: auth.bili_jct, csrf_token: auth.bili_jct,
          mobi_app: 'web'
        }
      });
      if (!result?.data?.msg_key) {
        throw Object.assign(new Error('发送请求已返回，但缺少消息凭据；请到 B 站核对，勿重复发送'), { code: 'E_WRITE_UNKNOWN' });
      }
      return { ok: true, mid: target, verified: false, note: 'B 站接口已接受发送请求，不代表对方已收到或已读；发送会将该会话标记已读。' };
    }
  };
}
