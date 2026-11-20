import { memoryDay } from '../memory/hippocampus.js';
import { createHash } from 'node:crypto';
import { shanghaiDayStart, sanitizeUserText } from '../core/util.js';

const hour = 3600000;
const day = 24 * hour;
const sensitive = /密码|口令|验证码|密钥|token|api[ _-]?key|access[ _-]?key|身份证|银行卡|详细地址/i;
const future = /(?:周|星期|礼拜)[一二三四五六日天]|打算|计划|准备|改天|下次|回头|以后再|稍后|待会|明[天早晚]|后天|今[晚夜]|(?:等|待).{1,22}(?:结束|完|之后|以后|时)|(?:上午|下午|晚上)?[0-9]{1,2}[点时]/;
const action = /发|转|给|带|分享|追番|看|开黑|玩|游戏|听|聊|挑|选|做|写|画|整理|查|找|买|确认|回复|记得|提醒|提交|更新|修复|告诉/;
const owner = /一起|我(?:要|来|会|想|打算|负责|给你|帮你|再|明[天早晚]|下次)|我们|你(?:来|记得|会|帮|给|把|明[天早晚]|下次)|咱(?:俩|们)|答应|约好|记得|(?:发|给|带|告诉|提醒|回复)(?:我|你)|帮我|把/;
const topics = [
  { match: /歌|音乐|曲子|曲目|歌单|那首/, cue: /歌|音乐|曲子|曲目|歌单|那首/, subject: '歌曲', title: '把约好的歌发给对方' },
  { match: /追番|动漫|剧集|第.{1,4}集/, cue: /追番|动漫|剧集|第.{1,4}集|哪一集|那[部一]?番/, subject: '番剧', title: '继续聊约好的剧集' },
  { match: /游戏|开黑|打两局|一起玩/, cue: /游戏|开黑|打两局|一起玩|那局/, subject: '游戏', title: '接续游戏邀约' },
  { match: /照片|相片/, cue: /照片|相片|那张/, subject: '照片', title: '处理约好的照片' }
];
const recallCue = /(?:昨天|前天|上次|先前|上回|之前).{0,12}(?:说的|约的|答应|那首|那件|那个约定)|(?:问|说).{0,6}(?:约定|答应的)|还记得.{0,12}(?:约|答应)/;
const completion = /已经|已发|发了|收到了|完成|挑完|弄完|搞定|取消|不用|不必/;
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const clean = value => sanitizeUserText(String(value || '')).replace(/\s+/g, ' ').trim();

export function commitmentEvidence(text, at) {
  const quote = clean(text);
  if (!quote || quote.length > 180 || sensitive.test(quote) || /(?:不想|不打算|不用|不必|取消|别再)/.test(quote)) return null;
  const taskWords = quote.replace(/(?:看看|你看|我看|看起来)(?=.{0,8}(?:变了|不一样|不同)).*/g, '');
  if (!taskWords.split(/[。；;！？!?\n]/).some(clause => future.test(clause) && owner.test(clause) && action.test(clause))) return null;
  const topic = topics.find(item => item.match.test(taskWords));
  const due = agreementTime(quote, at);
  return { quote, topic, due };
}

