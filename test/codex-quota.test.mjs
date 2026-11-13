import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCodexQuotaReader, parseCodexQuota } from '../src/codex-cli/quota.js';
import { readCodexQuotaStatus } from '../src/codex-cli/models.js';
const sample = '**Account:** ChatGPT pro (private@example.com)\n**Directory:** /private\n**Session:** `secret-id`\n**5h limit:** 73% left (resets 18:30)\n**Weekly limit:** 49% left (resets 12:00 on Nov 17)\n**Credits:** 0';

test('Codex quota exposes remaining percentages and zero credits, never account email, path or session', () => {
  const quota = parseCodexQuota(sample);
  assert.equal(quota.available, true); assert.equal(quota.plan, 'pro'); assert.equal(quota.credits, 0);
  assert.deepEqual(quota.windows.map(w => w.remainingPercent), [73, 49]);
  assert.ok(!JSON.stringify(quota).includes('private')); assert.ok(!JSON.stringify(quota).includes('secret-id'));
  assert.equal(parseCodexQuota('**Limits:** data not available yet').available, false);
  assert.equal(parseCodexQuota('**Limits:** data not available yet').credits, null);
  assert.equal(parseCodexQuota('**Credits:** unlimited').unlimited, true);
});

test('Codex quota only runs on explicit read, coalesces, caches for a minute and cools down failed queries', async () => {
  let at = 100000, calls = 0, fail = false;
  const reader = createCodexQuotaReader({ now: () => at, query: async () => { calls++; if (fail) throw new Error('sensitive'); return sample; } });
  const cfg = { executable: 'codex-acp', workspace: '/chat' };
  assert.equal(reader.peek(cfg).available, false); assert.equal(calls, 0);
  const [first, second] = await Promise.all([reader.read(cfg), reader.read(cfg)]);
  assert.equal(calls, 1); assert.deepEqual(first, second);
  assert.equal((await reader.read(cfg)).cached, true); assert.equal(calls, 1);
  at += 61000; fail = true;
  await assert.rejects(reader.read(cfg), /query failed/);
  await assert.rejects(reader.read(cfg), /cooling down/); assert.equal(calls, 2);
  at += 16000; fail = false; assert.equal((await reader.read(cfg)).available, true); assert.equal(calls, 3);
  assert.equal(reader.peek({ ...cfg, workspace: '/other' }).available, false);
});

test('Codex quota uses only advertised /status without MCP and refuses unsupported adapters before prompting', async t => {
  const workspace = await fs.mkdtemp(path.resolve('.codex/codex-quota-'));
  await fs.mkdir(path.join(workspace, 'codex-home'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL('./fixtures/codex-acp.mjs', import.meta.url));
  const deps = mode => ({ spawnProcess: (_exe, _args, options) => spawn(process.execPath, [fixture, mode], options), timeoutMs: 6000 });
  const text = await readCodexQuotaStatus({ workspace }, deps('quota'));
  assert.deepEqual(parseCodexQuota(text).windows.map(w => w.remainingPercent), [73, 49]);
  await assert.rejects(readCodexQuotaStatus({ workspace }, deps('quota-no-command')), /local status command unavailable/);
  assert.deepEqual(await fs.readdir(workspace), ['codex-home']);
});
