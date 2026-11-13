// 平台能力的「模拟群环境」验收（2026-10-07，用户要求：不要在真实群里测）。
// 做法：起一个**假的 SnowLuma HTTP 服务**当协议端（POST /<action> → {status:'ok',retcode:0,data}），
// 把**真的** OneBotClient / 工具 / SendQueue / Orchestrator 接到它上面走完整 HTTP 链路，
// 断言协议端实际收到的 action、参数与鉴权头 —— 写入类能力（贴表情/发语音/传文件/传相册/已读）
// 全部在这里验收；真实群只保留只读观测。
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sim-group-'));
process.env.QQ_AGENT_DATA_DIR = dir;
// Windows 上句柄可能还没释放（rm 会 EPERM）——清理失败不该让整个文件判失败。
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 留着也无害 */ } });
fs.writeFileSync(path.join(dir, 'face-names.json'), JSON.stringify({ bySid: { 14: '微笑', 128077: '强' } }));

const { ChatStore } = await import('../src/core/store.js');
const { SendQueue } = await import('../src/onebot/sender.js');
const { OneBotClient } = await import('../src/onebot/onebot.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');
const { SessionRegistry } = await import('../src/core/sessions.js');
const { buildToolDefs, resetPlatformQuotasForTest } = await import('../src/tools/tools-core.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { buildSystemPrompt } = await import('../src/llm/prompt.js');

const base = structuredClone(DEFAULT_CONFIG);
base.runtime.mode = 'active';
base.allow.groups = ['1'];
base.allow.private = ['2'];
base.api.model = 'test';
base.api.baseUrl = 'https://model.invalid';
base.sticker.enabled = false;
base.memory.consolidateEnabled = false;
setRuntimeConfig(base);

/**
 * 假 SnowLuma：POST /<action>，把 {action, params, headers} 记进 calls，回 {status:'ok',retcode:0,data}。
 * respond(action, params) 给 data；envelope(action, params) 可整体接管响应体（造失败响应用，返回 null 走默认）。
 */
function startFakeSnowLuma({ respond = () => ({}), envelope = null } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const action = String(req.url || '/').replace(/^\/+/, '').split('?')[0];
      let params = null;
      try { params = JSON.parse(raw || '{}'); } catch { params = raw; }
      calls.push({ action, params, headers: req.headers, method: req.method });
      const override = envelope ? envelope(action, params) : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(override ?? { status: 'ok', retcode: 0, data: respond(action, params) ?? {} }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        calls,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        byAction: (name) => calls.filter((c) => c.action === name),
        last: (name) => calls.filter((c) => c.action === name).at(-1)
      });
    });
  });
}

/** 起假协议端 + 真客户端，跑完 body 就收摊。 */
async function withSim(options, body) {
  const sim = await startFakeSnowLuma(options);
  const client = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', httpUrl: sim.url, httpToken: options?.token });
  try {
    return await body(sim, client);
  } finally {
    await sim.close();
  }
}

const tool = (name) => {
  const def = buildToolDefs().find((d) => d.name === name);
  assert.ok(def, `工具 ${name} 应存在`);
  return def;
};
const parse = (r) => JSON.parse(r.content);
const groupCtx = (client, overrides = {}) => ({
  kind: 'group', chatId: '1', chatKey: 'group:1',
  session: { id: 's', sent: [], leaseId: 'l' },
  onebot: client,
  store: { findByMid: () => ({ mid: 77 }), recent: () => [] },
  emit: () => {},
  ...overrides
});

