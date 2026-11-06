import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { antigravityQuotaTools } from '../src/antigravity-cli/tools.js';

const config = () => ({ antigravityCli: { enabled: true, executable: 'test-agy', workspace: os.tmpdir() } });
test('quota tool only exists while CLI enabled and rechecks enablement before querying', async () => {
  const c = config(); let calls = 0;
  const tools = antigravityQuotaTools(() => c, { readQuota: async () => { calls++; return {}; } });
  assert.equal(tools[0].name, 'antigravity_quota');
  c.antigravityCli.enabled = false;
  assert.deepEqual(antigravityQuotaTools(() => c), []);
  assert.equal((await tools[0].execute({}, {})).isError, true); assert.equal(calls, 0);
});
test('agent forwards explicit refresh and returns unknown quota values without interpreting zero', async () => {
  const c = config(); let options;
  const [tool] = antigravityQuotaTools(() => c, { readQuota: async (exe, opts) => {
    assert.equal(exe, 'test-agy'); options = opts;
    return { groups: [{ name: 'Gemini', buckets: [{ remainingFraction: null }] }], remainingCredits: 0, checkedAt: '2026-11-06T00:00:00Z' };
  } });
  const result = await tool.execute({}, { refresh: true });
  assert.deepEqual(options, { refresh: true });
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.groups[0].buckets[0].remainingFraction, null); assert.equal(parsed.remainingCredits, 0);
  assert.equal((await tool.execute({}, { refresh: 'true' })).errorCode, 'INVALID_TOOL_ARGUMENTS');
});
test('late response after CLI disable or executable change is not exposed; failures hide diagnostics', async () => {
  for (const change of [c => { c.antigravityCli.enabled = false; }, c => { c.antigravityCli.executable = 'other'; }]) {
    const c = config(); const [tool] = antigravityQuotaTools(() => c, { readQuota: async () => { change(c); return { secret: 'must not expose' }; } });
    const result = await tool.execute({}, {}); assert.equal(result.isError, true); assert.ok(!result.content.includes('must not expose'));
  }
  const c = config();
  const [tool] = antigravityQuotaTools(() => c, { readQuota: async () => { throw new Error('secret token'); } });
  assert.ok(!(await tool.execute({}, {})).content.includes('secret token'));
});
