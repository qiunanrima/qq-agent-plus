// 今日用量里必须包含**在途会话**的估算金额：只加 token 时，并发运行的会话在结束落盘前
// 不计入当日花费，日预算会被「在途数 × 单次预算」地超出（2026-10-19 全项目审查 P2）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sessions-usage-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { SessionRegistry } = await import('../src/core/sessions.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
const { todayKey } = await import('../src/core/util.js');
const { featureSnapshot } = await import('../src/core/usage-features.js');

test('历史未分类、后台来源和在途聊天按功能分摊且不丢原始台账', () => {
  const cfg = structuredClone(DEFAULT_CONFIG); cfg.api.model = 'deepseek-chat'; setRuntimeConfig(cfg);
  const reg = new SessionRegistry(0);
  reg.recordExternalUsage({ promptTokens: 100, completionTokens: 10, totalTokens: 110, calls: 1 }, { source: 'personality-review', model: 'deepseek-chat' });
  reg.recordExternalUsage({ promptTokens: 200, completionTokens: 20, totalTokens: 220, calls: 1 }, { source: 'group-digest', model: 'deepseek-chat' });
  reg.current.set('in-flight', { usage: { promptTokens: 300, completionTokens: 30, totalTokens: 330, calls: 3 }, model: 'deepseek-chat' });
  const usage = reg.todayUsage(todayKey());
  assert.equal(usage.byFeature['personality-review'].tokens, 110);
  assert.equal(usage.byFeature['group-digest'].tokens, 220);
  assert.equal(usage.byFeature.chat.calls, 3);
  assert.equal(Object.values(usage.byFeature).reduce((sum, row) => sum + row.tokens, 0), usage.totalTokens);
  assert.ok(Math.abs(Object.values(usage.byFeature).reduce((sum, row) => sum + row.cost, 0) - usage.estimatedYuan) < 1e-10);
  const ledger = fs.readFileSync(path.join(dataDir, 'external-usage', `${todayKey()}.jsonl`), 'utf8');
  assert.match(ledger, /personality-review/); assert.match(ledger, /group-digest/);
  const old = { totalTokens: 1000, estimatedYuan: 2, byFeature: { chat: { tokens: 200, cost: 0.5 } } };
  assert.equal(featureSnapshot(old).unattributed.tokens, 800);
  assert.equal(featureSnapshot(old).unattributed.cost, 1.5);
  assert.equal(old.byFeature.unattributed, undefined);
  fs.rmSync(path.join(dataDir, 'usage-today.json'), { force: true });
});

test('todayUsage 计入在途会话的估算金额', () => {
  // 固定时钟：deepseek-flash 有峰谷价、todayKey 还会跨午夜；两次调用恰好跨过边界时
  // 估价/日期会变，断言必红（2026-10-20 审查 P3）。选周二上午 10:00（北京时间），
  // 不在任何切换点附近。
  const fixedNow = Date.parse('2026-10-20T02:00:00Z');
  const realNow = Date.now;
  Date.now = () => fixedNow;
  try {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.api.model = 'deepseek-flash';
  setRuntimeConfig(cfg);

  const reg = new SessionRegistry(0);
  reg.current.set('inflight-1', {
    id: 'inflight-1',
    chatKey: 'group:1',
    startedAt: Date.now() - 60_000,
    // 大量缓存命中：在途估价必须与结束落盘的口径一致（漏传 cachedTokens 会按全价高估）
    usage: { promptTokens: 200000, completionTokens: 500, totalTokens: 200500, cachedTokens: 190000 },
    model: 'deepseek-flash',
    vendor: ''
  });

  const before = reg.todayUsage(todayKey());
  assert.equal(before.totalTokens, 200500, 'token 仍要照常累加');
  assert.ok(before.estimatedYuan > 0, '在途会话的花费要计入当日金额（否则并发时预算可被超出）');
  assert.equal(before.unpricedRuns, 0, '有价格的模型不该记成未计价');

  // 会话结束并落盘后，todayUsage 改用文件里的金额；两者必须一致（同一套估价口径）
  reg.finish('inflight-1', 'done');
  const after = reg.todayUsage(todayKey());
  assert.ok(Math.abs(after.estimatedYuan - before.estimatedYuan) < 1e-9,
    `在途估价与结束落盘不一致：before=${before.estimatedYuan} after=${after.estimatedYuan}`);
  } finally {
    Date.now = realNow;
  }
});

test('包月模式不把按量成本 0 误记成“未计价”', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.api = {
    ...cfg.api,
    model: 'deepseek-flash',
    costMode: 'subscription',
    costMonthlyFee: 68,
    costMultiplier: 1
  };
  setRuntimeConfig(cfg);
  const reg = new SessionRegistry(0);
  reg.recordExternalUsage(
    { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, cachedTokens: 0, calls: 1 },
    { model: 'deepseek-flash' }
  );
  const usage = reg.todayUsage(todayKey());
  assert.equal(usage.unpricedRuns, 0, '包月不是未定价');
});