it('模拟群：表情回应 / 查回应 / 群资料 / 签到 / 待办 / QQ语音 / OCR 走真 HTTP（含鉴权头）', async () => {
  resetPlatformQuotasForTest();
  const store = new ChatStore(0, { dataDir: dir });
  try {
    await withSim({
      token: 'sim-token',
      respond: (action) => {
        if (action === 'get_msg_emoji_likes') return [{ emoji_id: '14', count: 1, users: [{ user_id: 2002 }] }];
        if (action === 'get_group_detail_info') return { group_name: '模拟群', group_memo: '简介', member_count: 3 };
        if (action === '_get_group_notice') return [{ publish_time: 1, message: { text: '周三维护' } }];
        if (action === 'get_group_honor_info') return { talkative: { users: [] } };
        if (action === 'get_ai_characters') return [{ type: '热门', characters: [{ character_id: 'c1', character_name: '小新' }] }];
        if (action === 'ocr_image') return { texts: [{ text: '第一行' }, { text: '第二行' }] };
        return {};
      }
    }, async (sim, client) => {
      // 发送类工具经真 SendQueue（限频/禁言预检/outbox 全在链上）
      const ctx = groupCtx(client, { sender: new SendQueue({ store, onebot: client }) });

    // ① 贴表情回应（写类，此前只在真实群里试过 —— 现在打在模拟协议端上）
    const reacted = parse(await tool('react_to_message').execute(ctx, { messageId: '77', emojiId: 14 }));
    assert.equal(reacted.reacted, true);
    const react = sim.last('set_msg_emoji_like');
    assert.equal(react.method, 'POST');
    assert.equal(react.headers['content-type'], 'application/json');
    assert.equal(react.headers.authorization, 'Bearer sim-token', 'HTTP 令牌要带上');
    assert.deepEqual(react.params, { message_id: 77, emoji_id: '14', set: true });

    // ② 查回应：表情名与贴的人都解析出来
    const seen = parse(await tool('get_message_reactions').execute(ctx, { messageId: '77' }));
    assert.deepEqual(sim.last('get_msg_emoji_likes').params, { message_id: 77 });
    assert.equal(seen.reactions[0].name, '微笑');
    assert.equal(seen.reactions[0].users[0].userId, '2002');

    // ③ 群资料三件套
    const profile = parse(await tool('get_group_profile').execute(ctx, {}));
    assert.deepEqual(sim.last('get_group_detail_info').params, { group_id: 1 });
    assert.deepEqual(sim.last('_get_group_notice').params, { group_id: 1 });
    assert.deepEqual(sim.last('get_group_honor_info').params, { group_id: 1, type: 'all' });
    assert.equal(profile.detail.name, '模拟群');
    assert.equal(profile.detail.intro, '简介');
    assert.equal(profile.notices[0].text, '周三维护');

    // ④ 签到 / 群待办
    await tool('group_sign').execute(ctx, {});
    assert.deepEqual(sim.last('set_group_sign').params, { group_id: 1 });
    await tool('set_group_todo').execute(ctx, { messageId: '#77' });
    assert.deepEqual(sim.last('set_group_todo').params, { group_id: 1, message_id: 77 });

    // ⑤ QQ 语音：两段式（先拿角色列表，再带 character 发）
    const list = parse(await tool('send_qq_voice').execute(ctx, { text: '大家好呀' }));
    assert.deepEqual(sim.last('get_ai_characters').params, { group_id: 1 });
    assert.deepEqual(list.characters, [{ characterId: 'c1', name: '小新', category: '热门' }]);
    await tool('send_qq_voice').execute(ctx, { text: '大家好呀', character: 'c1' });
    assert.deepEqual(sim.last('send_group_ai_record').params, { group_id: 1, character: 'c1', text: '大家好呀' });
    // 留档是"真的走了发送队列"的证据：直接 onebot.call 的路径不会往自己的存档里写这条
    assert.ok(store.recent('group:1', { limit: 20 }).some((m) => m.self && m.text.includes('[QQ语音]')),
      '语音要经发送队列留档（绕过队列 = 无限频、无 outbox）');

    // 控制台固定音色 → 不再拉目录，直接按固定音色发（同样真发到模拟协议端）
    const pinned = structuredClone(base);
    pinned.platform = { ...base.platform, qqVoiceCharacter: 'lucy-voice-daji' };
    setRuntimeConfig(pinned);
    try {
      const beforeLists = sim.byAction('get_ai_characters').length;
      await tool('send_qq_voice').execute(ctx, { text: '俺也一样' });
      assert.equal(sim.byAction('get_ai_characters').length, beforeLists, '固定音色后不该再拉角色目录');
      assert.deepEqual(sim.last('send_group_ai_record').params,
        { group_id: 1, character: 'lucy-voice-daji', text: '俺也一样' });
    } finally {
      setRuntimeConfig(base);
    }

    // ⑥ OCR：用消息里的新鲜直链
    const ocr = parse(await tool('read_image_text').execute(
      groupCtx(client, {
        store: { findByMid: () => ({ mid: '5', media: [{ kind: 'image', url: 'https://example.com/a.png' }] }), recent: () => [] }
      }),
      { messageId: '5' }
    ));
    assert.deepEqual(sim.last('ocr_image').params, { image: 'https://example.com/a.png' });
    assert.equal(ocr.text, '第一行\n第二行');
    });
  } finally {
    store.close();
  }
});

