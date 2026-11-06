import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMcpContent } from '../src/antigravity-cli/mcp-content.js';
test('MCP images remain image blocks alongside text', () => {
  assert.deepEqual(toMcpContent([{ type: 'text', text: 'image' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }]),
    [{ type: 'text', text: 'image' }, { type: 'image', mimeType: 'image/png', data: 'YQ==' }]);
});
test('remote images are never fetched by the bridge or claimed as visible', () => {
  const result = toMcpContent([{ type: 'image_url', image_url: { url: 'http://127.0.0.1/private' } }]);
  assert.equal(result[0].type, 'text'); assert.match(result[0].text, /图片未传入模型/);
  assert.deepEqual(toMcpContent('pong'), [{ type: 'text', text: 'pong' }]);
});
