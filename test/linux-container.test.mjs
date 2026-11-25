import assert from 'node:assert/strict';
import test from 'node:test';
import { containerAllowed, containerTools, workspaceMaterialCommand, workspaceSearchCommand } from '../src/tools/linux-container.js';

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

test('workspace search requires the exact private request directory and literal keywords', async () => {
  const root = '/workspace/client-project';
  assert.match(workspaceSearchCommand(root, ['报价', 'Meeting notes'], '在 /workspace/client-project 找会前资料'), /find -P/);
  assert.match(workspaceSearchCommand('/workspace/client project', ['报价'],
    '在「/workspace/client project」找会前资料'), /find -P/);
  assert.equal(workspaceSearchCommand(root, ['报价'], '在 /workspace/client-project-archive 找'), null);
  assert.equal(workspaceSearchCommand('/workspace/../etc', ['报价'], '用 /workspace/../etc'), null);
  assert.equal(workspaceSearchCommand(root, ['*.pdf'], '在 /workspace/client-project 找'), null);
  assert.equal(workspaceSearchCommand(root, ['$(id)'], '在 /workspace/client-project 找'), null);
  const cfg = { admin: { ownerUin: '123' }, linuxContainer: { enabled: true, allowGroup: true } };
  const group = { chatKey: 'group:1', directed: true, senders: ['123'] };
  assert.ok(!containerTools(() => cfg, group).some(({ name }) => name === 'linux_find_workspace_files'));
  const tool = containerTools(() => cfg, { ...group, chatKey: 'private:123' })
    .find(({ name }) => name === 'linux_find_workspace_files');
  assert.ok(tool);
  assert.ok((await tool.execute({ triggerEntries: [{ text: '搜索别的目录' }] },
    { directory: root, keywords: ['报价'] })).isError);
});

test('workspace material reads stay within the authorized folder and bound the excerpt', async () => {
  const folder = '/workspace/client-project';
  const request = '在 /workspace/client-project 找会前资料';
  assert.match(workspaceMaterialCommand(folder, folder + "/review's.csv", request), /head -c 8193/);
  for (const path of [folder + '-other/q.csv', folder + '/../q.csv', folder + '/.private/q.txt',
    folder + '/x.pdf', folder + '/x\ny.txt', folder + '/a/b/c/d.txt']) {
    assert.equal(workspaceMaterialCommand(folder, path, request), null);
  }
  assert.equal(workspaceMaterialCommand(folder, folder + '/quote.md', '只查日历'), null);
  const cfg = { admin: { ownerUin: '123' }, linuxContainer: { enabled: true, allowGroup: true } };
  const group = { chatKey: 'group:1', directed: true, senders: ['123'] };
  assert.ok(!containerTools(() => cfg, group).some(({ name }) => name === 'linux_read_workspace_material'));
  const tool = containerTools(() => cfg, { ...group, chatKey: 'private:123' })
    .find(({ name }) => name === 'linux_read_workspace_material');
  assert.ok((await tool.execute({ triggerEntries: [{ text: request }] },
    { directory: folder, file: folder + '/../q.csv' })).isError);
});
