/** Authenticated console search: keep each result's source chat; never merge transcripts. */
export function searchPersonHistory(db, { userId, query = '', scope = 'all', limit = 30, offset = 0, after = 0, before = 0 } = {}) {
  if (!/^\d{1,15}$/.test(String(userId || ''))) throw new Error('请输入数字QQ号');
  if (!['all', 'group', 'private'].includes(scope)) throw new Error('会话类型无效');
  const size = Math.max(1, Math.min(50, Math.floor(Number(limit) || 30)));
  const skip = Math.max(0, Math.min(10000, Math.floor(Number(offset) || 0)));
  const rows = db.prepare(`SELECT chat_key,id,mid,ts,sender_id,sender_name,text,self FROM messages
    WHERE state='acked' AND event_kind='message'
    AND (chat_key GLOB 'group:[0-9]*' OR chat_key GLOB 'private:[0-9]*')
    AND ((chat_key GLOB 'group:[0-9]*' AND self=0 AND sender_id=?) OR chat_key=?)
    AND (?='all' OR (?='group' AND chat_key GLOB 'group:[0-9]*') OR (?='private' AND chat_key GLOB 'private:[0-9]*'))
    AND (?='' OR instr(lower(text),lower(?))>0) AND ts>=? AND (?=0 OR ts<=?)
    ORDER BY ts DESC,chat_key,id DESC LIMIT ? OFFSET ?`).all(String(userId), `private:${userId}`, scope, scope, scope,
    String(query).slice(0, 120), String(query).slice(0, 120), Math.max(0, Number(after) || 0),
    Math.max(0, Number(before) || 0), Math.max(0, Number(before) || 0), size + 1, skip);
  const more = rows.length > size;
  return { userId: String(userId), messages: rows.slice(0, size).map(row => ({
    chatKey: row.chat_key, localId: row.id, messageId: row.mid, time: row.ts,
    senderId: row.sender_id, senderName: row.sender_name, self: !!row.self,
    text: String(row.text || '').slice(0, 1200)
  })), nextOffset: more && skip + size <= 10000 ? skip + size : null };
}