it('模拟群：签名 / 在线状态 / 备注 / 陌生人资料 / 翻译 走真 HTTP', async () => {
  resetPlatformQuotasForTest();
  // 这条用例连发 2 次资料 + 2 次备注，显式把额度放宽（默认值会随"真人标准"继续调，
  // 写死默认值的用例会跟着红 —— 这里验的是 wire 形状，不是额度）
  setRuntimeConfig({ ...base, platform: { ...base.platform, quotas: { ...base.platform.quotas, profilePerDay: 5, remarksPerDay: 5 } } });
  await withSim({
    respond: (action) => {
      if (action === 'get_stranger_info') return { nickname: '甲', sex: 'male', age: 20 };
      if (action === 'translate_en2zh') return { words: ['你好'] };
      return {};
    }
  }, async (sim, client) => {
    const ctx = groupCtx(client);
    await tool('set_my_signature').execute(ctx, { signature: '摸鱼中' });
    assert.deepEqual(sim.last('set_self_longnick').params, { long_nick: '摸鱼中' });
    await tool('set_my_status').execute(ctx, { wording: '睡觉中' });
    assert.deepEqual(sim.last('set_diy_online_status').params, { face_id: 0, face_type: 1, wording: '睡觉中' });
    await tool('set_remark').execute(ctx, { remark: '龙王甲' });
    assert.deepEqual(sim.last('set_group_remark').params, { group_id: 1, remark: '龙王甲' });
    await tool('set_remark').execute(ctx, { remark: '小博美', userId: '2002' });
    assert.deepEqual(sim.last('set_friend_remark').params, { user_id: 2002, remark: '小博美' });

    const info = parse(await tool('get_user_info').execute(ctx, { userId: '2002' }));
    assert.deepEqual(sim.last('get_stranger_info').params, { user_id: 2002 });
    assert.equal(info.nickname, '甲');

    const tr = parse(await tool('translate_text').execute(ctx, { text: 'hello' }));
    assert.deepEqual(sim.last('translate_en2zh').params, { words: ['hello'] });
    assert.equal(tr.translation, '你好');
  });
  setRuntimeConfig(base);   // 还原额度，别把收紧后的默认值漏到后面的用例里
});

it('模拟群：换头像 / 改 QQ 资料走真 HTTP；改昵称后登录信息随之刷新', async () => {
  resetPlatformQuotasForTest();
  const store = new ChatStore(0, { dataDir: dir });
  try {
    await withSim({
      respond: (action) => {
        if (action === 'get_login_info') return { user_id: 10086, nickname: '犊子二号' };
        return {};
      }
    }, async (sim, client) => {
      const ctx = groupCtx(client, {
        store: { findByMid: () => ({ mid: '9', media: [{ kind: 'image', url: 'https://example.com/pic.png' }] }), recent: () => [] },
        // 本地托管的图（base64）——与 send_sticker 同一口径，不走外网探活
        stickers: { findForSend: async () => ({ id: 'st1', url: 'base64://aGVsbG8=', localFile: 'f.png' }) }
      });

      const avatar = parse(await tool('set_my_avatar').execute(ctx, { messageId: '9' }));
      assert.equal(avatar.changed, true);
      assert.deepEqual(sim.last('set_qq_avatar').params, { file: 'https://example.com/pic.png' });

      const prof = parse(await tool('set_my_profile').execute(ctx, { nickname: '犊子二号', sex: 1 }));
      assert.equal(prof.nickname, '犊子二号');
      assert.deepEqual(sim.last('set_qq_profile').params, { nickname: '犊子二号', sex: 1 });
      assert.equal(sim.byAction('get_login_info').length, 1, '改昵称后要重新拉一次登录信息');
      assert.equal(client.selfNickname, '犊子二号', '真客户端要把新昵称带回来（@我 判定靠它）');
    });
  } finally {
    store.close();
  }
});

