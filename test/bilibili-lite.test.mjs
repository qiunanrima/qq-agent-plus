import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writePluginSecrets } from '../src/plugins/secrets.js';
import { parsePluginManifest } from '../src/plugins/manifest.js';
import { PluginHost } from '../src/plugins/host.js';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bilibili-lite-'));
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows handles */ } });
async function startHost(id, settings = {}, options = {}) {
  const dir = path.resolve('examples/plugins', id);
  const parsed = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), { dir });
  assert.equal(parsed.ok, true, parsed.error);
  const host = new PluginHost({ ...options, manifest: parsed.manifest, dataDir, log: () => {}, getSettings: () => settings });
  assert.equal(await host.start(), true, host.lastError);
  return host;
}

test('轻量版与原版独立安装，删除的能力不出现在清单或运行入口', async () => {
  const { packPluginDir } = await import('../src/plugins/pack.js');
  const { installPlugin } = await import('../src/plugins/install.js');
  for (const id of ['bilibili', 'bilibili-lite']) {
    const packed = packPluginDir({ dir: path.resolve('examples/plugins', id) });
    await installPlugin({ id, tarball: packed.buffer, dataDir, hostVersion: '0.9.16', log: () => {} });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'plugins', id, 'plugin.json'), 'utf8')).id, id);
  }
  const manifest = JSON.parse(fs.readFileSync('examples/plugins/bilibili-lite/plugin.json', 'utf8'));
  assert.equal(manifest.tools.length, 9);
  assert.equal(manifest.tools.find((t) => t.name === 'message_send').approvalMode, 'notify');
  assert.equal(manifest.quotas.message_send, 20);
  assert.equal(manifest.tools.find((t) => t.name === 'dynamic_publish').approvalMode, undefined);
  assert.ok(!manifest.capabilities.includes('media'));
  assert.ok(!manifest.approvals.some((a) => a.action === 'danmaku'));
  assert.ok(!manifest.settings.groups.some((g) => g.key === 'playback'));
  const source = fs.readFileSync('examples/plugins/bilibili-lite/index.mjs', 'utf8');
  for (const token of ['async read(', 'async watch(', 'async danmaku_send(', 'cap.media.', 'cap.send.file']) {
    assert.ok(!source.includes(token), token);
  }
});

