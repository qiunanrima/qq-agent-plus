import { idList } from './list.js';
import { privateInitiativeAllowed } from './private-proactive-policy.js';
import { getConfig } from './config.js';
import { minuteOfDayInZone } from './util.js';

function followUpPlan({
  sentCount = 0, unread = 0, lastFollowUpAt = 0, hasScheduledWake = false,
  windowActive = true, followUpEnabled = true, now = Date.now(), random = Math.random,
  followUpDelayMinutes = 10, followUpCooldownMinutes = 20
} = {}) {
  if (!followUpEnabled) return { schedule: false, reason: '补话开关已关闭' };
  if (!sentCount) return { schedule: false, reason: '本轮没发言' };
  if (unread > 0) return { schedule: false, reason: '有人刚说话，走正常回复' };
  if (hasScheduledWake) return { schedule: false, reason: '已有唤醒安排' };
  if (!windowActive) return { schedule: false, reason: '不在可主动发言的时段' };
  const base = Math.max(1, Number(followUpDelayMinutes) || 10);
  // 冷却必须长于「实际补话延迟 + 最大抖动」，否则把 delay 调大后条件恒成立，会无限补话。
  const cooldownMs = Math.max((base + 3) * 60000, (Number(followUpCooldownMinutes) || 20) * 60000);
  if (now - Number(lastFollowUpAt || 0) < cooldownMs) {
    return { schedule: false, reason: `${Math.round(cooldownMs / 60000)} 分钟内已经给过机会` };
  }
  return { schedule: true, minutes: base + Math.floor(random() * 3), reason: '发言后没人接话' };
}

