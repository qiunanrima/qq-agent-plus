import assert from 'node:assert/strict';
import test from 'node:test';
import { containerAllowed, containerTools } from '../src/tools/linux-container.js';

test('container requires an owner-only inbound turn and explicit group opt-in', async () => {
  const cfg = { admin: { ownerUin: '123' }, linuxContainer: { enabled: true } };
  const turn = { chatKey: 'private:123', senders: ['123'] };
  assert.ok(containerAllowed(cfg, turn));
  for (const patch of [{ senders: [] }, { senders: ['123', '456'] }, { external: true },
    { proactive: true }, { chatKey: 'private:456' }, { chatKey: 'group:42', directed: true }]) {
    assert.ok(!containerAllowed(cfg, { ...turn, ...patch }));
  }
  cfg.linuxContainer.allowGroup = true;
  const group = { ...turn, chatKey: 'group:42', directed: true };
  assert.ok(containerAllowed(cfg, group));
  assert.ok(!containerAllowed(cfg, { ...group, directed: false }));
  const [tool] = containerTools(() => cfg, group);
  cfg.linuxContainer.allowGroup = false;
  assert.ok((await tool.execute({}, { command: 'id' })).isError);
});
