import net from 'node:net';

export function containerAllowed(config, turn) {
  const owner = String(config.admin?.ownerUin || '').trim();
  if (!/^\d+$/.test(owner) || config.linuxContainer?.enabled !== true || turn.proactive || turn.external) return false;
  if (!turn.senders.length || !turn.senders.every(id => String(id) === owner)) return false;
  return turn.chatKey === `private:${owner}`
    || (/^group:\d+$/.test(turn.chatKey) && turn.directed && config.linuxContainer.allowGroup === true);
}

export function containerRequest(request, signal) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: '/run/qq-agent-linux-container.sock', signal });
    let data = '';
    socket.setEncoding('utf8');
    socket.setTimeout(45000, () => socket.destroy(new Error('容器响应超时，执行结果未知')));
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
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
  return [{
    name: 'linux_shell',
    description: '在管理员的持久 Linux 容器内以 root 运行 shell 命令，可访问公网。仅按管理员本轮指示操作。超时或连接中断后先检查状态。',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    execute: async (ctx, { command }) => {
      if (!containerAllowed(getConfig(), turn)) return { content: '容器访问已关闭', isError: true };
      if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > 8192) return { content: '命令须为 1–8192 字节', isError: true };
      const result = await containerRequest({ action: 'exec', command }, ctx.signal);
      return { content: `退出码 ${result.code}\n${result.output}`, isError: result.code !== 0 };
    }
  }];
}
