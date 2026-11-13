/** Return actual MCP image blocks, never a JSON description of image input. */
export function toMcpContent(value) {
  if (!Array.isArray(value)) return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? '') }];
  return value.map(part => {
    if (part?.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part?.type === 'image_url') {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url?.url || '');
      if (match && match[2].length % 4 === 0) return { type: 'image', mimeType: match[1], data: match[2] };
      return { type: 'text', text: '图片未传入模型：MCP 仅接受受控工具返回的 base64 图像；不要声称已经看过图片。' };
    }
    return { type: 'text', text: '工具返回了不支持的内容格式。' };
  });
}
