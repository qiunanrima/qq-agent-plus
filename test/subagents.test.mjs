import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RestrictedSubagents } from '../src/subagents/index.js';
import { normalizeSubagentConfig } from '../src/subagents/config.js';
import { createLogger, withTrace } from '../src/core/logger.js';

const call = (name, args = {}) => ({ id: 'read-1', type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = (content, tool_calls, tokens = 10) => ({ message: { content, tool_calls }, usage: { total_tokens: tokens } });
function fixture() {
  const cfg = { subagent: { enabled: true } }, logs = [];
  const module = new RestrictedSubagents({ getConfig: () => cfg, logger: { info: (line) => logs.push(line) } });
  const ctx = { chatKey: 'group:1', kind: 'group', chatId: '1', session: { id: 'parent', messages: [{ content: '不应继承的历史' }] }, sender: { secret: true } };
  const defs = [{ name: 'memory_query', parameters: {}, execute: () => ({ content: '资料正文' }) }];
  return { module, cfg, logs, ctx, defs };
}

test('默认关闭、固化与启用独立；旧工具在关闭后仍拒绝并记录调用', async () => {
  assert.deepEqual(normalizeSubagentConfig({ graduated: true }), { enabled: false, graduated: true });
  const f = fixture();
  const tools = f.module.toolDefs({ getTools: () => f.defs, complete: async () => response('完成') });
  f.cfg.subagent.enabled = false;
  assert.deepEqual(f.module.toolDefs({}), []);
  assert.equal((await tools[0].execute(f.ctx, { task: '查资料' })).isError, true);
  assert.match(f.logs.join('\n'), /called/);
  assert.match(f.logs.join('\n'), /status=failed/);
});

test('独立上下文、硬白名单、最小工具上下文及结果截断；记录完整调用生命周期', async () => {
  const f = fixture();
  let rounds = 0;
  f.defs.push({ name: 'send_message', execute: () => assert.fail('不能发送') }, { name: 'delegate_research' });
  f.defs[0].execute = (ctx) => {
    assert.equal(ctx.sender, undefined);
    assert.notEqual(ctx.session, f.ctx.session);
    assert.deepEqual(Object.keys(ctx.session).sort(), ['memoryRecallIds', 'pastStateCount']);
    assert.equal(ctx.store.db, undefined);
    assert.equal(ctx.store.appendIncoming, undefined);
    assert.equal(ctx.chatKey, 'group:1');
    return { content: '资料'.repeat(5000) };
  };
  const result = await f.module.run(f.ctx, { task: '查询背景', context: '只给这一条索引' }, {
    getTools: () => f.defs,
    complete: async (messages, options) => {
      assert.deepEqual(options.tools.map((t) => t.function.name), ['memory_query']);
      assert.equal(JSON.stringify(messages).includes('不应继承的历史'), false);
      assert.equal(JSON.stringify(f.ctx.session).includes('session":"parent'), false, '审计没有循环引用');
      assert.ok(options.tokenLimit <= 16000);
      if (!rounds++) return response(null, [call('memory_query')]);
      assert.equal(messages.at(-1).content.length, 6000);
      return response('结论'.repeat(3000));
    }
  });
  assert.equal(JSON.parse(result.content).result.length, 4000);
  assert.deepEqual(f.logs.map((line) => line.split(' ')[1]), ['called', 'tool', 'tool_finished', 'finished']);
  assert.match(f.logs.at(-1), /status=completed rounds=2 tools=1/);
  assert.equal(f.ctx.session.subagentRuns[0].status, 'completed');
  assert.equal(f.module.pending.size, 0);
});

test('伪造发送、写记忆、递归与未知工具均无法执行', async () => {
  for (const name of ['send_message', 'memory_append', 'delegate_research', 'plugin_tool']) {
    const f = fixture();
    const result = await f.module.run(f.ctx, { task: '调用工具' }, { getTools: () => f.defs,
      complete: async () => response(null, [call(name)]) });
    assert.equal(result.isError, true);
    assert.match(result.content, /未授权/);
    assert.match(f.logs.join('\n'), /tool_denied/);
  }
});

test('工具权限每次重查，收紧后拒绝在途模型返回的旧工具', async () => {
  const f = fixture();
  const result = await f.module.run(f.ctx, { task: '查资料' }, { getTools: () => f.defs,
    complete: async () => { f.defs.length = 0; return response(null, [call('memory_query')]); } });
  assert.equal(result.isError, true);
  assert.match(result.content, /未授权/);
});

test('调用次数、输入、轮数、工具次数和子预算限制均由宿主执行', async () => {
  const f = fixture();
  const options = { getTools: () => f.defs, complete: async () => response('完成') };
  assert.equal((await f.module.run(f.ctx, { task: 'a'.repeat(2001) }, options)).isError, true);
  await f.module.run(f.ctx, { task: '合法任务' }, options);
  assert.match((await f.module.run(f.ctx, { task: '第三次' }, options)).content, /调用已达上限/);
  for (const [calls, tokens, pattern] of [[5, 10, /工具调用上限/], [1, 10, /轮数上限/], [1, 16000, /Token预算上限/]]) {
    const g = fixture();
    const result = await g.module.run(g.ctx, { task: '循环检索' }, { getTools: () => g.defs,
      complete: async () => response(null, Array.from({ length: calls }, () => call('memory_query')), tokens) });
    assert.match(result.content, pattern);
    assert.equal(g.module.pending.size, 0);
  }
});

test('全局最多2并发、每个父运行最多1个；关闭会取消请求并阻止迟到工具执行', async () => {
  const f = fixture();
  let releases = [];
  const options = { getTools: () => f.defs, complete: async () => new Promise((resolve) => { releases.push(resolve); }) };
  const first = f.module.run(f.ctx, { task: '查询一' }, options);
  assert.match((await f.module.run(f.ctx, { task: '查询二' }, options)).content, /并发已达上限/);
  const second = f.module.run({ ...f.ctx, session: { id: 'other' } }, { task: '查询三' }, options);
  assert.match((await f.module.run({ ...f.ctx, session: { id: 'third' } }, { task: '查询四' }, options)).content, /并发已达上限/);
  f.cfg.subagent.enabled = false;
  f.module.syncConfig();
  for (const release of releases) release(response(null, [call('memory_query')]));
  for (const result of await Promise.all([first, second])) assert.equal(result.isError, true);
  assert.equal(f.logs.some((line) => line.includes('name=memory_query')), false);
  assert.equal(f.module.pending.size, 0);
  assert.equal(f.ctx.session.subagentRuns[0].status, 'cancelled');
});

test('父取消和超时中止模型，错误不自动重试，不在日志记录任务和异常内容', async (t) => {
  const f = fixture(), controller = new AbortController();
  f.ctx.signal = controller.signal;
  let requests = 0;
  const options = { getTools: () => f.defs, complete: async (_messages, { signal }) => {
    requests++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('secret-error')), { once: true }));
  } };
  const job = f.module.run(f.ctx, { task: 'secret-task' }, options);
  controller.abort();
  assert.equal((await job).isError, true);
  assert.equal(requests, 1);
  const g = fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timeout = g.module.run(g.ctx, { task: 'secret-task' }, options);
  t.mock.timers.tick(45000);
  assert.equal((await timeout).isError, true);
  assert.match(g.logs.at(-1), /status=cancelled/);
  assert.doesNotMatch([...f.logs, ...g.logs].join('\n'), /secret-task|secret-error/);
});

