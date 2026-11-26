import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { triageAccountKey } from './triage-store.js';
import { MAX_REMINDER_TEXT } from '../core/reminders.js';

const interval = 10 * 60000;
const verificationGrace = 2 * interval;
const notifyRetryDelay = 3 * 60000;
const fileName = 'personal-mail-follow-ups.json';

function readJobs(dataDir) {
  try { return JSON.parse(readFileSync(join(dataDir, fileName), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function saveJobs(dataDir, jobs) {
  const target = join(dataDir, fileName);
  writeFileSync(target + '.tmp', JSON.stringify(jobs), { mode: 0o600, flush: true });
  renameSync(target + '.tmp', target);
}

export function manageMailFollowUp(args, { env, dataDir, now = Date.now() }) {
  if (!env.QQ_AGENT_GMAIL_REFRESH_TOKEN) return { error: 'Gmail 尚未配置' };
  const key = triageAccountKey('gmail', env);
  const jobs = readJobs(dataDir);
  const own = jobs.filter(job => job.key === key);
  if (args.action === 'follow_up_list') {
    const pending = own.filter(job => job.status === 'pending').sort((a, b) => a.deadline - b.deadline);
    const history = own.filter(job => job.status !== 'pending').reverse();
    return {
      jobs: [...pending, ...history].slice(0, 20).map(({ key: _, ...job }) => ({
        ...job, source: gmailThreadSource(job.threadId)
      }))
    };
  }
  if (args.action === 'follow_up_cancel') {
    const job = own.find(item => item.id === args.followUpId && item.status === 'pending' && !item.outcome);
    if (!job) return { error: '找不到可取消的跟进' };
    job.status = 'canceled';
    saveJobs(dataDir, jobs);
    return { id: job.id, status: job.status };
  }
  const { threadId, deadline } = args;
  if (args.action === 'follow_up_reschedule') {
    const job = own.find(item => item.id === args.followUpId && item.status === 'pending' && !item.outcome);
    if (!job) return { error: '找不到可改期的跟进' };
    if (!validDeadline(deadline, now)) return { error: '请提供未来 30 天内的新跟进期限' };
    job.deadline = deadline;
    job.nextCheckAt = Math.min(job.nextCheckAt, deadline);
    saveJobs(dataDir, jobs);
    return { id: job.id, status: job.status, deadline, source: gmailThreadSource(job.threadId) };
  }
  if (typeof threadId !== 'string' || !/^[a-z0-9]{1,128}$/i.test(threadId) ||
      !validDeadline(deadline, now)) {
    return { error: '请提供 Gmail 线程编号和未来 30 天内的跟进期限' };
  }
  const duplicate = own.find(job => job.threadId === threadId && job.status === 'pending');
  if (duplicate) return {
    id: duplicate.id, status: duplicate.status, deadline: duplicate.deadline,
    alreadyScheduled: true, source: gmailThreadSource(duplicate.threadId)
  };
  if (jobs.filter(job => job.status === 'pending').length >= 12) return { error: '邮件跟进队列已满' };
  const job = { id: randomUUID(), key, threadId, deadline, nextCheckAt: now, status: 'pending' };
  const history = jobs.filter(item => item.status !== 'pending').slice(-80);
  saveJobs(dataDir, [...history, ...jobs.filter(item => item.status === 'pending'), job]);
  return { id: job.id, status: job.status, deadline, source: gmailThreadSource(job.threadId) };
}

const gmailThreadSource = threadId => 'https://mail.google.com/mail/u/0/#all/' + threadId;

function validDeadline(deadline, now) {
  return Number.isSafeInteger(deadline) && deadline > now && deadline - now <= 30 * 86400000;
}

export async function checkMailFollowUp({ dataDir, env, readThread, notify, now = Date.now(), signal }) {
  if (!env.QQ_AGENT_GMAIL_REFRESH_TOKEN || signal?.aborted) return;
  const key = triageAccountKey('gmail', env);
  const [job] = readJobs(dataDir).filter(item => item.key === key && item.status === 'pending' &&
    (item.outcome ? (item.nextNotifyAt ?? 0) <= now : item.nextCheckAt <= now))
    .sort((a, b) => a.deadline - b.deadline);
  if (!job) return;
  if (!job.outcome) {
    const thread = await readThread({ threadId: job.threadId, limit: 20 }, { env, signal });
    if (signal?.aborted) return;
    const jobs = readJobs(dataDir);
    const current = jobs.find(item => item.id === job.id && item.status === 'pending');
    if (!current) return;
    const messages = thread.messages ?? [];
    const sent = messages.findLastIndex(message => message.direction === 'outgoing');
    const reply = sent >= 0
      ? messages.slice(sent + 1).findLast(message => message.direction === 'incoming' && !message.automatic)
      : null;
    if (reply) current.outcome = { status: 'replied', text: reply.excerpt || reply.subject };
    else if (now >= current.deadline) {
      if (thread.status === 'ok' && sent >= 0) {
        current.outcome = { status: 'due', text: messages[sent].subject };
      } else if (thread.status === 'unavailable' && now < current.deadline + verificationGrace) {
        current.nextCheckAt = Math.min(now + interval, current.deadline + verificationGrace);
      } else {
        current.outcome = { status: 'unverified', text: '' };
      }
    }
    else current.nextCheckAt = Math.min(now + interval, current.deadline);
    saveJobs(dataDir, jobs);
    job.outcome = current.outcome;
  }
  if (!job.outcome || signal?.aborted) return;
  try {
    await notify(job);
  } catch (error) {
    const jobs = readJobs(dataDir);
    const current = jobs.find(item => item.id === job.id && item.status === 'pending');
    if (current) {
      current.nextNotifyAt = now + notifyRetryDelay;
      saveJobs(dataDir, jobs);
    }
    throw error;
  }
  const jobs = readJobs(dataDir);
  const current = jobs.find(item => item.id === job.id && item.status === 'pending');
  if (current) {
    current.status = job.outcome.status;
    delete current.nextNotifyAt;
    saveJobs(dataDir, jobs);
  }
}

export function formatMailFollowUpReminder(job) {
  const { status, text } = job.outcome;
  const fullLead = status === 'replied' ? 'Gmail 收到回复，请转述明确的报价、交期或其他关键信息。摘录：' :
    status === 'due' ? 'Gmail 到期未回，请在私聊拟催办草稿。原主题：' :
      'Gmail 跟进到期，无法核实是否收到回复。';
  const source = ' 来源：https://mail.google.com/mail/u/0/#all/' + job.threadId;
  const lead = fullLead.length + source.length <= MAX_REMINDER_TEXT ? fullLead :
    status === 'replied' ? 'Gmail 回复：' : status === 'due' ? '到期未回，请拟催办草稿：' : '无法核实回复。';
  const excerpt = String(text ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim();
  return lead + excerpt.slice(0, Math.max(0, MAX_REMINDER_TEXT - lead.length - source.length)) + source;
}
