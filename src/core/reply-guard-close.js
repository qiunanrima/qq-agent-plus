/** Suppress an error fallback only after a successful silent acknowledgement. */
export function isAcknowledgedClose(session, entries) {
  if (!Array.isArray(entries) || !entries.length || session.error) return false;
  const events = session.messages || [];
  if (events.some(m => m.toolCall?.isError)) return false;
  if (!events.some(m => m.toolCall?.name === 'finish' && m.toolCall.isError === false)) return false;
  if (events.some(m => m.role === 'assistant' && String(m.content || '').trim())) return false;
  return entries.every(entry => {
    if (entry.media?.length) return false;
    const text = String(entry.text || '').trim().replace(/[。！!，,～~\s]+$/u, '');
    return /^(?:ok|okay|好的?|好[呀哒嘞哦喔]|欧克|收到|嗯[嗯呢]?|行|可以|谢谢(?:啦|你)?|晚安|拜拜)$/iu.test(text);
  });
}
