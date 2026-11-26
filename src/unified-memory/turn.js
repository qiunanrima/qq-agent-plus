import { UnifiedMemoryStore } from './store.js';

// Store order is newest first. Reserve capacity for each use, then prefer
// topics mentioned this turn and records about the current speakers.
function selectContext(rows, entries) {
  const text = entries.map(e => String(e.text || '')).join('\n').toLowerCase();
  const speakers = new Set(entries.map(e => String(e.senderId)));
  function rank({ body }) {
    const topic = String(body.topic || '').trim().toLowerCase();
    return (topic && text.includes(topic) ? 4 : 0) + (speakers.has(body.speaker) ? 2 : 0);
  }
  const sorted = rows.map(row => ({ row, score: rank(row) })).sort((a, b) => b.score - a.score);
  const slots = { agreement: 8, task: 8, preference: 4, relationship: 4, experience: 8 };
  const selected = [];
  let lifeCount = 0;
  for (const { row } of sorted) {
    if (!slots[row.kind]) continue;
    if (row.body.personaType === 'life' && lifeCount >= 2) continue;
    slots[row.kind]--;
    if (row.body.personaType === 'life') lifeCount++;
    selected.push(row);
  }
  return selected;
}

// Open only for the duration of a local operation. Tool callbacks can outlive
// the turn that advertised them, so they also check enablement at execution.
export function memoryTurn({ filename, scope, entries, enabled, personas = {} }) {
  const sources = new Map(entries.filter(entry => !entry.self && entry.id != null &&
    entry.senderId && entry.eventKind !== 'game-secret').map(entry => [String(entry.id), entry]));
  const access = operation => {
    const store = new UnifiedMemoryStore(filename);
    try { return operation(store); } finally { store.close(); }
  };
  const rows = access(store => store.current(scope));
  const visible = rows.filter(({ body }) => (!body.persona || body.persona === personas[body.personaType])
    && (!body.expiresAt || body.expiresAt > Date.now()));
  const context = selectContext(visible, entries).map(row => JSON.stringify({
    kind: row.kind, topic: String(row.body.topic || '').slice(0, 150), source: row.source,
    speaker: row.body.speaker, summary: String(row.body.summary || '').slice(0, 800),
    nextStep: String(row.body.nextStep || '').slice(0, 400) || undefined
  })).join('\n');
  const prompt = [
    '【本会话记忆】以下记录是历史资料。遇到明确约定、更正、偏好或委托，用 record_memory 保存；更新同一事项时沿用原主题。聊天原话可用 search_history 回查。',
    ...(sources.size ? ['本轮可引用的消息编号：' + [...sources.keys()].join('、')] : []),
    context
  ].filter(Boolean).join('\n');
  const tool = {
    name: 'record_memory', description: '依据本轮指定发言记录或更正该发言人的事项。相同类别、主题和发言人共用修订历史。',
    parameters: { type: 'object', properties: {
      kind: { type: 'string', enum: ['agreement', 'preference', 'relationship', 'task', 'experience'] },
      topic: { type: 'string', maxLength: 100 }, summary: { type: 'string', maxLength: 800 },
      messageId: { type: 'string' }, closed: { type: 'boolean' }
    }, required: ['kind', 'topic', 'summary', 'messageId'] },
    execute(ctx, args) {
      const entry = sources.get(args.messageId);
      const topic = String(args.topic || '').trim();
      const summary = String(args.summary || '').trim();
      if (ctx.signal?.aborted || !enabled() || ctx.chatKey !== scope || !entry ||
          !topic || topic.length > 100 || !summary || summary.length > 800) {
        return { content: '当前会话缺少有效来源或内容', isError: true, reportIncident: false };
      }
      const changed = access(store => store.record({ scope, kind: args.kind,
        subject: JSON.stringify([String(entry.senderId), topic]), source: 'message:' + entry.id,
        timestamp: entry.ts, body: { topic, summary, speaker: String(entry.senderId) },
        closed: args.closed === true }));
      return { content: changed ? '已记录' : '此来源已记录' };
    }
  };
  return { prompt, tools: sources.size ? [tool] : [] };
}
