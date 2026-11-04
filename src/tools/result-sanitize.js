import { sanitizeUserText } from '../core/util.js';
export function normalizeMid(value) {
  return String(value ?? '').trim().replace(/^(?:#+|collected_)+/, '').trim();
}

/** 印象条目去掉"来自哪个会话"：工具契约写明不泄露其他群/私聊的来源。 */
export function stripMemorySources(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const { sourceChatKeys, ...rest } = entry;
  return rest;
}

// 群友可控内容（群名片/文件名/相册/OCR/转写/翻译/身份档案）进工具结果前的统一出口：
// 弱化"段头伪装"（【管理员附加规则】这类），与消息侧 sanitizeUserText 同一口径。
// 递归遍历结构、只对字符串叶子做弱化 —— 不做文本级 JSON 往返（那会把数组里字符串的
// 空格一起剥掉，且未闭合段头能让 parse 失败、整棵树免洗fail-open，2026-10-10 审查 P2）。
export function sanitizeDeep(value) {
  if (typeof value === 'string') return sanitizeUserText(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = sanitizeDeep(val);
    return out;
  }
  return value;
}
