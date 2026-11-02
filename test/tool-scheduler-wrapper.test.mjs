import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 用例自己造临时数据目录：**不许**碰仓库里的 data/（那里可能是真配置，含 Key）。
// 注意 ESM 的静态 import 会先于文件体执行，所以 src 模块必须用动态 import 放在这之后。
const __dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tool-sched-'));
process.env.QQ_AGENT_DATA_DIR = __dir;
process.on('exit', () => { try { fs.rmSync(__dir, { recursive: true, force: true }); } catch { /* Windows 上可能被句柄占着 */ } });

const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
// tools-core / tools 会（直接或间接）加载 core/config.js，而 DATA_DIR 是模块级常量；
// 用静态 import 的话上面那个环境变量还没生效，隔离就是假的。
const {
  executeTool: coreExecuteTool,
  toOpenAiTools: coreToOpenAiTools
} = await import('../src/tools/tools-core.js');
const {
  executeTool: wrappedExecuteTool,
  toOpenAiTools: wrappedToOpenAiTools
} = await import('../src/tools/tools.js');

function cfg(enabled, maxParallelReads = 4) {
  const value = structuredClone(DEFAULT_CONFIG);
  value.toolSchedulerPilot = { enabled, maxParallelReads };
  return value;
}

function call(id, name, args = {}) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  };
}

function fakeDef(name, execute) {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute
  };
}

test('wrapper is a semantic pass-through when experiment is disabled', async () => {
  setRuntimeConfig(cfg(false));
  const defs = [fakeDef('memory_query', async () => ({ content: 'same' }))];
  assert.deepEqual(wrappedToOpenAiTools(defs), coreToOpenAiTools(defs));

  const ctx = { session: { rounds: 1, messages: [] } };
  const wrapped = await wrappedExecuteTool(defs, ctx, 'memory_query', '{}');
  const core = await coreExecuteTool(defs, ctx, 'memory_query', '{}');
  assert.deepEqual(wrapped, core);
});

test('wrapper prestarts only contiguous read calls and keeps ordered tools lazy', async () => {
  setRuntimeConfig(cfg(true, 4));
  const calls = [
    call('a', 'search_web', { q: 1 }),
    call('b', 'get_message_detail', { id: 2 }),
    call('c', 'send_message', { text: 'x' }),
    call('d', 'finish', { summary: 'done' })
  ];
  const session = { rounds: 1, messages: [{ role: 'assistant', tool_calls: calls }] };
  const starts = [];
  let activeReads = 0;
  let peakReads = 0;
  const defs = [
    fakeDef('search_web', async () => {
      starts.push('search_web');
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      await delay(30);
      activeReads -= 1;
      return { content: 'search' };
    }),
    fakeDef('get_message_detail', async () => {
      starts.push('get_message_detail');
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      await delay(5);
      activeReads -= 1;
      return { content: 'detail' };
    }),
    fakeDef('send_message', async () => {
      starts.push('send_message');
      return { content: 'sent' };
    }),
    fakeDef('finish', async () => {
      starts.push('finish');
      return { content: 'finished' };
    })
  ];
  const ctx = { session };

  await wrappedExecuteTool(defs, ctx, 'search_web', calls[0].function.arguments);
  assert.equal(peakReads, 2);
  assert.equal(starts.includes('send_message'), false);
  await wrappedExecuteTool(defs, ctx, 'get_message_detail', calls[1].function.arguments);
  assert.equal(starts.includes('send_message'), false);
  await wrappedExecuteTool(defs, ctx, 'send_message', calls[2].function.arguments);
  assert.equal(starts.at(-1), 'send_message');
  await wrappedExecuteTool(defs, ctx, 'finish', calls[3].function.arguments);
  assert.equal(starts.at(-1), 'finish');
  assert.equal(session.experimentalToolScheduler.parallelWaves, 1);
  assert.equal(session.experimentalToolScheduler.parallelCalls, 2);
});

test('wrapper blocks finish after a prior tool error', async () => {
  setRuntimeConfig(cfg(true));
  const calls = [
    call('a', 'send_message', { text: 'x' }),
    call('b', 'finish', { summary: 'done' })
  ];
  const executed = [];
  const defs = [
    fakeDef('send_message', async () => {
      executed.push('send_message');
      return { content: 'failed', isError: true };
    }),
    fakeDef('finish', async () => {
      executed.push('finish');
      return { content: 'finished' };
    })
  ];
  const ctx = { session: { rounds: 1, messages: [{ role: 'assistant', tool_calls: calls }] } };
  await wrappedExecuteTool(defs, ctx, 'send_message', calls[0].function.arguments);
  const result = await wrappedExecuteTool(defs, ctx, 'finish', calls[1].function.arguments);
  assert.equal(result.errorCode, 'FINISH_BARRIER_BLOCKED');
  assert.deepEqual(executed, ['send_message']);
});

test('wrapper suppresses side effects after finish', async () => {
  setRuntimeConfig(cfg(true));
  const calls = [
    call('a', 'finish', { summary: 'done' }),
    call('b', 'send_message', { text: 'must not run' })
  ];
  const executed = [];
  const defs = [
    fakeDef('finish', async () => {
      executed.push('finish');
      return { content: 'finished' };
    }),
    fakeDef('send_message', async () => {
      executed.push('send_message');
      return { content: 'sent' };
    })
  ];
  const ctx = { session: { rounds: 1, messages: [{ role: 'assistant', tool_calls: calls }] } };
  await wrappedExecuteTool(defs, ctx, 'finish', calls[0].function.arguments);
  const result = await wrappedExecuteTool(defs, ctx, 'send_message', calls[1].function.arguments);
  assert.equal(result.errorCode, 'SKIPPED_AFTER_FINISH_BARRIER');
  assert.deepEqual(executed, ['finish']);
});
