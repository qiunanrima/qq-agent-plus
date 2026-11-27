import { isLiveMemorySource, UnifiedMemoryStore } from './store.js';

function memoryIndex({ id, kind, source, body }) {
  return { id, kind, source, topic: String(body.topic || '').slice(0, 100),
    summary: String(body.summary || '').slice(0, 160) };
}

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
  const platformSources = new Map();
  for (const entry of sources.values()) {
    if (entry.mid == null || entry.mid === '') continue;
    const key = String(entry.mid);
    platformSources.set(key, platformSources.has(key) ? null : entry);
  }
  const access = operation => {
    const store = new UnifiedMemoryStore(filename);
    try { return operation(store); } finally { store.close(); }
  };
  const visibleNow = () => access(store => store.current(scope)).filter(({ body, source }) =>
    isLiveMemorySource(source)
    && (!body.persona || body.persona === personas[body.personaType]) && (!body.expiresAt || body.expiresAt > Date.now()));
  const visible = visibleNow();
  const context = [];
  let remaining = 1600;
  for (const row of selectContext(visible, entries)) {
    const { id, kind, topic, summary } = memoryIndex(row);
    const line = JSON.stringify([id, kind, topic, summary === topic ? '' : summary]);
    if (line.length + 1 > remaining) continue;
    context.push({ id, line });
    remaining -= line.length + 1;
  }
  // Rank for inclusion, then serialize in stable record order across turns.
  context.sort((a, b) => a.id - b.id);
  const instructions = [
    '【本会话记忆】历史摘要。原话查 search_history，相关记忆查 lookup_memory；具体时间、地点、任务状态或更新先用 read_memory 读全文。',
    ...(sources.size ? ['明确约定、更正、偏好或委托用 record_memory 保存，更新沿用原主题。summary 写摘要，detail 留全细节，成功后再确认。'] : []),
  ].join('\n');
  const sourceIds = sources.size ? '本轮可引用的消息编号：' + [...sources.keys()].join('、') : '';
  const legend = '每行依次为编号、类别、主题、摘要（空表示同主题）。';
  const prompt = [instructions, context.length && legend, ...context.map(record => record.line), sourceIds]
    .filter(Boolean).join('\n');
  function lifecyclePrompt(previous) {
    const records = Object.fromEntries(context.map(({ id, line }) => [id, line]));
    const removed = Object.keys(previous?.records || {}).filter(id => !Object.hasOwn(records, id));
    const changed = context.filter(({ id, line }) => previous?.records?.[id] !== line);
    const text = [
      previous ? '' : instructions + '\n本轮及后续摘要按编号更新。仅最新一轮列出的消息编号可用于保存。',
      removed.length && '退出当前召回的编号（不再作为当前依据）：' + removed.join('、'),
      changed.length && legend,
      ...changed.map(record => record.line),
      sourceIds
    ].filter(Boolean).join('\n');
    return { text, state: { records } };
  }
  const tool = {
    name: 'record_memory', description: '依据本轮指定发言记录或更正该发言人的事项。相同类别、主题和发言人共用修订历史。',
    parameters: { type: 'object', properties: {
      kind: { type: 'string', enum: ['agreement', 'preference', 'relationship', 'task', 'experience'] },
      topic: { type: 'string', maxLength: 100 }, summary: { type: 'string', maxLength: 800 },
      detail: { type: 'string', maxLength: 8000, description: '完整内容。更新时合并需要保留的旧细节。' },
      messageId: { type: 'string', description: '优先使用本轮列出的本地消息编号，也支持本轮的 QQ 消息 ID' },
      closed: { type: 'boolean' }
    }, required: ['kind', 'topic', 'summary', 'messageId'] },
    execute(ctx, args) {
      const entry = sources.get(args.messageId) || platformSources.get(args.messageId);
      const topic = String(args.topic || '').trim();
      const summary = String(args.summary || '').trim();
      const detail = typeof args.detail === 'string' ? args.detail.trim() : '';
      if (ctx.signal?.aborted || !enabled() || ctx.chatKey !== scope ||
          !topic || topic.length > 100 || !summary || summary.length > 800 || detail.length > 8000) {
        return { content: '当前会话缺少有效来源或内容', isError: true, reportIncident: false };
      }
      if (!entry) return { content: '消息编号不属于本轮。请使用本地编号：' + [...sources.keys()].join('、'),
        isError: true, reportIncident: false };
      const speaker = String(entry.senderId);
      const reviewed = visible.find(row => row.subject.startsWith('reviewed:') && row.kind === args.kind &&
        row.body.speaker === speaker && row.body.topic === topic);
      const changed = access(store => store.record({ scope, kind: args.kind,
        subject: reviewed?.subject || JSON.stringify([personas.memory || '', speaker, topic]), source: 'message:' + entry.id,
        timestamp: entry.ts, body: { topic, summary, detail: detail || undefined, speaker: String(entry.senderId),
          persona: personas.memory, personaType: 'memory' },
        closed: args.closed === true }));
      return { content: changed ? '已记录' : '此来源已记录' };
    }
  };
  const lookup = {
    name: 'lookup_memory', description: '按主题、正文或产物位置查询本会话当前有效的记忆，返回记录来源。',
    parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 160 } }, required: ['query'] },
    execute(ctx, args) {
      const query = String(args.query || '').trim().toLowerCase();
      if (!enabled() || ctx.signal?.aborted || ctx.chatKey !== scope || !query || query.length > 160) {
        return { content: '无法执行本次记忆查询', isError: true, reportIncident: false };
      }
      const found = visibleNow().filter(({ body }) => [body.topic, body.summary, body.detail, body.file, body.nextStep]
        .some(value => typeof value === 'string' && value.toLowerCase().includes(query)));
      return { content: JSON.stringify(found.slice(0, 12).map(memoryIndex)) };
    }
  };
  const read = {
    name: 'read_memory', description: '按摘要或查询返回的 id 读取当前会话的一条记忆全文。',
    parameters: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] },
    execute(ctx, { id }) {
      const row = enabled() && !ctx.signal?.aborted && ctx.chatKey === scope &&
        visibleNow().find(row => row.id === id);
      if (!row) return { content: '没有找到可读的当前记忆，请重新查询。', isError: true, reportIncident: false };
      return { content: JSON.stringify({ id: row.id, kind: row.kind, source: row.source, ...row.body }) };
    }
  };
  return { prompt, lifecyclePrompt, tools: sources.size ? [tool, lookup, read] : [lookup, read] };
}
