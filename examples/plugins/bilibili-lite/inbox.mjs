import { allowsUid } from './message-policy.mjs';
import { randomUUID } from 'node:crypto';

export function createInbox({ callHost, httpJson, navIdentity, getSettings, now = () => Date.now() }) {
  let busy = false;
  let lastPollAt = null;
  let peerOffset = 0;
  let proposed = null;
  const validSeq = value => /^[0-9]{1,25}$/.test(String(value ?? ''));
  return {
    async poll() {
      if (busy || getSettings().receiveEnabled !== true) return { events: [] };
      const interval = Math.max(1, Math.min(60, Math.floor(Number(getSettings().pollIntervalMinutes) || 1))) * 60000;
      if (lastPollAt !== null && now() - lastPollAt < interval) return { events: [] };
      lastPollAt = now();
      busy = true;
      try {
        const who = await navIdentity();
        if (!who.isLogin || !/^[1-9]\d{0,24}$/.test(who.mid)) throw new Error('自动收信需要有效登录');
        const key = `inbox_${who.mid}`;
        const saved = (await callHost('cap.storage.get', { key })).value;
        const cursors = saved?.cursors && typeof saved.cursors === 'object' ? { ...saved.cursors } : {};
        const list = await httpJson('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&size=50&mobi_app=web', { auth: true });
        if (!list?.data || list.data.session_list != null && !Array.isArray(list.data.session_list)) throw new Error('自动收信会话响应不完整');
        const peers = (list.data.session_list || []).filter(p => Number(p.session_type) === 1 && !p.system_msg_type
          && allowsUid(getSettings(), 'receive', String(p.talker_id)));
        if (!saved?.initialized) {
          for (const p of peers) if (validSeq(p.last_msg?.msg_seqno)) cursors[String(p.talker_id)] = String(p.last_msg.msg_seqno);
          await callHost('cap.storage.set', { key, value: { initialized: true, cursors } });
          return { account: who.mid, events: [], initialized: true };
        }
        const events = [];
        const changed = peers.filter(p => validSeq(p.last_msg?.msg_seqno)
          && (!validSeq(cursors[String(p.talker_id)]) || BigInt(p.last_msg.msg_seqno) > BigInt(cursors[String(p.talker_id)])));
        const selected = Array.from({ length: Math.min(changed.length, 10) }, (_, i) => changed[(peerOffset + i) % changed.length]);
        peerOffset = changed.length ? (peerOffset + selected.length) % changed.length : 0;
        for (const p of selected) {
          const mid = String(p.talker_id);
          if (!validSeq(p.last_msg?.msg_seqno) || validSeq(cursors[mid]) && BigInt(p.last_msg.msg_seqno) <= BigInt(cursors[mid])) continue;
          const data = await httpJson(`https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?talker_id=${mid}&session_type=1&size=50&mobi_app=web`, { auth: true });
          if (!data?.data || data.data.messages != null && !Array.isArray(data.data.messages)) throw new Error('自动收信历史响应不完整');
          const messages = (data.data.messages || []).filter(m => validSeq(m.msg_seqno))
            .sort((a, b) => BigInt(a.msg_seqno) < BigInt(b.msg_seqno) ? -1 : 1);
          let cursor = validSeq(cursors[mid]) ? BigInt(cursors[mid]) : 0n;
          for (const m of messages) {
            if (BigInt(m.msg_seqno) <= cursor) continue;
            if (events.length >= 20) break;
            cursor = BigInt(m.msg_seqno);
            if (String(m.sender_uid) !== mid || Number(m.msg_type) !== 1 || Number(m.msg_status) === 1) continue;
            const ts = Number(m.timestamp) * 1000;
            if (!Number.isFinite(ts) || ts > now() + 60000 || ts < now() - Math.max(600000, interval + 120000)) continue;
            let text;
            try { text = JSON.parse(m.content).content; } catch { continue; }
            if (typeof text !== 'string' || !text.trim()) continue;
            events.push({ mid, seqno: String(m.msg_seqno), ts, text: text.slice(0, 2000) });
          }
          cursors[mid] = String(cursor);
          if (events.length >= 20) break;
        }
        // ACK 仅能提交本进程刚产生的游标；宿主落库后才调用，失败时下轮重投并由消息 ID 去重。
        proposed = { token: randomUUID(), key, cursors: Object.fromEntries(Object.entries(cursors).slice(-300)) };
        return { account: who.mid, events, checkpoint: proposed.token };
      } finally { busy = false; }
    },
    async ack(token) {
      if (!proposed || token !== proposed.token) throw new Error('无效的收信确认');
      const pending = proposed;
      await callHost('cap.storage.set', { key: pending.key, value: { initialized: true, cursors: pending.cursors } });
      if (proposed === pending) proposed = null;
      return { ok: true };
    }
  };
}
