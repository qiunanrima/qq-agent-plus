import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpPrompt } from '../src/antigravity-cli/prompt.js';

test('native runtime facts override stale lack-of-access statements without granting execution', () => {
  const prompt = buildMcpPrompt({ messages: [{ role: 'assistant', content: '我只能看到qq_run，不能调用本地命令' }], toolChoice: 'auto', nativeApproval: true });
  assert.match(prompt, /nativeApproval enabled/); assert.match(prompt, /run_command, read_file/);
  assert.match(prompt, /Host-tool lists.*not the entire CLI tool inventory/);
  assert.match(prompt, /Every native operation requires approval/);
  assert.doesNotMatch(prompt, /Native file and command tools are unavailable/);
  assert.ok(prompt.indexOf('Current host routing and capability rules') > prompt.indexOf('我只能看到qq_run'));
});
test('disabled native mode remains QQ-only and never advertises command support', () => {
  const prompt = buildMcpPrompt({ messages: [], toolChoice: 'auto', nativeApproval: false });
  assert.match(prompt, /Native file and command tools are unavailable/);
  assert.doesNotMatch(prompt, /Configured native tools/);
  assert.match(prompt, /Stop after qq_finish succeeds/);
});

test('Bilibili Agent prompt restricts replies to the current UID without QQ or native permissions', () => {
  const prompt = buildMcpPrompt({ messages: [], toolChoice: 'auto', nativeApproval: true, platform: 'bilibili' });
  assert.match(prompt, /current Bilibili UID/);
  assert.match(prompt, /native tools, commands, files, and cross-chat actions are unavailable/);
  assert.match(prompt, /Never retry successful or unknown sends/);
});