it('模拟群：群文件（列目录 / 直链 / 发文本与直链文件）走真 HTTP', async () => {
  const store = new ChatStore(0, { dataDir: dir });
  try {
    await withSim({
      respond: (action) => {
        if (action === 'get_group_root_files') {
          return { files: [{ file_name: '名单.txt', file_size: 2048, file_id: 'f1', uploader_name: '群主' }], folders: [{ folder_name: '照片' }] };
        }
        if (action === 'get_group_file_url') return { url: 'https://example.com/f1' };
        if (action === 'upload_group_file') return { file_id: 'up1' };
        return {};
      }
    }, async (sim, client) => {
      const ctx = groupCtx(client, { sender: new SendQueue({ store, onebot: client }) });
      const listing = parse(await tool('list_group_files').execute(ctx, {}));
      assert.deepEqual(sim.last('get_group_root_files').params, { group_id: 1 });
      assert.equal(listing.files[0].fileId, 'f1');
      assert.deepEqual(listing.folders, ['照片']);

      const url = parse(await tool('group_file_url').execute(ctx, { fileId: 'f1' }));
      assert.deepEqual(sim.last('get_group_file_url').params, { group_id: 1, file_id: 'f1' });
      assert.equal(url.url, 'https://example.com/f1');

      // 文本 → base64 文件；直链 → 原样转发（都经真发送队列到协议端）
      await tool('send_group_file').execute(ctx, { text: '第一行', name: '名单.txt' });
      const byText = sim.last('upload_group_file').params;
      assert.equal(byText.name, '名单.txt');
      assert.equal(Buffer.from(byText.file.slice('base64://'.length), 'base64').toString('utf8'), '第一行');
      await tool('send_group_file').execute(ctx, { url: 'https://example.com/a.pdf', name: 'a.pdf' });
      assert.equal(sim.last('upload_group_file').params.file, 'https://example.com/a.pdf');
      assert.ok(store.recent('group:1', { limit: 20 }).some((m) => m.self && m.text.includes('[群文件]')),
        '文件要经发送队列留档（绕过队列 = 无限频、无 outbox）');
    });
  } finally {
    store.close();
  }
});

it('模拟群：群相册（列表 / 照片 / 点赞 / 评论 / 上传）走真 HTTP', async () => {
  resetPlatformQuotasForTest();
  const store = new ChatStore(0, { dataDir: dir });
  try {
    await withSim({
      respond: (action) => {
        if (action === 'get_group_album_list') return [{ id: 'alb1', name: '日常', picNum: 12 }];
        if (action === 'get_group_album_media_list') {
          return { media_list: [{ lloc: 'lo1', batch_id: 'b1', uploader_name: '甲', desc: '合影' }] };
        }
        return {};
      }
    }, async (sim, client) => {
      const ctx = groupCtx(client, { sender: new SendQueue({ store, onebot: client }) });
      const albums = parse(await tool('list_group_album').execute(ctx, {}));
      assert.deepEqual(sim.last('get_group_album_list').params, { group_id: 1 });
      assert.equal(albums.albums[0].name, '日常');

      const photos = parse(await tool('list_group_album').execute(ctx, { albumId: 'alb1' }));
      assert.deepEqual(sim.last('get_group_album_media_list').params, { group_id: 1, album_id: 'alb1' });
      assert.equal(photos.photos[0].lloc, 'lo1');

      await tool('like_album_photo').execute(ctx, { albumId: 'alb1', batchId: 'b1' });
      assert.deepEqual(sim.last('set_group_album_media_like').params, { group_id: 1, album_id: 'alb1', batch_id: 'b1' });
      await tool('comment_album_photo').execute(ctx, { albumId: 'alb1', lloc: 'lo1', content: '哈哈' });
      assert.deepEqual(sim.last('do_group_album_comment').params, { group_id: 1, album_id: 'alb1', lloc: 'lo1', content: '哈哈' });

      // 上传：没给 albumId → 先查第一个相册，再经真发送队列上传
      await tool('upload_to_group_album').execute(
        groupCtx(client, {
          sender: new SendQueue({ store, onebot: client }),
          store: { findByMid: () => ({ mid: '9', media: [{ kind: 'image', url: 'https://example.com/pic.png' }] }), recent: () => [] }
        }),
        { messageId: '9' }
      );
      assert.deepEqual(sim.last('upload_image_to_qun_album').params,
        { group_id: 1, album_id: 'alb1', album_name: '日常', file: 'https://example.com/pic.png' });
      assert.ok(store.recent('group:1', { limit: 20 }).some((m) => m.self && m.text.includes('[群相册]')),
        '相册上传要经发送队列留档（绕过队列 = 无限频、无 outbox）');
    });
  } finally {
    store.close();
  }
});

