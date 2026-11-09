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
    return /^(?:ok|okay|好的?|好[呀哒嘞哦喔]|欧克|收到|嗯[嗯呢]?|行|可以|谢谢(?:啦|你)?|晚安|拜拜)$/iu.test(text)
      // A replayed approval command may legitimately finish silently after its
      // direct handler already replied. This never grants or repeats approval.
      || /^(?:同意|批准|拒绝)\s+ap_[\w-]+(?:\s+\d{1,2})?$/u.test(text)
      || /^(?:同意|批准|拒绝)\s*CLI\s+[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(text);
  });
}