test('B站发布与私信：真实插件进程通过宿主 HTTP，审批上下文、分页、大整数和未知写结果', async (t) => {
  writePluginSecrets(dataDir, 'bilibili-lite', {
    sessdata: 'test-session', bili_jct: 'test-csrf', dedeuserid: '999'
  }, ['sessdata', 'bili_jct', 'dedeuserid']);
  const calls = [];
  let mode = 'ok';
  const host = await startHost('bilibili-lite', {}, {
    httpMock: async (request) => {
      calls.push(request);
      const url = new URL(request.url);
      const reply = (data) => ({ status: 200, body: JSON.stringify({ code: 0, data }) });
      if (url.pathname === '/x/web-interface/nav') return reply({
        isLogin: true, mid: 42,
        wbi_img: { img_url: 'https://i0.hdslb.com/abcdefghijklmnopqrstuvwxyz123456.png', sub_url: 'https://i0.hdslb.com/123456abcdefghijklmnopqrstuvwxyz.png' }
      });
      if (request.method === 'POST' && mode === 'timeout') throw new Error('request timed out');
      if (request.method === 'POST' && mode === 'broken') return { status: 200, body: '<html>gateway</html>' };
      if (url.pathname === '/x/dynamic/feed/create/dyn') return reply(mode === 'missing' ? {} : { dyn_id_str: '1063487284684259332' });
      if (url.pathname === '/web_im/v1/web_im/send_msg') return reply(mode === 'missing' ? {} : { msg_key: '6984393491767669026' });
      if (url.pathname === '/x/web-interface/popular') return reply({ list: [{ bvid: 'BV1xx411c7mD', title: '热门测试' }] });
      if (url.pathname === '/x/web-interface/view') return reply({ aid: 170001, bvid: 'BV1xx411c7mD', cid: 42, owner: {}, stat: {}, pages: [] });
      if (url.pathname === '/x/v1/dm/list.so') return { status: 200, body: '<i><d p="1,1">测试弹幕</d></i>' };
      if (url.pathname.endsWith('/get_sessions')) return {
        status: 200,
        body: '{"code":0,"data":{"session_list":[{"talker_id":7,"session_ts":1730000000000001,"unread_count":2,"last_msg":{"sender_uid":7,"msg_type":1,"content":"{\\"content\\":\\"你好\\"}","msg_seqno":18446744073709551614}}],"has_more":1}}'
      };
      if (url.pathname.endsWith('/fetch_session_msgs')) return {
        status: 200,
        body: '{"code":0,"data":{"messages":[{"sender_uid":7,"msg_type":1,"msg_status":1,"content":"{\\"content\\":\\"撤回的秘密\\"}","msg_seqno":18446744073709551614}],"min_seqno":18446744073709551614,"has_more":1}}'
      };
      throw new Error(`未预期请求：${url.pathname}`);
    }
  });
  t.after(() => host.stop());
  const owner = { context: { senderIsOwner: true } };
  for (const name of ['read', 'watch', 'danmaku_send']) {
    await assert.rejects(() => host.callTool(name, {}), /没有这个工具/);
  }
  for (const [name, args] of [
    ['account', { what: 'message_sessions', channel: 'console' }],
    ['dynamic_publish', { text: '正文', approved: { action: 'dynamic_publish', target: '' } }],
    ['message_send', { mid: '7', text: '你好' }]
  ]) await assert.rejects(() => host.callTool(name, args), /只有管理员/);
  assert.equal(calls.length, 0);
  for (const args of [{ mid: 'https://example.com', text: 'x' }, { mid: '7', text: '中'.repeat(1000) }, { mid: 7, text: 'x' }]) {
    await assert.rejects(() => host.callTool('message_send', args, owner), /正整数字符串|正文过长/);
  }
  await assert.rejects(() => host.callTool('dynamic_publish', { text: ' ' }, owner), /正文不能为空/);
  assert.equal(calls.length, 0, '坏参数与非管理员读取不应碰网络');

  const popular = await host.callTool('search', { kind: 'popular' });
  assert.equal(popular.results[0].bvid, 'BV1xx411c7mD');
  const video = await host.callTool('video', { bvid: 'BV1xx411c7mD', withComments: false, withDanmaku: true });
  assert.equal(video.danmaku[0].text, '测试弹幕');

  const dynamic = await host.callTool('dynamic_publish', { text: '测试动态' }, {
    context: { approved: { action: 'dynamic_publish', target: '' } }
  });
  assert.equal(dynamic.id, '1063487284684259332');
  const posted = calls.at(-1);
  assert.equal(posted.method, 'POST');
  assert.equal(new URL(posted.url).searchParams.get('csrf'), 'test-csrf');
  assert.equal(posted.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(posted.body).dyn_req.content.contents[0].raw_text, '测试动态');

  const sessions = await host.callTool('account', { what: 'message_sessions', limit: 10, cursor: '1730000000000002' }, owner);
  assert.equal(sessions.results[0].lastMessage.seqno, '18446744073709551614');
  assert.equal(sessions.results[0].lastMessage.text, '你好');
  assert.equal(sessions.nextCursor, '1730000000000001');
  assert.equal(new URL(calls.at(-1).url).searchParams.get('end_ts'), '1730000000000002');
  const history = await host.callTool('account', { what: 'message_history', mid: '7', cursor: '18446744073709551615' }, owner);
  assert.equal(history.nextCursor, '18446744073709551614');
  assert.equal(history.results[0].text, '[已撤回]');
  assert.ok(!JSON.stringify(history).includes('撤回的秘密'));
  assert.equal(new URL(calls.at(-1).url).searchParams.get('end_seqno'), '18446744073709551615');

  const sent = await host.callTool('message_send', { mid: '7', text: '你好' }, {
    context: { approved: { action: 'message_send', target: '7' } }
  });
  assert.equal(sent.ok, true);
  const message = calls.at(-1);
  const form = new URLSearchParams(message.body);
  assert.equal(new URL(message.url).origin, 'https://api.vc.bilibili.com');
  assert.ok(new URL(message.url).searchParams.get('w_rid'));
  assert.equal(form.get('msg[sender_uid]'), '42', '发送者取实际 nav，不信任 Cookie 中的 UID');
  assert.equal(form.get('msg[receiver_id]'), '7');
  assert.deepEqual(JSON.parse(form.get('msg[content]')), { content: '你好' });
  assert.ok(calls.every((r) => !r.url.includes('update_ack')));

  for (mode of ['timeout', 'broken', 'missing']) {
    for (const [name, args] of [['dynamic_publish', { text: '测试' }], ['message_send', { mid: '7', text: '测试' }]]) {
      const before = calls.filter((r) => r.method === 'POST').length;
      await assert.rejects(() => host.callTool(name, args, owner), (e) => e.code === 'E_WRITE_UNKNOWN');
      assert.equal(calls.filter((r) => r.method === 'POST').length, before + 1, '未知写结果绝不重试');
    }
  }
});

