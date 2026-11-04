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
