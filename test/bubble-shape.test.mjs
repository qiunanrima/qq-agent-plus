import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shapeBubbles } from '../src/llm/bubble-shape.js';

test('把一段长回复按句拆成 1–3 条气泡', () => {
  const out = shapeBubbles('今天好累。老板又临时加活，地铁还坐过站。回去只想躺着。明天再说吧。', { maxBubbles: 3, maxChars: 20 });
  assert.ok(out.length >= 1 && out.length <= 3);
  assert.ok(out.every((text) => text.length <= 20 || /。/.test(text) === false));
  assert.equal(out.join('').includes('今天好累'), true);
});

test('已经分好的数组不改变顺序；超过上限时并进最后一条', () => {
  assert.deepEqual(shapeBubbles(['一', '二', '三'], { maxBubbles: 3 }), ['一', '二', '三']);
  assert.deepEqual(shapeBubbles(['一', '二', '三', '四'], { maxBubbles: 3 }), ['一', '二', '三四']);
});

test('尊重模型已分好的长段，不截断 C++ 标识符', () => {
  const messages = [
    'vector<bool> 是位压缩特化的，它的引用不是真正的 bool&，是个代理对象（std::vector<bool>::reference）',
    '直接写 for (auto&& i2 : i1) 或者 auto i2 就能过了'
  ];
  assert.deepEqual(shapeBubbles(messages, { maxBubbles: 3, maxChars: 60 }), messages);
});

test('代码块和 URL 不被拆开', () => {
  const code = '```js\nconst x = 1;\nconsole.log(x);\n```';
  const url = 'https://example.com/a/b?x=1&y=2';
  const out = shapeBubbles([`先看这个 ${url}`, code], { maxBubbles: 3, maxChars: 20 });
  assert.ok(out.some((text) => text.includes(url)));
  assert.ok(out.some((text) => text.includes('const x = 1;')));
});

test('短句原样保留，不为了凑条数硬拆', () => {
  assert.deepEqual(shapeBubbles('在的', { maxBubbles: 3, maxChars: 60 }), ['在的']);
  assert.deepEqual(shapeBubbles('', { maxBubbles: 3 }), []);
});

test('编号回复可以发超过三条，保留各项的说明和代码', () => {
  const code = '~~~text\n9. 这是代码示例\n~~~';
  const items = ['开场白\n1. 第一项\n继续解释', `2. 第二项\n${code}`, '3、第三项', '4）第四项', '5. 第五项'];
  assert.deepEqual(shapeBubbles(items.join('\n'), { maxBubbles: 3, maxChars: 10 }), items);
  assert.deepEqual(shapeBubbles('有两个问题：1. 第一项\n例子是 0.5\n2. 第二项'), [
    '有两个问题：1. 第一项\n例子是 0.5', '2. 第二项'
  ]);
});

test('超过八个编号项时合并相邻项并保留换行', () => {
  const items = Array.from({ length: 10 }, (_, index) => `${index + 1}. 说明`);
  const bubbles = shapeBubbles(items.join('\n'));
  assert.equal(bubbles.length, 8);
  assert.deepEqual(bubbles[0].split('\n'), items.slice(0, 2));
  assert.equal(bubbles.join('\n'), items.join('\n'));
});
