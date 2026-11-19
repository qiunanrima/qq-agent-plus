import { formatQuoteRef } from '../core/util.js';

export const emotionDimensions = ['愉悦', '悲伤', '愤怒', '精力', '安全感', '孤独感'];
const interactionRules = [
  ['冲突', /你真烦|讨厌你|滚开|你别怼|你怎么老怼|说话太冲|你太过分|你这样让我不舒服/],
  ['安慰', /别怕|不怕不怕|有我在|陪着你|我陪你|我在呢|(?:^|[，。！!\s])没事的/],
  ['道歉', /对不起|抱歉|我不该|刚才是我不好/],
  ['称赞', /(?:^|[，。！!\s])谢谢(?:[啊呀啦哈你]|$|[，。！!~～])|谢谢你|感谢你|(?:^|[，。！!\s])多谢|辛苦了|你(?:真|好|很|太)(?:棒|厉害|可爱|贴心|靠谱)|喜欢你这样|做得(?:好|不错)/],
  ['一起追番', /(?:明天|下次).{0,16}(?:追番|动漫|第.{1,4}集)/],
  ['一起游戏', /(?:明天|下次).{0,16}(?:游戏|开黑|打两局)/],
  ['分享音乐', /(?:明天|下次).{0,16}(?:听歌|分享.{0,4}歌)/],
  ['邀约', /下次.{0,12}(一起|聊)|明天.{0,12}(一起|再聊)/],
  ['回应邀约', /上次说的|昨天约的|接着聊/]
];
const ruleDeltas = {
  '安慰': [4, -4, -2, 0, 9, -7],
  '道歉': [1, -1, -4, 0, 4, -2],
  '称赞': [8, -2, 0, 0, 5, -4],
  '冲突': [-7, 4, 9, -2, -5, 2],
  '回应邀约': [3, 0, 0, 0, 2, -2]
};
const hour = 3600000;

const media = /\[(?:CQ:[^\]]+|图片|QQ表情\d*[^\]\r\n]*|表情包?|视频|语音|文件[^\]\r\n]*)\]/gi;
const quoteStart = /^\[引用(?:#-?\d+(?:·[^：\]]*)?|[^：\]\[]*)：/;

export function readInteraction(value, reply) {
  let text = typeof value === 'string' ? value.trim() : '';
  const prefix = formatQuoteRef(reply);
  let quoted = '';
  if (typeof reply?.bodyText === 'string') {
    quoted = prefix;
    text = reply.bodyText;
  } else if (prefix && text.startsWith(prefix)) {
    quoted = prefix;
    text = text.slice(prefix.length);
  } else {
    text = text.replace(/^(?:\[引用消息\]\s*)+/, '');
    if (quoteStart.test(text)) {
      // Archive-only previews have no escaping for literal brackets. Recognize
      // media placeholders, and abstain if any other bracket obscures the boundary.
      const withoutMedia = text.replace(media, match => ' '.repeat(match.length));
      const end = withoutMedia.indexOf(']', 1);
      if (end < 0 || withoutMedia.slice(1, end).includes('[') || withoutMedia.slice(end + 1).includes(']')) {
        return { text: '', kind: '互动', quoted: '', ambiguous: true };
      }
      quoted = text.slice(0, end + 1);
      text = text.slice(end + 1);
    }
  }
  const body = text.replace(media, '').trim();
  text = /[\p{L}\p{N}]/u.test(body) ? body : '';
  const kind = text ? interactionRules.find(([, rule]) => rule.test(text))?.[0] || '文字互动' : '互动';
  return { text, kind, quoted, ambiguous: false };
}

export function interactionText(value, reply) {
  return readInteraction(value, reply).text;
}

export function interactionKind(value, reply) {
  return readInteraction(value, reply).kind;
}

export function verifiedEmotionDelta(value) {
  const raw = Array.isArray(value) ? value
    : value && typeof value === 'object' ? emotionDimensions.map(name => value[name]) : [];
  if (raw.length !== emotionDimensions.length || !raw.every(Number.isFinite)) return [];
  return raw.map(score => Math.max(-15, Math.min(15, Math.round(score))));
}

export function interactionAdjustments(rows, now) {
  const adjustment = Array(emotionDimensions.length).fill(0);
  const socialSlots = new Set();
  const matchedPerSlot = new Map();
  for (const row of rows) {
    const age = Math.max(0, now - row.at);
    const weight = Math.exp(-age / (4 * hour));
    const semantic = row.delta ? verifiedEmotionDelta(JSON.parse(row.delta)) : [];
    const delta = semantic.length ? semantic : ruleDeltas[row.kind];
    if (delta?.some(Boolean)) {
      const key = JSON.stringify([row.chat, row.actor, row.kind, Math.floor(row.at / (15 * 60000))]);
      const times = matchedPerSlot.get(key) || 0;
      if (times < 2) delta.forEach((value, index) => { adjustment[index] += value * weight; });
      matchedPerSlot.set(key, times + 1);
    }
    if (row.kind === '互动') continue;
    const slot = Math.floor(row.at / (30 * 60000));
    if (!socialSlots.has(slot)) {
      socialSlots.add(slot);
      adjustment[5] -= 2 * weight;
    }
  }
  return adjustment;
}
