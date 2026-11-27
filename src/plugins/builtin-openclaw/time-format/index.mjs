import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';

export default defineToolPlugin({
  id: 'openclaw-time-format',
  name: 'OpenClaw 时区换算',
  description: '将带时区的 ISO 8601 时间转换到指定时区。',
  tools: (tool) => [
    tool({
      name: 'convert_timezone',
      description: '将带 UTC 偏移的 ISO 8601 时间换算为指定 IANA 时区的当地时间。',
      parameters: {
        type: 'object',
        properties: {
          timestamp: { type: 'string', description: '例如 2026-11-27T08:00:00Z' },
          timeZone: { type: 'string', description: '例如 Asia/Shanghai' }
        },
        required: ['timestamp', 'timeZone'],
        additionalProperties: false
      },
      execute({ timestamp, timeZone }) {
        if (typeof timestamp !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)
            || typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) {
          throw new Error('请填写带 UTC 偏移的 ISO 8601 时间和 IANA 时区。');
        }
        const formatter = new Intl.DateTimeFormat('zh-CN', {
          timeZone, dateStyle: 'full', timeStyle: 'long'
        });
        return formatter.format(new Date(timestamp));
      }
    })
  ]
});
