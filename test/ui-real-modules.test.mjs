// 真模块加载（2026-10-01 ESM 化）：用 Node 自己的 ESM 加载器 + happy-dom 的 DOM 全局，
// 按**真模块语义**把 ui/ 整棵树跑起来。
//
// 为什么非有它不可：另外几套 vm 沙箱（render-test / scroll-test / usage-e2e / ui-smoke）
// 都是"把 import/export 剥掉、按 classic script 塞进同一个 context"，也就是说它们测的是
// **剥壳之后**的代码 —— 真解析、真求值顺序（导入图、环上谁先跑）、真 TDZ 它们一概看不见。
// 2026-10-01 就是这套用例抓到的：`startListPoller()` 写在 app.js 的模块顶层，而 app.js 会被
// core/state.js 的依赖链先求值（core/state.js ↔ app.js ↔ pages/* 是同一个 import 环），
// 模块求值期读 state 直接 "Cannot access 'state' before initialization" —— 浏览器白屏，
// 而剥了壳的沙箱全绿（那里 state 按 document 顺序早就初始化好了）。
//
// 覆盖到什么：① 30 个文件都能被真 ESM 加载（语法/解析/specifier 全对）；② 求值期不抛
// （TDZ、顶层副作用）；③ DOMContentLoaded 之后 init() 跑得起来（主题、首屏拉取）。
// 不覆盖：真实 HTTP 的 MIME/缓存（由 static-cache 用例与服务器实测盯）。
//
// **缺 happy-dom 时自动跳过** —— D6 约定：更新器用 --omit=dev 不装 devDeps，这条 skip
// 路径是必须守住的（删了更新器环境会红）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

let WindowClass = null;
try {
  ({ Window: WindowClass } = await import('happy-dom'));
} catch (e) {
  // 只有"依赖确实没装"才跳过（生产/更新器环境是 npm ci --omit=dev）；装了却加载失败
  // （版本与 Node 不兼容 / 包损坏）必须抛出去 —— 否则这层门禁静默消失，CI 照样绿（2026-10-01 审查）。
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}
const SKIP = WindowClass ? false : 'happy-dom 未安装（devDependencies；--omit=dev 环境按约定跳过）';

const UI = path.resolve('ui');
const RAW_HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const SCRIPT_FILES = [...RAW_HTML.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1].replace(/^\//, ''));

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 打桩前先把真定时器抓在手里：桩里再写 setTimeout 就是递归调用自己（2026-10-01 踩过）。
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;

// 把 happy-dom 的全局铺到 globalThis —— 真模块里的裸标识符（document/window/Element/…）
// 只能这么解析到；Node 里没有别的办法让浏览器代码跑起来。
//
// 两条规矩：
// ① **不许整体覆盖 globalThis**：happy-dom 的 window 把 JS 内建（Object/Promise/Map…）也当自家
//    属性暴露，照抄过来就是跨 realm 传对象 —— 2026-10-01 实测直接把 Node 打崩
//    （`Assertion failed: isolate_data`，V8 原生断言）。所以 ECMAScript 内建一律留 Node 的，
//    只覆盖 DOM/浏览器那层。
// ② 要覆盖的名字得**显式列出来**：Node 自己也有一份 fetch / navigator / localStorage /
//    Event / WebSocket，只补"Node 里没有的"会让 ui 代码拿到半套 Node 实现
//    （fetch 打真网络、Event 不是 happy-dom 的），那测的就不是浏览器了。
const DOM_GLOBALS = [
  'document', 'window', 'location', 'navigator', 'history', 'screen', 'customElements', 'CSS',
  'localStorage', 'sessionStorage', 'fetch', 'EventSource', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement',
  'HTMLDialogElement', 'DocumentFragment', 'Text', 'Image', 'DOMParser', 'XMLHttpRequest',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'InputEvent', 'CloseEvent', 'StorageEvent',
  'MutationObserver', 'NodeFilter', 'TreeWalker', 'NodeIterator', 'DOMException',
];

function patchGlobals(window) {
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis && !DOM_GLOBALS.includes(key)) continue;
    try {
      Object.defineProperty(globalThis, key, { value: window[key], writable: true, configurable: true });
    } catch { /* 有些属性不可重定义，跳过即可 */ }
  }
  globalThis.window = window;
  // 网络类 API 桩掉：控制台的 auto-update-network 会开 WebSocket 探活，测试里不想真连。
  globalThis.WebSocket = class WebSocketStub {
    constructor() { this.readyState = 0; }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  };
  // 启动期会挂 15s 轮询、加载遮罩延时之类的定时器 —— 真定时器会把测试进程一直吊着
  // （2026-10-01 实测：整条用例被拖到超时才退出）。这里换成不落地的桩：被测的是
  // "启动期不抛且装配完成"，不依赖定时器真的触发。
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.setTimeout = (fn, ms) => (ms >= 500 ? 1 : nativeSetTimeout(fn, ms));
  globalThis.clearTimeout = (id) => { if (typeof id === 'number' && id > 1) nativeClearTimeout(id); };
}

