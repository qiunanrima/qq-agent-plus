/** A factual fallback when CLI ends without qq_finish; never another model call. */
export function ensureCliSummary(session, triggerEntries, reply) {
  if (String(session.handoffDraft?.summary || '').trim()) return;
  const incoming = (triggerEntries || []).filter(m => m.eventKind === 'message' && !m.self)
    .slice(-2).map(m => String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean);
  const sent = String(reply || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const summary = [incoming.length ? `收到：${incoming.join('；')}` : '', sent ? `已回复：${sent}` :
    session.sent?.length ? `已发送 ${session.sent.length} 条消息` : '本轮结束，未发送消息'].filter(Boolean).join('；');
  session.handoffDraft = { ...session.handoffDraft, summary };
  session.episodeSummary ||= summary.slice(0, 100);
  session.finishReason ||= summary.slice(0, 300);
  session.summarySource = 'host-fallback';
}
