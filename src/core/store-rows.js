export function entry(row) {
  if (!row) return null;
  let reply = null;
  // reply 是历史里写入的 JSON 文本：一行坏数据不应该让整个会话读取抛错（threadEntry 同款护栏）
  if (row.reply) { try { reply = JSON.parse(row.reply); } catch { reply = null; } }
  return {
    ...row, chatKey: String(row.chat_key || ''), senderId: row.sender_id, senderName: row.sender_name,
    self: !!row.self, read: row.state === 'acked',
    reply,
    media: JSON.parse(row.media || '[]'),
    mentionsSelf: Boolean(row.mentions_self),
    targetUserId: String(row.target_user_id || ''),
    eventKind: String(row.event_kind || 'message')
  };
}

export function threadEntry(row) {
  if (!row) return null;
  let participantIds = [];
  try {
    participantIds = JSON.parse(row.participant_ids || '[]').map(String);
  } catch { /* keep empty */ }
  return {
    chatKey: row.chat_key,
    threadId: row.thread_id,
    mode: row.mode || 'threaded',
    state: row.state,
    disposition: row.disposition || 'active',
    topic: row.topic || '',
    participantIds,
    openedAt: Number(row.opened_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    lastHumanAt: Number(row.last_human_at) || 0,
    lastAgentAt: Number(row.last_agent_at) || 0,
    engagedUntil: Number(row.engaged_until) || 0,
    idleDeadline: Number(row.idle_deadline) || 0,
    hardDeadline: Number(row.hard_deadline) || 0,
    resumeArmedUntil: Number(row.resume_armed_until) || 0,
    expiresAt: Number(row.expires_at) || 0,
    lastMessageId: Number(row.last_message_id) || 0,
    promptHash: row.prompt_hash || '',
    transcriptChars: Number(row.transcript_chars) || 0,
    promptTokens: Number(row.prompt_tokens) || 0,
    version: Number(row.version) || 1,
    closeReason: row.close_reason || ''
  };
}