function activeHoursMinuteOf(value, end = false) {
  if (end && String(value) === '24:00') return 1440;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 解析时间段：支持 {start,end} 或 {windows:[{start,end},…]}；未配置 = 全天。 */
function proactiveWindows(raw) {
  const list = [];
  const push = (w) => {
    const start = activeHoursMinuteOf(w?.start);
    const end = activeHoursMinuteOf(w?.end, true);
    if (start != null && end != null && start !== end) list.push({ start, end });
  };
  if (Array.isArray(raw?.windows)) raw.windows.forEach(push);
  else push(raw);
  return list;
}

/** 现在是否在某个窗口内；不在时给出最近的窗口开始时间。 */
function proactiveWindowState(raw, now) {
  const windows = proactiveWindows(raw);
  if (!windows.length) return { active: true, nextActiveAt: now };
  const minute = minuteOfDayInZone(now);
  let best = null;
  for (const w of windows) {
    const wrap = w.start > w.end;
    const active = wrap ? (minute >= w.start || minute < w.end) : (minute >= w.start && minute < w.end);
    if (active) return { active: true, nextActiveAt: now };
    const delta = minute < w.start ? w.start - minute : 1440 - minute + w.start;
    if (best == null || delta < best) best = delta;
  }
  return { active: false, nextActiveAt: now + best * 60000 };
}


function lastSentText(session) {
  return (session?.sent || [])
    .map((entry) => String(entry?.text || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('；')
    .slice(0, 600);
}

function hasInlineImage(messages) {
  return (messages || []).some((message) => Array.isArray(message?.content)
    && message.content.some((part) => part?.type === 'image_url'
      && String(part?.image_url?.url || '').startsWith('data:')));
}

function imagePartCount(messages) {
  return (messages || []).reduce((total, message) => total + (
    Array.isArray(message?.content)
      ? message.content.filter((part) => part?.type === 'image_url').length
      : 0
  ), 0);
}

function modelMessagesForAudit(messages) {
  return structuredClone(messages || []).map((message) => {
    if (!Array.isArray(message?.content)) return message;
    message.content = message.content.map((part) => {
      const url = String(part?.image_url?.url || '');
      if (part?.type !== 'image_url' || !url.startsWith('data:')) return part;
      const mime = /^data:([^;,]+)/.exec(url)?.[1] || 'application/octet-stream';
      return {
        ...part,
        image_url: {
          ...part.image_url,
          url: `[inline ${mime} omitted from audit snapshot; ${url.length} chars]`
        }
      };
    });
    return message;
  });
}

function estimateNextPromptTokens({
  messages,
  tools,
  previousPromptTokens = 0,
  previousEstimateChars = 0,
  previousImageCount = 0
}) {
  const auditMessages = modelMessagesForAudit(messages);
  const estimateChars = JSON.stringify({ messages: auditMessages, tools }).length;
  const imageCount = imagePartCount(messages);
  const textTokens = previousPromptTokens > 0 && previousEstimateChars > 0
    ? Math.ceil(estimateChars * previousPromptTokens / previousEstimateChars * 1.08)
    : Math.ceil(estimateChars * 0.55);
  // 图片的 base64 字节不是文本 Token。只为本轮新加入的图片预留视觉编码预算；
  // 已存在图片的成本已经包含在上一轮真实 prompt_tokens 比例里。
  const newImages = Math.max(0, imageCount - Math.max(0, Number(previousImageCount) || 0));
  return {
    estimatedPromptTokens: textTokens + newImages * 4096,
    estimateChars,
    imageCount,
    auditMessages
  };
}

// 辅助调用按实际模型在外部台账计价；单次运行预算仍须包含它们，避免重复计入每日台账。
function runTokenUsage(session) {
  return (Number(session.usage?.totalTokens) || 0) + (Number(session.auxiliaryUsage?.totalTokens) || 0);
}


export { followUpPlan, proactiveWindows, proactiveWindowState, lastSentText, hasInlineImage, imagePartCount, modelMessagesForAudit, estimateNextPromptTokens, runTokenUsage };

/**
 * 「冷场开话题」每轮真的发言的概率：0 是合法取值（= 不再随机开话题），别用 `|| 默认值` 把它吞掉；
 * 越界值夹到 [0,1]，非数字才回落到默认 0.25（2026-10-01 审查）。
 */
function proactiveProbability(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.25;
}

/**
 * 冷场开话题的作用范围。默认群聊开、私聊关（与升级前行为一致）；
 * tick 的早退与候选选择共用这一处，避免两处各写一份默认值后漂移。
 */
function proactiveScopes(cfg = {}) {
  return {
    groups: cfg.proactive?.groupEnabled !== false,
    private: cfg.proactive?.privateEnabled === true
  };
}


export { proactiveProbability, proactiveScopes };

export function randomWakeDelay(config = getConfig(), random = Math.random) {
  const legacy = Math.max(0, Number(config?.wakeDelayMs) || 0);
  let min = Number.isFinite(Number(config?.wakeDelayMinMs))
    ? Math.max(0, Number(config.wakeDelayMinMs))
    : legacy;
  let max = Number.isFinite(Number(config?.wakeDelayMaxMs))
    ? Math.max(0, Number(config.wakeDelayMaxMs))
    : legacy;
  if (min > max) [min, max] = [max, min];
  const ratio = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.round(min + (max - min) * ratio);
}

/**
 * 挑出这次"冷场主动开话题"可以去的会话（纯函数，便于单测）。
 *
 * 作用范围由控制台两个复选框决定：
 *   · 群聊（proactive.groupEnabled，默认开）：沿用 allow.groups / allowAllWhenEmpty；
 *   · 私聊（proactive.privateEnabled，默认关）：沿用 allow.private（deny 优先、名单空时看
 *     allowAllWhenEmpty），与平时回复私聊的白名单规则一致，不另建名单。
 */
export function proactiveCandidates({
  chatKeys = [], cfg = {}, metaOf = () => ({}), now = Date.now(),
  canWake = () => true, isRunning = () => false, lastPrivateInitiativeOf = () => 0
} = {}) {
  // 注入点先落本地 const（ops scan --strict 只认 const/let；同 capabilities.js 约定）
  const metaOfFn = metaOf;
  const canWakeFn = canWake;
  const isRunningFn = isRunning;
  const idleMs = Math.max(300000, Number(cfg.proactive?.idleThresholdMs) || 1800000);
  const allowGroups = idList(cfg.allow?.groups);
  const scopes = proactiveScopes(cfg);
  const out = [];
  for (const chatKey of chatKeys) {
    const [kind, id] = String(chatKey).split(':');
    if (kind === 'group') {
      if (!scopes.groups) continue;
      if (allowGroups.length > 0 ? !allowGroups.includes(id) : !cfg.allowAllWhenEmpty) continue;
    } else if (kind === 'private') {
      if (!scopes.private) continue;
      if (!privateInitiativeAllowed(chatKey, cfg, lastPrivateInitiativeOf(chatKey), now)) continue;
    } else {
      continue;
    }
    if (!canWakeFn(chatKey)) continue;
    if (isRunningFn(chatKey)) continue;
    const meta = metaOfFn(chatKey) || {};
    if (meta.unread > 0) continue;
    if (now - (Number(meta.lastTs) || 0) < idleMs) continue;
    out.push(chatKey);
  }
  return out;
}

export function triggerKindForTier(result = {}, {
  manual = false,
  proactive = false,
  chatKey = ''
} = {}) {
  const tier = Number(result?.tier);
  const reason = String(result?.reason || '');
  if (manual) return 'manual';
  if (proactive) return 'proactive';
  if (reason === '私聊' || String(chatKey).startsWith('private:')) return 'private';
  if (tier === 1 || reason === '被艾特') return 'mention';
  if (tier === 2 || reason === '关键词命中') return 'keyword';
  if (tier === 3 || reason.startsWith('随机命中')) return 'probability';
  if (tier === 4 || reason === '全部响应') return 'all';
  if (tier === 5 || /引用机器人/.test(reason)) return 'reply';
  if (tier === 6 || /生命周期：(?:活跃|监听)状态/.test(reason)) return 'lifecycle';
  if (tier === 7 || /硬上限后的任意消息续接/.test(reason)) return 'rollover';
  if (tier === 8 || reason === '失败批次重试') return 'retry';
  return 'unknown';
}

/**
 * 是否该跑一次自动记忆整理（纯函数，便于单测）。
 *
 * 触发规则：
 *   - 一条印象都没有时：**允许跑一次**。整理里的"发现新人"那条路
 *     （发言够多但零印象的人 → 新建印象）正是给这种情况准备的；如果这里也按
 *     "印象数 > 阈值"卡住，新装实例的自动整理就永远不会触发 ——
 *     印象数从 0 开始，永远够不到阈值，于是谁都没有人物记忆。
 *   - 已经有印象时：按阈值来（全群总数超过 minImpressions，或某人超过 maxPerMember）。
 */
export function shouldAutoConsolidate({
  impressionCount = 0,
  memberCounts = [],
  minImpressions = 4,
  maxPerMember = 5
} = {}) {
  const total = Number(impressionCount) || 0;
  if (total <= 0) return true;
  if (total > Math.max(1, Number(minImpressions) || 4)) return true;
  return memberCounts.some((count) => Number(count) > Math.max(2, Number(maxPerMember) || 5));
}

/**
 * 同一份记忆的两条记录合成一条时用（遗留条目反查出的 QQ 与本人记录指向同一个人）：
 * 按正文去重，保留先出现那条的时间戳与来源。
 */
export function mergeImpressionLists(base = [], extra = []) {
  const out = [...(Array.isArray(base) ? base : [])];
  const seen = new Set(out.map((e) => String(e?.content ?? '')));
  for (const entry of Array.isArray(extra) ? extra : []) {
    const content = String(entry?.content ?? '');
    if (!content || seen.has(content)) continue;
    seen.add(content);
    out.push(entry);
  }
  return out;
}