test('真实日志沿用父trace与subagent scope，失败也有结束事件', async (t) => {
  const originalLog = console.log, oldFormat = process.env.QQ_AGENT_LOG_FORMAT, oldLevel = process.env.QQ_AGENT_LOG_LEVEL;
  const lines = [];
  console.log = (line) => lines.push(JSON.parse(line));
  process.env.QQ_AGENT_LOG_FORMAT = 'json'; process.env.QQ_AGENT_LOG_LEVEL = 'info';
  t.after(() => {
    console.log = originalLog;
    if (oldFormat === undefined) delete process.env.QQ_AGENT_LOG_FORMAT; else process.env.QQ_AGENT_LOG_FORMAT = oldFormat;
    if (oldLevel === undefined) delete process.env.QQ_AGENT_LOG_LEVEL; else process.env.QQ_AGENT_LOG_LEVEL = oldLevel;
  });
  const f = fixture(); f.module.log = createLogger('subagent');
  await withTrace('1234abcd', () => f.module.run(f.ctx, { task: 'private-task' }, {
    getTools: () => f.defs, complete: async () => { throw new Error('private-error'); }
  }));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.traceId === '1234abcd' && line.scope === 'subagent'));
  assert.match(lines[0].msg, /called id=/);
  assert.match(lines[1].msg, /finished .*status=failed/);
  assert.doesNotMatch(JSON.stringify(lines), /private-task|private-error/);
});
