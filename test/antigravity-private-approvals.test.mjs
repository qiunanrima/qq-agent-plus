import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handlePrivateCliApproval } from '../src/antigravity-cli/private-approvals.js';
import { requestCliApproval, listCliApprovals, decideCliApproval } from '../src/antigravity-cli/approvals.js';

const getConfig = () => ({ admin: { ownerUin: '123456' } });
const event = text => ({ post_type: 'message', message_type: 'private', user_id: 123456, self_id: 654321, raw_message: text });
const request = (extra = {}) => requestCliApproval({ category: 'native', chatKey: 'group:test', runId: 'run', tool: 'run_command', args: { CommandLine: 'uptime' }, ...extra });
const deps = { getConfig, audit: () => ({ ok: true }), reply: async () => {} };

test('only real owner private text can approve once; group, echo, forwards and other users cannot', async () => {
  const pending = request(); const entry = listCliApprovals()[0]; const text = `批准CLI ${entry.id}`;
  for (const incoming of [{ ...event(text), user_id: 999999 }, { ...event(text), message_type: 'group' },
    { ...event(text), post_type: 'message_sent' }, { ...event(text), user_id: 654321 },
    { ...event(text), message: [{ type: 'forward', data: {} }] }]) {
    assert.equal(await handlePrivateCliApproval(incoming, deps), false);
    assert.equal(listCliApprovals().length, 1);
  }
  let audits = 0;
  const audited = { ...deps, audit: data => { audits++; assert.equal(data.after.approved, true); assert.equal(data.after.decidedBy, '123456'); return data; } };
  assert.equal(await handlePrivateCliApproval(event(text), audited), true); assert.equal(await pending, true);
  assert.equal(await handlePrivateCliApproval(event(text), audited), true); assert.equal(audits, 1);
});
test('failed audit cannot grant; rejection is single-use even if receipt cannot be delivered', async () => {
  const pending = request(); const entry = listCliApprovals()[0];
  await handlePrivateCliApproval(event(`批准CLI ${entry.id}`), { ...deps, audit: () => null });
  assert.equal(listCliApprovals().length, 1);
  await handlePrivateCliApproval(event(`拒绝CLI ${entry.id}`), { ...deps, reply: () => { throw new Error('offline'); } });
  assert.equal(await pending, false); assert.equal(decideCliApproval(entry.id, true), false);
});
test('long parameters require console approval and cancellation expires private commands', async () => {
  const controller = new AbortController();
  const pending = request({ args: { CommandLine: 'echo test; '.repeat(160) }, signal: controller.signal });
  const entry = listCliApprovals()[0]; let reply = '';
  await handlePrivateCliApproval(event(`批准CLI ${entry.id}`), { ...deps, reply: (_owner, text) => { reply = text; } });
  assert.match(reply, /参数较长/); assert.equal(listCliApprovals().length, 1);
  controller.abort(); assert.equal(await pending, false);
  await handlePrivateCliApproval(event(`批准CLI ${entry.id}`), { ...deps, reply: (_owner, text) => { reply = text; } });
  assert.match(reply, /已失效/);
});

test('real app ingress consumes owner approval before storage and model scheduling', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-cli-private-'));
  process.env.QQ_AGENT_DATA_DIR = root;
  process.env.QQ_AGENT_SKIP_NETWORK_PROBES = '1';
  process.env.QQ_AGENT_SKIP_INDEX_WARM = '1';
  const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.admin.ownerUin = '123456'; cfg.runtime.mode = 'observe';
  updateConfig(cfg);
  const { createApp } = await import('../src/console/app.js');
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const replies = [];
  app.sender.sendTextBatch = async (_chat, texts) => { replies.push(...texts); return { sent: 1 }; };
  app.orchestrator.onIncoming = () => assert.fail('Approval must not invoke a model');
  const pending = request(); const entry = listCliApprovals()[0];
  await app.onebot.onEvent(event(`批准CLI ${entry.id}`));
  assert.equal(await pending, true);
  assert.match(replies[0], /已批准这一次/);
  assert.equal(app.store.recent('private:123456').length, 0);
  const { queryAudit } = await import('../src/core/audit-log.js');
  assert.ok(queryAudit().entries.some(row => row.action === 'antigravity.approval' && row.after?.channel === 'qq-private'));
});