export function agreementTime(text, at, previous = null) {
  const week = /(下下|下|这|本)?(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(text);
  const offset = /后天/.test(text) ? 2 : /明[天早晚]/.test(text) ? 1 : /今[天早晚夜]/.test(text) ? 0 : null;
  const time = /(?:(上午|早上|下午|晚上|中午|晚))?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})(?:点|时|[:：](?=\d{2}))(半|\d{1,2}分?)?/.exec(text);
  if (!week && offset === null && !time) return null;
  const base = shanghaiDayStart(at);
  const weekday = (new Date(base + 8 * hour).getUTCDay() + 6) % 7;
  let days = offset ?? 0;
  if (week) {
    const target = '一二三四五六日'.indexOf(week[2].replace('天', '日'));
    days = target - weekday + ({ 下: 7, 下下: 14 }[week[1]] || 0);
    if (!week[1] && previous && previous > at) {
      const oldDay = shanghaiDayStart(previous);
      const oldWeekday = (new Date(oldDay + 8 * hour).getUTCDay() + 6) % 7;
      days = Math.round((oldDay - base) / day) - oldWeekday + target;
    }
    if (days < 0 && !week[1]) days += 7;
  }
  const prev = previous && new Date(previous + 8 * hour);
  let hours = /晚/.test(text) ? 19 : prev ? prev.getUTCHours() : 9;
  let minutes = prev ? prev.getUTCMinutes() : 0;
  if (time) {
    const num = ch => '零一二三四五六七八九'.indexOf(ch.replace('两', '二'));
    const raw = time[2];
    hours = /^\d+$/.test(raw) ? Number(raw) : raw.includes('十')
      ? (raw.startsWith('十') ? 1 : num(raw[0])) * 10 + (raw.endsWith('十') ? 0 : num(raw.at(-1))) : num(raw);
    if (/下午|晚|中午/.test(time[1] || '') && hours < 12) hours += 12;
    minutes = time[3] === '半' ? 30 : parseInt(time[3] || '0', 10);
    if (hours < 0 || hours > 23 || minutes > 59) return null;
  }
  let due = base + days * day + hours * hour + minutes * 60000;
  if (!week && offset === null && due <= at) due += day;
  return due > at ? due : null;
}