async function loadForReal() {
  const window = new WindowClass({ url: 'http://127.0.0.1:3210/' });
  window.document.write(RAW_HTML.replace(/<script[^>]*>\s*<\/script>/g, ''));
  const fetchLog = [];
  window.fetch = async (url) => {
    fetchLog.push(String(url));
    return { ok: true, status: 200, json: async () => ({}) };
  };
  window.EventSource = class EventSourceStub { addEventListener() {} close() {} };
  // 浏览器里的真实时序：**module 脚本执行期 readyState 已经是 'interactive'**（规范：解析结束
  // 先置 interactive，再跑 defer/module 脚本，最后才发 DOMContentLoaded 并置 complete）。
  // 第一版 app.js 把判据写成 `=== 'loading'`，就是在这里被"测不出来"放过去的 —— 真浏览器
  // 直接走了 else 分支白屏。显式对齐成 'interactive'，才算真的在测线上那条路径。
  Object.defineProperty(window.document, 'readyState', { value: 'interactive', configurable: true, writable: true });
  const errors = [];
  window.addEventListener('error', (event) => errors.push(String(event?.error ?? event?.message ?? event)));
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason));
  process.on('unhandledRejection', onRejection);
  patchGlobals(window);
  const loaded = [];
  try {
    // 按 index.html 的顺序 import：浏览器就是按文档顺序开始求值第一棵模块图的
    for (const rel of SCRIPT_FILES) {
      await import(pathToFileURL(path.join(UI, rel)).href);
      loaded.push(rel);
    }
  } catch (error) {
    process.off('unhandledRejection', onRejection);
    throw new Error(`真模块加载在第 ${loaded.length + 1} 个文件（${SCRIPT_FILES[loaded.length]}）挂了：\n${error?.stack ?? error}`);
  }
  return { window, fetchLog, errors, rejections, loaded, onRejection };
}

test('真 ESM：整棵树能按真模块语义加载，且 DOMContentLoaded 之后 init() 装配得起来', { skip: SKIP }, async () => {
  const ctx = await loadForReal();
  try {
    // ① 模块图：30 个文件全加载、求值期不抛（TDZ / 顶层副作用）
    assert.deepEqual(ctx.loaded, SCRIPT_FILES, '每个 ui 文件都应被真模块加载器加载成功');
    assert.deepEqual(ctx.errors, [], `加载期出现未捕获错误：${ctx.errors.join(' | ')}`);
    await settle(50);
    assert.deepEqual(ctx.rejections, [], `模块求值期有未处理的拒绝：\n${ctx.rejections.join('\n')}`);
    // QARegistry 的底座是 app.js 在**模块顶层**登记的：这一步过了说明 app.js 真的被求值了
    const snapshot = ctx.window.QARegistry?.snapshot?.();
    assert.ok(snapshot, 'window.QARegistry 应该在（core/registry.js 的显式对外面）');
    assert.equal(snapshot.bases.length, 8, `8 个渲染入口底座都应登记：${snapshot.bases.join(',')}`);

    // ② 启动。真浏览器里 DOMContentLoaded 是解析完之后自己发的；happy-dom 给 document.write
    // 收尾时也会发一次，所以先等一会儿（此时初始化应当已经跑起来了），再补发一次作为兜底
    // （app.js 用 { once: true } 注册，重复派发是空操作）。
    //
    // 这一段的**回归判据**是上面那两条 errors/rejections：2026-10-01 第一版 app.js 把
    // "等模块图求值完"写成 `readyState === 'loading'`，真浏览器里那时是 'interactive'，
    // 于是 init 在模块求值期就跑 → 读 state 踩 TDZ → 白屏 + 一条 unhandledRejection。
    // 用例这边把 readyState 显式设成 'interactive'（对齐浏览器），这条断言就会红。
    await settle(150);
    ctx.window.document.readyState = 'complete';
    ctx.window.document.dispatchEvent(new ctx.window.Event('DOMContentLoaded'));
    await settle(250);
    assert.deepEqual(ctx.errors, [], `启动期出现未捕获错误：${ctx.errors.join(' | ')}`);
    assert.deepEqual(ctx.rejections, [], `init() 抛出未处理的拒绝（线上就是白屏 + 控制台一条红）：\n${ctx.rejections.join('\n')}`);
    const theme = ctx.window.document.documentElement.getAttribute('data-theme');
    assert.ok(theme === 'light' || theme === 'dark', `init 应把主题写进 data-theme，实际 ${theme}`);
    assert.ok(ctx.fetchLog.some((u) => u.includes('/api/config')), `init 应该去拉配置，实际请求：${ctx.fetchLog.join(', ')}`);
  } finally {
    process.off('unhandledRejection', ctx.onRejection);
    ctx.window.happyDOM?.abort?.();
  }
});