it('模拟群：私聊「正在输入」先亮再发文本（真 sender 全链路）；群聊不亮', async () => {
  const store = new ChatStore(0, { dataDir: dir });
  try {
    await withSim({ respond: () => ({ message_id: 9001 }) }, async (sim, client) => {
      const sender = new SendQueue({ store, onebot: client });
      const out = await sender.sendTextBatch('private:2', ['你好']);
      assert.equal(out.sent.length, 1);

      const typing = sim.last('set_input_status');
      const text = sim.last('send_private_msg');
      assert.deepEqual(typing.params, { user_id: 2, event_type: 1 });
      assert.deepEqual(text.params, { user_id: 2, message: [{ type: 'text', data: { text: '你好' } }] });
      assert.ok(sim.calls.indexOf(typing) < sim.calls.indexOf(text), '先亮输入状态，再发消息');

      // 群聊没有输入状态这个概念：不多发任何请求
      await sender.sendTextBatch('group:1', ['大家好']);
      assert.equal(sim.byAction('set_input_status').length, 1, '群聊不该有 set_input_status');
      assert.deepEqual(sim.last('send_group_msg').params, { group_id: 1, message: [{ type: 'text', data: { text: '大家好' } }] });
    });
  } finally {
    store.close();
  }
});

it('模拟群：typingIndicator 关掉后不再亮输入状态（消息照发）', async () => {
  const cfg = structuredClone(base);
  cfg.send.typingIndicator = false;
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: dir });
  try {
    await withSim({ respond: () => ({ message_id: 9002 }) }, async (sim, client) => {
      const sender = new SendQueue({ store, onebot: client });
      await sender.sendTextBatch('private:2', ['在吗']);
      assert.equal(sim.byAction('set_input_status').length, 0);
      assert.equal(sim.byAction('send_private_msg').length, 1, '开关只影响输入状态，不影响发送');
    });
  } finally {
    setRuntimeConfig(base);
    store.close();
  }
});

it('模拟群：合并转发卡片 sendForwardCard 走 send_forward_msg 并留档', async () => {
  const store = new ChatStore(0, { dataDir: dir });
  try {
    await withSim({ respond: () => ({ message_id: 7 }) }, async (sim, client) => {
      const sender = new SendQueue({ store, onebot: client });
      const nodes = [{ type: 'node', data: { nickname: '犊子', content: [{ type: 'text', data: { text: '昨天群里聊了…' } }] } }];
      const out = await sender.sendForwardCard('group:1', nodes, {});
      assert.deepEqual(sim.last('send_forward_msg').params, { message_type: 'group', group_id: 1, messages: nodes });
      assert.equal(out.message_id, 7);
      // 取最后一条自己的存档（本文件共用数据目录，前面的用例也往 group:1 发过）
      const self = store.recent('group:1', { limit: 10 }).filter((m) => m.self).at(-1);
      assert.ok(self && self.text.includes('聊天记录卡片'), '卡片要进自己的存档');
    });
  } finally {
    store.close();
  }
});

it('模拟群：已读回执开 → 标这批最后一条；运行照常收尾', async () => {
  await withSimOrchestrator({ readReceipts: true, mids: [11, 12] }, async ({ sim, sessions, lastMid }) => {
    const marks = sim.byAction('mark_msg_as_read');
    assert.equal(marks.length, 1, '开着开关就要标一次');
    assert.deepEqual(marks[0].params, { message_id: lastMid }, '只标这批的最后一条（QQ 已读是"读到某条"的语义）');
    assert.notEqual(sessions.listSummaries(1)[0].status, 'error', '标已读不能把运行搞挂');
  });
});

