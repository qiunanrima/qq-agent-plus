import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { triageAccountKey } from './triage-store.js';

const interval = 10 * 60000;
const verificationGrace = 2 * interval;
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
  if (args.action === 'follow_up_list') return {
    jobs: own.slice(-20).reverse().map(({ key: _, ...job }) => job)
  };
  if (args.action === 'follow_up_cancel') {
    const job = own.find(item => item.id === args.followUpId && item.status === 'pending' && !item.outcome);
    if (!job) return { error: '找不到可取消的跟进' };
    job.status = 'canceled';
    saveJobs(dataDir, jobs);
    return { id: job.id, status: job.status };
  }
  const { threadId, deadline } = args;
  if (typeof threadId !== 'string' || !/^[a-z0-9]{1,128}$/i.test(threadId) ||
      !Number.isSafeInteger(deadline) || deadline <= now || deadline - now > 30 * 86400000) {
    return { error: '请提供 Gmail 线程编号和未来 30 天内的跟进期限' };
  }
  const duplicate = own.find(job => job.threadId === threadId && job.status === 'pending');
  if (duplicate) return { id: duplicate.id, status: duplicate.status, deadline: duplicate.deadline };
  if (jobs.filter(job => job.status === 'pending').length >= 12) return { error: '邮件跟进队列已满' };
  const job = { id: randomUUID(), key, threadId, deadline, nextCheckAt: now, status: 'pending' };
  const history = jobs.filter(item => item.status !== 'pending').slice(-80);
  saveJobs(dataDir, [...history, ...jobs.filter(item => item.status === 'pending'), job]);
  return { id: job.id, status: job.status, deadline };
}

export async function checkMailFollowUp({ dataDir, env, readThread, notify, now = Date.now(), signal }) {
  if (!env.QQ_AGENT_GMAIL_REFRESH_TOKEN || signal?.aborted) return;
  const key = triageAccountKey('gmail', env);
  const job = readJobs(dataDir).find(item => item.key === key && item.status === 'pending' &&
    (item.outcome || item.nextCheckAt <= now));
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
    else if (now >= job.deadline) {
      if (thread.status === 'ok' && sent >= 0) {
        current.outcome = { status: 'due', text: messages[sent].subject };
      } else if (thread.status === 'unavailable' && now < job.deadline + verificationGrace) {
        current.nextCheckAt = Math.min(now + interval, job.deadline + verificationGrace);
      } else {
        current.outcome = { status: 'unverified', text: '' };
      }
    }
    else current.nextCheckAt = Math.min(now + interval, job.deadline);
    saveJobs(dataDir, jobs);
    job.outcome = current.outcome;
  }
  if (!job.outcome || signal?.aborted) return;
  await notify(job);
  const jobs = readJobs(dataDir);
  const current = jobs.find(item => item.id === job.id && item.status === 'pending');
  if (current) {
    current.status = job.outcome.status;
    saveJobs(dataDir, jobs);
  }
}
