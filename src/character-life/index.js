import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR, getConfig } from '../core/config.js';
import { personaKeyOf, personaStateSnapshot } from '../core/persona-state.js';
import { minuteOfDayInZone, shanghaiDayStart } from '../core/util.js';
import { openDatabase } from '../core/sqlite.js';

const file = path.join(DATA_DIR, 'character-life.sqlite');
const hour = 3600000;
const day = 24 * hour;
const signals = [
  ['安慰', /别怕|陪着你|安慰你/],
  ['称赞', /你真棒|你好厉害|谢谢你/],
  ['冲突', /你真烦|讨厌你|滚开/],
  ['一起追番', /(?:明天|下次).{0,16}(?:追番|动漫|第.{1,4}集)/],
  ['一起游戏', /(?:明天|下次).{0,16}(?:游戏|开黑|打两局)/],
  ['分享音乐', /(?:明天|下次).{0,16}(?:听歌|分享.{0,4}歌)/],
  ['邀约', /下次.{0,12}(一起|聊)|明天.{0,12}(一起|再聊)/],
  ['回应邀约', /上次说的|昨天约的|接着聊/]
];
const goals = { '邀约': '继续上次的约定', '一起追番':'继续聊约好的剧集', '一起游戏':'赴上次的游戏邀约', '分享音乐':'分享之前聊到的歌' };
function rhythm(minute) {
  const schedule = getConfig().humanize?.personaState || {};
  const minutes = value => {
    const [h,m] = value.split(':').map(Number);
    return h * 60 + m;
  };
  const start = minutes(schedule.sleepStart || '00:00');
  const end = minutes(schedule.sleepEnd || '07:00');
  const trough = start + ((end - start + 1440) % 1440) / 2;
  return Math.round(55 - 30 * Math.cos((minute - trough) * Math.PI / 720));
}
function summarize(rows, now, legacy) {
  let comfort = 0, tension = 0;
  for (const row of rows) {
    const weight = Math.exp(-Math.max(0, now - row.at) / (4 * hour));
    if (['称赞','安慰','回应邀约'].includes(row.kind)) comfort += weight;
    if (row.kind === '冲突') tension += weight;
  }
  const bound = value => Math.max(0, Math.min(100, Math.round(value)));
  const energy = legacy.energy ?? rhythm(minuteOfDayInZone(now));
  const mood = (legacy.mood || 0) / 3;
  return { '愉悦': bound(50 + mood + 8 * comfort - 9 * tension), '悲伤': bound(10 + 6 * tension - 3 * comfort),
    '愤怒': bound(5 + 12 * tension), '精力': energy, '安全感': bound(65 + 6 * comfort - 9 * tension),
    '孤独感': bound(22 - 4 * comfort) };
}
function activeGoals(db, role, now, chat = null) {
  const kinds = [...Object.keys(goals), '回应邀约'];
  const scope = chat === null ? '' : ' AND chat=?';
  const rows = db.prepare(`SELECT * FROM events WHERE role=? AND at BETWEEN ? AND ?
    AND kind IN (${kinds.map(() => '?').join(',')})${scope} ORDER BY at DESC,rowid DESC`)
    .all(role, now - 3 * day, now, ...kinds, ...(chat === null ? [] : [chat]));
  const seen = new Set();
  return rows.filter(row => {
    const scope = JSON.stringify([row.chat,row.actor]);
    if (seen.has(scope)) return false;
    seen.add(scope);
    return Boolean(goals[row.kind]);
  }).map(row => ({ ...row, title: goals[row.kind], strength: Math.round(85 * Math.exp(-(now - row.at) / (3 * day))) }));
}
function recent(db, role, now) {
  return db.prepare('SELECT * FROM events WHERE role=? AND at>=? ORDER BY at DESC,rowid DESC LIMIT 512').all(role,now - 7 * day);
}
export function observeLife({ persona, chatKey, triggerEntries = [], recalled = [], now = Date.now() }) {
  if (!getConfig().characterLife?.enabled || !triggerEntries?.length) return '';
  const role = personaKeyOf(persona);
  const db = openDatabase(file);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,role TEXT, chat TEXT, actor TEXT, at INTEGER, kind TEXT);
      CREATE TABLE IF NOT EXISTS initiatives(event TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS reflections(role TEXT, date TEXT, kind TEXT, count INTEGER,PRIMARY KEY(role,date,kind));
      CREATE INDEX IF NOT EXISTS role_time ON events(role,at);
      CREATE TABLE IF NOT EXISTS links(event TEXT REFERENCES events(id) ON DELETE CASCADE,memory TEXT,PRIMARY KEY(event,memory));
      BEGIN IMMEDIATE`);
    for (const entry of triggerEntries) {
      if (entry.self || !entry.senderId || !(entry.id || entry.messageId || entry.ts)) continue;
      const actor = String(entry.senderId);
      const id = createHash('sha256').update(JSON.stringify([role,chatKey,actor,entry.id || entry.messageId || [entry.ts,entry.text]])).digest('hex');
      const kind = signals.find(([,rule]) => rule.test(String(entry.text || '')))?.[0] || '互动';
      const at = Number(entry.ts) || now;
      if (at < now - 7 * day) continue;
      const inserted = db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?)').run(id,role,chatKey,actor,Math.min(at,now),kind);
      if (inserted.changes) for (const item of recalled || []) {
        if (item.id) db.prepare('INSERT OR IGNORE INTO links VALUES(?,?)').run(id,String(item.id));
      }
    }

    db.exec('COMMIT');
    const rows = recent(db,role,now);
    const mood = summarize(rows,now,personaStateSnapshot(persona,now));
    const goal = activeGoals(db, role, now, chatKey).find(row => triggerEntries.some(entry => String(entry.senderId) === row.actor));
    return [mood['精力'] < 40 ? '这会儿容易困，语气可以轻一些。' : '', mood['愤怒'] > 15 ? '此刻有点不快。' : mood['愉悦'] > 56 ? '此刻心情轻快。' : '', goal ? '这个会话里有个近期邀约：'+goal.title+'。话题合适时可以接续。' : ''].filter(Boolean).join(' ');
  } finally { db.close(); }
}
export function lifeStatus(now = Date.now()) {
  const cfg = getConfig();
  const db = fs.existsSync(file) ? openDatabase(file,{ readOnly:true }) : null;
  try {
    const roles = db ? db.prepare('SELECT DISTINCT role FROM events ORDER BY role').all().map(row => row.role) : [];
    const profiles = roles.map(role => {
      const rows = recent(db,role,now);
      const legacy = personaStateSnapshot({templateId:role},now);
      const associations = db.prepare('SELECT e.chat,e.actor,l.memory,count(*) AS count FROM links l JOIN events e ON e.id=l.event WHERE e.role=? AND e.at>=? GROUP BY e.chat,e.actor,l.memory ORDER BY count DESC LIMIT 20').all(role,now - 7 * day);
      const reflections = db.prepare('SELECT date,kind,count FROM reflections WHERE role=? ORDER BY date DESC,count DESC LIMIT 16').all(role);
      return { role, reflections, dimensions:summarize(rows,now,legacy), goals:activeGoals(db, role, now), associations, events:rows.slice(0,24) };
    });
    return { enabled: cfg.characterLife?.enabled === true, profiles, rhythm:Array.from({length:24},(_,h)=>rhythm(h*60)) };
  } finally { db?.close(); }
}
export function linkedMemories(persona, chat, ids) {
  if (!ids.length || !fs.existsSync(file) || !getConfig().characterLife?.enabled) return [];
  const db = openDatabase(file,{readOnly:true});
  try {
    const seed = ids.slice(0,12);
    return db.prepare(`SELECT b.memory,COUNT(*) AS hits FROM events e JOIN links a ON a.event=e.id JOIN links b ON b.event=e.id
      WHERE e.role=? AND e.chat=? AND e.at>=? AND a.memory IN (${seed.map(()=>'?').join(',')}) AND b.memory<>a.memory
      GROUP BY b.memory ORDER BY hits DESC LIMIT 12`).all(personaKeyOf(persona),chat,Date.now()-7*day,...seed).map(row=>row.memory);
  } finally { db.close(); }
}

export function claimInitiative(persona, chat, now = Date.now()) {
  if (!getConfig().characterLife?.enabled || !fs.existsSync(file) || rhythm(minuteOfDayInZone(now)) < 40) return '';
  const db = openDatabase(file);
  try {
    db.exec('BEGIN IMMEDIATE');
    const claimed = db.prepare('SELECT 1 FROM initiatives WHERE event=?');
    const goal = activeGoals(db, personaKeyOf(persona), now, chat)
      .find(row => now - row.at >= 8 * hour && !claimed.get(row.id));
    const inserted = goal && db.prepare('INSERT OR IGNORE INTO initiatives VALUES(?)').run(goal.id).changes;
    db.exec('COMMIT');
    if (!inserted) return '';
    return '本次主动聊天可以接续此前的邀约：'+goal.title+'。';
  } finally { db.close(); }
}

export function reflectLife(now = Date.now()) {
  if (!getConfig().characterLife?.enabled || !fs.existsSync(file)) return;
  const db = openDatabase(file);
  try {
    db.exec('BEGIN IMMEDIATE');
    const today = shanghaiDayStart(now);
    db.prepare(`INSERT OR REPLACE INTO reflections SELECT role,date(at/1000,'unixepoch','+8 hours'),kind,count(*)
      FROM events WHERE at>=? AND at<? GROUP BY role,date(at/1000,'unixepoch','+8 hours'),kind`).run(today - 6 * day, today);
    db.prepare("DELETE FROM reflections WHERE date < date(?/1000,'unixepoch','+8 hours','-30 days')").run(now);
    db.prepare('DELETE FROM events WHERE at<?').run(now-7*day);
    db.exec('COMMIT');
  } finally { db.close(); }
}
export function backupLife(directory, dataDir) {
  const source = path.join(dataDir,'character-life.sqlite');
  if (!fs.existsSync(source)) return;
  const db = openDatabase(source);
  try { db.prepare('VACUUM INTO ?').run(path.join(directory,'character-life.sqlite')); }
  finally { db.close(); }
}
export function clearLife(dataDir) {
  const source = path.join(dataDir,'character-life.sqlite');
  if (!fs.existsSync(source)) return;
  const db = openDatabase(source);
  try { db.exec('BEGIN IMMEDIATE; DELETE FROM events; DELETE FROM reflections; COMMIT'); }
  finally { db.close(); }
}