// 回归用例（2026-10-01 审查）：renderChatList 的空状态提示曾经直接写 box.innerHTML —— 那层节点
// 没有 data-key，patchKeyedList 既不把它算进 existing、也不会删它，列表重新有内容后它就被新行
// 顶到最底部一直留着（只有刷新页面能清）。这条用例把"空 → 有 → 空"跑一遍，盯住提示的来去。
test('真 ESM：存档页的空状态提示会随数据回来消失', { skip: SKIP }, async () => {
  const ctx = await loadForReal();
  try {
    const { loadChats } = await import(pathToFileURL(path.join(UI, 'pages/chat.js')).href);
    const box = ctx.window.document.querySelector('#chat-items');
    assert.ok(box, 'index.html 里应该有 #chat-items（存档列表容器）');

    let chats = [];
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes('/api/chats') ? { chats } : {})
    });

    await loadChats();                        // ① 空列表 → 出现空状态提示
    assert.match(box.textContent, /还没有消息存档/, '空列表应给出空状态提示');
    assert.equal(box.querySelectorAll('.chat-item').length, 0);

    chats = [{ key: 'group:1', lastText: 'hi', total: 1, failed: 0, held: 0, lastTs: Date.now(), unread: 0 }];
    await loadChats();                        // ② 来了消息 → 提示必须被清掉（这条就是回归判据）
    assert.equal(box.querySelectorAll('.chat-item').length, 1, '来消息后应渲染出一行');
    assert.equal(box.querySelectorAll('.list-head').length, 0, '空状态提示必须随数据回来消失');

    chats = [];
    await loadChats();                        // ③ 又空了 → 提示还要能回来
    assert.equal(box.querySelectorAll('.list-head').length, 1, '重新为空时提示要能再出现');
  } finally {
    process.off('unhandledRejection', ctx.onRejection);
    ctx.window.happyDOM?.abort?.();
  }
});

test('真 ESM：清除存档后空增量会丢弃旧缓存，清除前的迟到响应不能恢复旧消息', { skip: SKIP }, async () => {
  const ctx = await loadForReal();
  try {
    const { loadChats, invalidateChatArchive } = await import(pathToFileURL(path.join(UI, 'pages/chat.js')).href);
    const { state } = await import(pathToFileURL(path.join(UI, 'core/state.js')).href);
    const key = 'group:123456';
    const old = { id: 100, text: '必须删除的旧存档', senderId: '42', senderName: '甲', ts: Date.now(), read: true, media: [] };
    let messages = [old];
    const response = (data) => ({ ok: true, status: 200, json: async () => data });
    globalThis.fetch = async (url) => response(String(url).includes('/messages')
      ? { messages, total: messages.length, hasMore: false }
      : { chats: [{ key, total: messages.length, unread: 0, failed: 0, held: 0 }] });
    state.currentChatKey = key;
    state.chatMessages = [];
    await loadChats();
    assert.match(ctx.window.document.querySelector('#chat-msg-body').textContent, /必须删除/);
    messages = [];
    await loadChats();
    assert.deepEqual(state.chatMessages, []);
    assert.doesNotMatch(ctx.window.document.querySelector('#chat-detail').textContent, /必须删除/);
    assert.match(ctx.window.document.querySelector('[data-field="chat-msg-count"]').textContent, /暂无消息/);

    let resolveOld;
    let requested;
    const started = new Promise((resolve) => { requested = resolve; });
    globalThis.fetch = async (url) => {
      if (String(url).includes('/messages')) return new Promise((resolve) => { resolveOld = resolve; requested(); });
      return response({ chats: [{ key, total: 1, unread: 0, failed: 0, held: 0 }] });
    };
    const pending = loadChats();
    await started;
    invalidateChatArchive();
    resolveOld(response({ messages: [old], total: 1, hasMore: true, nextBefore: 100 }));
    await pending;
    assert.deepEqual(state.chatMessages, []);
    assert.equal(state.chatHasMore, false);
    assert.equal(state.chats[0].total, 0);
    assert.doesNotMatch(ctx.window.document.querySelector('#chat-detail').textContent, /必须删除/);
  } finally {
    process.off('unhandledRejection', ctx.onRejection);
    ctx.window.happyDOM?.abort?.();
  }
});
