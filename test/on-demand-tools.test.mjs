import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mountOnDemandTools } from '../src/tools/on-demand.js';

test('deferred catalog exposes one entry, discovery has no effects, execution requires discovery', async () => {
  let calls = 0;
  let enabled = true;
  const original = [{ name: 'send_message' }, { name: 'set_my_status', description: 'status', parameters: { type: 'object' } }];
  const mounted = mountOnDemandTools(original, async (defs, ctx, name, args) => {
    calls++;
    assert.equal(name, 'set_my_status');
    assert.deepEqual(JSON.parse(args), { status: 1 });
    return { content: 'unknown', isError: true, uncertain: true };
  }, () => enabled);
  assert.deepEqual(mounted.map(def => def.name), ['send_message', 'discover_tools']);
  const gateway = mounted[1];
  assert.equal((await gateway.execute({}, { tool: 'set_my_status' })).isError, true);
  const found = await gateway.execute({}, { group: 'account' });
  assert.deepEqual(JSON.parse(found.content).tools.map(t => t.name), ['set_my_status']);
  assert.equal(calls, 0);
  const result = await gateway.execute({}, { tool: 'set_my_status', args: { status: 1 } });
  assert.equal(calls, 1);
  assert.equal(result.uncertain, true);
  assert.equal(result.resolvedTool, 'set_my_status');
  enabled = false;
  assert.equal((await gateway.execute({}, { tool: 'set_my_status' })).isError, true);
  assert.equal(calls, 1, 'never retry writes or execute disabled tools');
  assert.deepEqual(JSON.parse((await gateway.execute({}, { group: 'account' })).content).tools, []);
});

test('unavailable tools cannot be discovered, skills remain scoped and state is per run', async () => {
  let calls = 0;
  const defs = [{ name: 'set_my_status', parameters: {} }];
  const make = () => mountOnDemandTools(defs, async () => { calls++; return { content: 'ok' }; })[0];
  const gateway = make();
  assert.deepEqual(JSON.parse((await gateway.execute({}, { group: 'albums' })).content).tools, []);
  await gateway.execute({}, { group: 'account' });
  const ctx = { activeSkill: { name: 'restricted', allowedTools: new Set(['send_message']) } };
  assert.equal((await gateway.execute(ctx, { tool: 'set_my_status' })).isError, true);
  assert.equal((await make().execute({}, { tool: 'set_my_status' })).isError, true);
  assert.equal((await gateway.execute({}, { group: 'account', tool: 'set_my_status' })).isError, true);
  assert.equal(calls, 0);
});
