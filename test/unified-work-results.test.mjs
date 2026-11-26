import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordSettledMailFollowUps, withWorkResults } from '../src/unified-memory/work-results.js';
import { memoryTurn } from '../src/unified-memory/turn.js';
import { UnifiedMemoryStore } from '../src/unified-memory/store.js';

test('next turn can recover a workspace file and distinguish an uncertain invitation', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-results-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = { filename: path.join(dir, 'memory.sqlite'), scope: 'private:1', sessionId: 's',
    enabled: () => true, onError: assert.fail };
  let calls = 0;
  async function run(name, args, data) {
    const original = { content: JSON.stringify(data) };
    const [tool] = withWorkResults([{ name, execute: async () => { calls++; return original; } }], options);
    assert.equal(await tool.execute({ chatKey: options.scope }, args), original);
  }
  const context = () => memoryTurn({ ...options, entries: [] }).prompt;
  await run('linux_export_calendar_invitation', {}, { file: '/workspace/inbox/meeting.ics', status: 'exported' });
  await run('personal_mail_search', { action: 'send_calendar_invitation', title: '例会' }, { status: 'unknown', uid: 'a' });
  await run('personal_mail_search', { action: 'follow_up_create' }, { id: 'job1', status: 'pending', deadline: 100 });
  assert.match(context(), /job1/);
  await run('personal_mail_search', { action: 'follow_up_cancel' }, { id: 'job1', status: 'canceled' });
  const prompt = context();
  assert.doesNotMatch(prompt, /job1/);
  assert.match(prompt, /发送结果未知/);
  assert.match(prompt, /workspace\/inbox\/meeting\.ics/);
  assert.equal(calls, 4);
  const outcomes = [{ id: 'replied', status: 'replied', deadline: 100 },
    { id: 'due', status: 'due', deadline: 100 }];
  recordSettledMailFollowUps(options.filename, options.scope, outcomes);
  recordSettledMailFollowUps(options.filename, options.scope, outcomes);
  assert.match(context(), /邮件到期未回/);
  assert.doesNotMatch(context(), /邮件已收到回复/);
  const db = new UnifiedMemoryStore(options.filename, { readOnly: true });
  try {
    const revisions = db.history(options.scope, 'task', 'mail-followup:replied');
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].closed, true);
    assert.deepEqual(db.current('group:1'), []);
  } finally { db.close(); }
});