export function initMotiveEvidence(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS motive_evidence(
    event TEXT PRIMARY KEY REFERENCES motives(event) ON DELETE CASCADE, topic TEXT NOT NULL, due INTEGER);
    CREATE TABLE IF NOT EXISTS motive_changes(
      event TEXT REFERENCES motives(event) ON DELETE CASCADE, source TEXT, previous_due INTEGER, due INTEGER, quote TEXT,
      PRIMARY KEY(event,source));
    CREATE TABLE IF NOT EXISTS motive_reminders(
      event TEXT REFERENCES motives(event) ON DELETE CASCADE, signal TEXT, PRIMARY KEY(event,signal));
    CREATE TABLE IF NOT EXISTS motive_invalidations(
      event TEXT PRIMARY KEY REFERENCES motives(event) ON DELETE CASCADE);`);
}

export function quoteOnlyMotive(reason, interaction, at) {
  if (!reason || !interaction.quoted) return false;
  const evidence = clean(reason);
  const body = clean(interaction.text);
  const quote = clean(interaction.quoted);
  if (!evidence || body.includes(evidence)) return false;
  return quote.includes(evidence) || (evidence.includes(quote) && !commitmentEvidence(body, at));
}

export function saveMotive(db, event, evidence, motive) {
  const alreadyOpen = db.prepare(`SELECT 1 FROM events source
    JOIN events earlier ON earlier.role=source.role AND earlier.chat=source.chat AND earlier.actor=source.actor
    JOIN motives m ON m.event=earlier.id JOIN motive_evidence p ON p.event=m.event
    WHERE source.id=? AND earlier.id<>source.id AND m.closed IS NULL AND m.expires>=source.at AND m.reason=? AND p.due IS ?
      AND NOT EXISTS (SELECT 1 FROM motive_invalidations i WHERE i.event=m.event)`)
    .get(event.id, evidence.quote, evidence.due);
  if (alreadyOpen) return false;
  const expires = Math.max(event.at + motive.duration, (evidence.due || 0) + 2 * hour);
  const found = db.prepare('INSERT OR IGNORE INTO motives(event,title,reason,condition,expires,cooldown) VALUES(?,?,?,?,?,?)')
    .run(event.id, motive.title, motive.reason, motive.condition, expires, motive.cooldown);
  if (!found.changes && db.prepare('SELECT 1 FROM motive_evidence WHERE event=?').get(event.id)) return false;
  if (!found.changes) {
    db.prepare('UPDATE motives SET title=?,reason=?,condition=?,expires=?,cooldown=?,closed=NULL WHERE event=?')
      .run(motive.title, motive.reason, motive.condition, expires, motive.cooldown, event.id);
  }
  db.prepare('INSERT INTO motive_evidence VALUES(?,?,?)').run(event.id, evidence.topic?.subject || motive.topic || '', evidence.due);
  return true;
}

export function saveRecognizedMotive(db, event, text) {
  const evidence = commitmentEvidence(text, event.at);
  if (!evidence?.topic) return;
  const { topic } = evidence;
  const isSongDelivery = topic.subject === '歌曲' && /发|给|分享/.test(evidence.quote);
  const title = topic.subject === '歌曲' && !isSongDelivery ? '接续一起听歌的约定' : topic.title;
  saveMotive(db, event, evidence, {
    title, reason: evidence.quote, condition: isSongDelivery ? '确认歌曲已发给约定对象' : '双方确认这项约定已经完成',
    duration: 3 * day, cooldown: 8 * hour
  });
}

function mentionsTopic(goal, text) {
  const topic = topics.find(item => item.subject === goal.topic);
  const key = normalize(goal.topic);
  return Boolean(topic?.cue.test(text) || (key.length >= 2 && normalize(text).includes(key)));
}

export function confirmsMotive(goal, text) {
  return completion.test(text) && mentionsTopic(goal, text);
}

export function summaryForGoal(goal, summaries) {
  const quote = normalize(goal.reason || '');
  if (!quote) return '';
  const matches = summaries.filter(row => row.day === memoryDay(goal.at) && row.people.some(person => String(person.id) === goal.actor)
    && normalize(row.summary).includes(quote));
  return matches.length === 1 ? matches[0].reference : '';
}

export function reminderForTurn(db, goals, entries, goalId, now, summaries = []) {
  if (!goals.length) return '';
  const get = db.prepare('SELECT 1 FROM motive_reminders WHERE event=? AND signal=?');
  const note = db.prepare('INSERT OR IGNORE INTO motive_reminders VALUES(?,?)');
  const candidates = [];
  for (const { entry, text: body } of entries) {
    const text = clean(body);
    const normalized = normalize(text);
    if (!normalized || sensitive.test(text) || commitmentEvidence(text, now)) continue;
    const owned = goals.filter(goal => goal.actor === String(entry.senderId) && goal.id !== goalId(entry)
      && (!entry.ts || Number(entry.ts) > goal.at));
    const relativeDay = /昨天/.test(text) ? 1 : /前天/.test(text) ? 2 : 0;
    const recalledDay = shanghaiDayStart(now) - relativeDay * day;
    const relevantDay = goal => !relativeDay || shanghaiDayStart(goal.at) === recalledDay;
    for (const goal of owned) {
      const direct = relevantDay(goal) && (mentionsTopic(goal, text) || (owned.length === 1 && recallCue.test(text)));
      const due = goal.due !== null && now >= goal.due && now < goal.due + 2 * hour;
      const signal = direct ? 'cue:' + createHash('sha256').update(normalized).digest('hex') : due ? 'due' : '';
      if (signal && !get.get(goal.id, signal)) candidates.push({ goal, signal, direct, due });
    }
  }
  const match = candidates.find(item => item.direct) || candidates[0];
  if (!match || !note.run(match.goal.id, match.signal).changes) return '';
  if (match.direct && match.due) note.run(match.goal.id, 'due');
  const reference = summaryForGoal(match.goal, summaries);
  if (reference) return `当前会话海马的${reference}中的约定${match.due ? '已到时间' : '被对方再次提起'}，可接续该话题。`;
  const quote = match.goal.reason.replace(/[<>「」]/g, '');
  const scheduled = match.goal.due ? new Date(match.goal.due).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
  return `相关的历史约定（仅供参考）：${match.goal.title}。${scheduled ? `当前约定时间：${scheduled}。` : ''}对方原话「${quote}」。`;
}
