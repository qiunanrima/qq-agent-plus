import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQuotaReader, parseQuotaEnvelope } from '../src/antigravity-cli/quota.js';

const envelope = (name, data) => JSON.stringify({ status: 'SUCCESS', num_turns: 0, command: { name, data }, secret: 'must not escape' });
const usage = envelope('usage', { groups: [{ name: 'Gemini', buckets: [
  { window: 'weekly', remaining_fraction: 0.8, reset_time: '2026-11-12T00:00:00Z' },
  { window: '5h', remaining_fraction: null, reset_time: 'invalid' }
] }] });

test('quota parser distinguishes unknown from zero and drops unapproved fields', () => {
  const parsed = parseQuotaEnvelope(usage, 'usage');
  assert.equal(parsed.groups[0].buckets[0].remainingFraction, 0.8);
  assert.equal(parsed.groups[0].buckets[1].remainingFraction, null);
  assert.equal(parsed.groups[0].buckets[1].resetTime, null);
  assert.ok(!JSON.stringify(parsed).includes('must not escape'));
  assert.equal(parseQuotaEnvelope(envelope('credits', { remaining_credits: 0 }), 'credits').remainingCredits, 0);
  assert.equal(parseQuotaEnvelope(envelope('credits', {}), 'credits').remainingCredits, null);
  assert.throws(() => parseQuotaEnvelope(usage.replace('"num_turns":0', '"num_turns":1'), 'usage'));
  assert.throws(() => parseQuotaEnvelope(usage, 'credits'));
});

test('quota queries are read-only, single-flight and cached; fresh requests run only after expiry', async () => {
  let clock = 1000000;
  const calls = [];
  const read = createQuotaReader({ now: () => clock, run: async (exe, args, options) => {
    calls.push({ exe, args });
    assert.equal(options.shell, false);
    if (args[0] === '--version') return { stdout: '1.4.12\n' };
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    assert.equal(settings.disableSlashCommands, false);
    assert.equal(settings.useG1Credits, false);
    assert.ok(['/usage', '/credits'].includes(args[1]));
    return { stdout: args[1] === '/usage' ? usage : envelope('credits', { remaining_credits: 0 }) };
  } });
  assert.deepEqual(read.peek('agy'), { available: false });
  assert.equal(calls.length, 0);
  const [a, b] = await Promise.all([read('agy'), read('agy')]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 3);
  assert.equal(a.remainingCredits, 0);
  assert.equal((await read('agy')).cached, true);
  clock += 300001;
  assert.equal(read.peek('agy').stale, true);
  assert.equal(calls.length, 3);
  await read('agy');
  assert.equal(calls.length, 6);
});

test('unsupported versions never receive slash prompts; failure has cooldown and hides diagnostics', async () => {
  let calls = 0, clock = 1000000;
  const read = createQuotaReader({ now: () => clock, run: async () => { calls++; return { stdout: '1.0.0' }; } });
  await assert.rejects(read('agy'), /额度查询失败/);
  await assert.rejects(read('agy'), /额度查询失败/);
  assert.equal(calls, 1);
  clock += 60001;
  await assert.rejects(read('agy'));
  assert.equal(calls, 2);
});

test('credit query failure leaves model quotas usable with unknown credits', async () => {
  const read = createQuotaReader({ run: async (_exe, args) => {
    if (args[0] === '--version') return { stdout: '1.4.12' };
    if (args[1] === '/usage') return { stdout: usage };
    throw new Error('secret token and account');
  } });
  const result = await read('agy');
  assert.equal(result.remainingCredits, null);
  assert.equal(result.creditsAvailable, false);
  assert.equal(result.groups.length, 1);
  assert.ok(!JSON.stringify(result).includes('secret'));
});