it('模拟群：已读回执默认关 → 一个标记请求都不发', async () => {
  await withSimOrchestrator({ readReceipts: false, mids: [21, 22] }, async ({ sim, sessions }) => {
    assert.equal(sim.byAction('mark_msg_as_read').length, 0);
    // 运行确实跑过（否则"没发标记"是因为压根没跑，用例就是空的）
    assert.equal(sessions.listSummaries(1).length, 1, '这一轮要真跑起来');
    assert.notEqual(sessions.listSummaries(1)[0].status, 'error');
  });
});

it('模拟群：协议端标记已读失败（retcode≠0）→ 只吞掉，不影响运行收尾', async () => {
  await withSimOrchestrator({
    readReceipts: true,
    mids: [31, 32],
    envelope: (action) => (action === 'mark_msg_as_read' ? { status: 'failed', retcode: 100, wording: 'not supported' } : null)
  }, async ({ sim, sessions }) => {
    assert.equal(sim.byAction('mark_msg_as_read').length, 1, '确实发起过（失败路径被走到）');
    assert.notEqual(sessions.listSummaries(1)[0].status, 'error', 'best-effort：标记失败不能影响本轮');
  });
});

/** 读回执用例的公共台架：真编排器 + 真客户端 + 假协议端，两条未读进来跑一轮。
 *  mids 每个用例必须各不相同：同库同 mid 的重复消息会被 store 去重（duplicate），
 * 没有新未读时唤醒会直接返回 —— 用例就变成空跑。 */
async function withSimOrchestrator({ readReceipts = false, envelope = null, mids = [11, 12] }, check) {
  const cfg = structuredClone(base);
  cfg.platform = { ...base.platform, readReceipts };
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: dir });
  const sim = await startFakeSnowLuma({
    respond: (action) => {
      if (action === 'get_group_info') return { group_name: '模拟群' };
      if (action === 'get_group_member_info') return { nickname: '群友' };
      if (action === 'get_stranger_info') return { nickname: '群友' };
      return {};
    },
    envelope
  });
  const client = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', httpUrl: sim.url });
  const sessions = new SessionRegistry();
  const sender = new SendQueue({ store, onebot: client });
  const runner = new Orchestrator({ store, sessions, sender, onebot: client, stickers: {}, memory: { formatForPrompt: () => '' } });
  // LLM 走全局 fetch —— 只挡住模型端点，协议端的 127.0.0.1 必须放行给真 fetch，
  // 否则真 OneBotClient 的 HTTP 请求会被这个桩吞掉、根本到不了假 SnowLuma。
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input?.url ?? ''));
    if (url.startsWith(sim.url)) return realFetch(input, init);
    return Response.json({ choices: [{ message: { content: '好' } }], usage: { total_tokens: 5 } });
  };
  try {
    store.appendIncoming('group:1', { mid: mids[0], text: '在吗', senderId: '42', senderName: '群友' });
    store.appendIncoming('group:1', { mid: mids[1], text: '看看这个', senderId: '43', senderName: '群友乙' });
    await runner.wake('group:1');
    // #markBatchRead 是 best-effort 微任务（不阻塞运行收尾），等它落地
    await new Promise((resolve) => setTimeout(resolve, 80));
    await check({ sim, store, sessions, runner, client, lastMid: mids[1] });
  } finally {
    globalThis.fetch = realFetch;
    try { await runner.abortAll(); } catch { /* 已结束 */ }
    store.close();
    await sim.close();
  }
}

it('系统提示不再重复平台工具清单，能力以本轮工具定义为准', () => {
  for (const platform of [{}, { reactions: false, groupWrites: false, albumRead: false }, { avatarWrites: true, nicknameWrites: true }]) {
    const cfg = structuredClone(base);
    cfg.platform = { ...cfg.platform, ...platform };
    setRuntimeConfig(cfg);
    const prompt = buildSystemPrompt({ persona: { ...cfg.persona, roleText: '', templateId: '' }, platform: cfg.platform });
    assert.match(prompt, /工具名、参数和权限以本轮工具表为准/);
    assert.doesNotMatch(prompt, /react_to_message|set_my_avatar|set_my_profile|list_group_album|【玩法与工具箱】/);
  }
  setRuntimeConfig(base);
});
