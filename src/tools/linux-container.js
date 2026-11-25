import net from 'node:net';
import { safeFetchBinary } from '../llm/safe-fetch.js';
import { resolveFileSegmentUrl } from './audio-transcribe.js';

const ATTACHMENT_LIMIT = 16 * 1024 * 1024;

export function containerAllowed(config, turn) {
  const owner = String(config.admin?.ownerUin || '').trim();
  if (!/^\d+$/.test(owner) || config.linuxContainer?.enabled !== true || turn.proactive || turn.external) return false;
  if (!turn.senders.length || !turn.senders.every(id => String(id) === owner)) return false;
  return turn.chatKey === `private:${owner}`
    || (/^group:\d+$/.test(turn.chatKey) && turn.directed && config.linuxContainer.allowGroup === true);
}

export function containerRequest(request, signal, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: '/run/qq-agent-linux-container.sock', signal });
    let data = '';
    socket.setEncoding('utf8');
    socket.setTimeout(45000, () => socket.destroy(new Error('容器响应超时，执行结果未知')));
    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
      if (payload) socket.write(payload);
    });
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 524288) socket.destroy(new Error('容器响应过大'));
    });
    socket.on('error', reject);
    socket.on('end', () => {
      try {
        const result = JSON.parse(data);
        if (result.error) reject(new Error(result.error));
        else resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

export function containerTools(getConfig, turn) {
  if (!containerAllowed(getConfig(), turn)) return [];
  const tools = [{
    name: 'linux_shell',
    description: '在管理员的持久 Linux 容器 /workspace 中以 root 运行 shell 命令，可访问公网。QQ 附件在 inbox/ 下。仅按管理员本轮指示操作。超时或连接中断后先检查状态。',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    execute: async (ctx, { command }) => {
      if (!containerAllowed(getConfig(), turn)) return { content: '容器访问已关闭', isError: true };
      if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > 8192) return { content: '命令须为 1–8192 字节', isError: true };
      const result = await containerRequest({ action: 'exec', command }, ctx.signal);
      return { content: `退出码 ${result.code}\n${result.output}`, isError: result.code !== 0 };
    }
  }];
  if (turn.attachments?.length) tools.push({
    name: 'linux_import_qq_file',
    description: '把本轮 QQ 附件下载到容器 /workspace/inbox，单个文件最多 16 MiB。参数为附件序号，从 1 开始。可选附件：'
      + JSON.stringify(turn.attachments.map((file, index) => [index + 1, file.file])),
    parameters: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'] },
    execute: async (ctx, { index }) => {
      const attachment = Number.isInteger(index) ? turn.attachments[index - 1] : null;
      if (!attachment || !containerAllowed(getConfig(), turn)) return { content: '附件不可用', isError: true };
      const signal = AbortSignal.any([AbortSignal.timeout(60000), ...(ctx.signal ? [ctx.signal] : [])]);
      try {
        const url = await resolveFileSegmentUrl(ctx, attachment, { signal }) || attachment.url;
        if (!url) return { content: 'QQ 协议端没有提供附件下载地址', isError: true };
        const { buffer } = await safeFetchBinary(url, ATTACHMENT_LIMIT, signal, { allowPrivate: false });
        if (!containerAllowed(getConfig(), turn)) return { content: '容器访问已关闭', isError: true };
        const name = attachment.file.split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '_');
        const result = await containerRequest({ action: 'import', name, size: buffer.length }, signal, buffer);
        return { content: JSON.stringify(result) };
      } catch {
        return { content: '附件导入未确认。请检查文件是否过期、是否超过 16 MiB，以及容器是否运行。', isError: true };
      }
    }
  });
  return tools;
}
