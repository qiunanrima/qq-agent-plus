import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

async function readEndpoint(readyFile, child, stopped, signal) {
  while (true) {
    signal.throwIfAborted();
    if (stopped()) throw new Error('Obscura 启动失败');
    let text;
    try {
      text = await readFile(readyFile, { encoding: 'utf8', signal });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await delay(40, undefined, { signal });
      continue;
    }
    const ready = JSON.parse(text);
    if (ready.pid !== child.pid || ready.host !== '127.0.0.1'
      || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65_535
      || ready.websocket_path !== '/devtools/browser') {
      throw new Error('Obscura 返回了无效的控制地址');
    }
    return 'ws://127.0.0.1:' + ready.port + ready.websocket_path;
  }
}

export async function withObscura(binary, signal, run) {
  if (!binary || !isAbsolute(binary)) throw new Error('需要配置 Obscura 二进制的绝对路径');
  signal.throwIfAborted();
  const dir = await mkdtemp(join(tmpdir(), 'qqa-obscura-'));
  const readyFile = join(dir, 'ready.json');
  let child;
  let childClosed;
  let socket;
  const stop = () => {
    socket?.terminate();
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    const token = randomBytes(32).toString('hex');
    const env = {
      OBSCURA_CDP_TOKEN: token,
      OBSCURA_NAV_CHAIN_LIMIT: '1',
      OBSCURA_NAV_TIMEOUT_MS: '12000',
      OBSCURA_SCRIPT_DEADLINE_MS: '7000',
      OBSCURA_FETCH_TIMEOUT_MS: '6500',
      OBSCURA_FETCH_MAX_BODY_BYTES: '524288',
      OBSCURA_MAX_LIVE_FRAMES: '1'
    };
    if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(binary, [
      '--v8-flags=--max-old-space-size=64',
      'serve', '--host', '127.0.0.1', '--port', '0', '--max-connections', '1',
      '--ready-file', readyFile
    ], { cwd: dir, env, stdio: 'ignore', windowsHide: true });
    let stopped = false;
    child.on('error', () => { stopped = true; });
    childClosed = new Promise(resolve => child.once('close', () => {
      stopped = true;
      resolve();
    }));
    const endpoint = await readEndpoint(readyFile, child, () => stopped, signal);
    signal.throwIfAborted();
    socket = new WebSocket(endpoint, {
      headers: { Authorization: 'Bearer ' + token },
      maxPayload: 1024 * 1024,
      handshakeTimeout: 2_000
    });
    socket.on('error', () => {});
    await once(socket, 'open', { signal });

    let nextId = 0;
    const pending = new Map();
    socket.on('close', () => {
      for (const reject of pending.values()) reject(null, new Error('Obscura 控制连接已关闭'));
    });
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { socket.terminate(); return; }
      pending.get(message.id)?.(message.result, message.error);
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      signal.throwIfAborted();
      if (socket.readyState !== WebSocket.OPEN) throw new Error('Obscura 控制连接已关闭');
      const id = ++nextId;
      const settle = (result, error) => {
        pending.delete(id);
        if (error) reject(new Error('Obscura CDP ' + method + ' 失败'));
        else resolve(result);
      };
      pending.set(id, settle);
      socket.send(JSON.stringify({ id, method, params, sessionId }), (error) => {
        if (error) settle(null, error);
      });
    });
    return await run(send);
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
    await childClosed;
    // Only this process and its single child used this unique temp directory.
    const files = await readdir(dir).catch(() => []);
    for (const file of files) {
      if (file === 'ready.json' || /^\.obscura-ready-[\da-f-]+\.tmp$/i.test(file)) {
        await rm(join(dir, file), { force: true }).catch(() => {});
      }
    }
    await rmdir(dir).catch(() => {});
  }
}
