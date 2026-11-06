import { spawn, execFile } from 'node:child_process';

/** ACP v1 NDJSON peer. Diagnostics and remote error bodies never leave it. */
export function createAcpPeer(executable, args, { cwd, signal, spawnProcess = spawn, request, update }) {
  const pending = new Map();
  const incoming = new Set();
  let nextId = 1, buffer = '', bytes = 0, diagnostics = 0, closed = false, killTimer, stopping = false, exited = false;
  const child = spawnProcess(executable, args, { cwd, shell: false, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let resolveStopped;
  const stopped = new Promise(resolve => { resolveStopped = resolve; });
  const send = value => { if (!closed) child.stdin.write(JSON.stringify(value) + '\n'); };
  const fail = () => {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) item.reject(new Error('ACP connection closed'));
    pending.clear();
  };
  const kill = type => {
    try {
      if (process.platform === 'win32') {
        if (child.pid) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, timeout: 2000 }, () => {});
        else child.kill(type);
      } else if (child.pid) process.kill(-child.pid, type);
    } catch { /* already exited */ }
  };
  const close = () => {
    if (!stopping && !exited) {
      stopping = true; fail(); kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1000);
    }
    return stopped;
  };
  child.on('error', close);
  child.stdin.on('error', close);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 8 * 1024 * 1024) return close();
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { close(); return; }
      if (message.jsonrpc !== '2.0') { close(); return; }
      if (message.method && message.id != null) {
        if (incoming.has(message.id) || incoming.size >= 128) { close(); return; }
        incoming.add(message.id);
        Promise.resolve().then(() => request(message.method, message.params)).then(
          result => send({ jsonrpc: '2.0', id: message.id, result }),
          () => send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Request denied by QQ Agent' } })
        );
      } else if (message.method) {
        try { update?.(message.method, message.params); } catch { close(); return; }
      } else {
        const item = pending.get(message.id);
        if (!item) continue;
        pending.delete(message.id);
        if (message.error) item.reject(new Error(`ACP ${item.method} failed (${Number(message.error.code) || -32000})`));
        else item.resolve(message.result);
      }
    }
  });
  child.stderr.on('data', chunk => { diagnostics += chunk.length; if (diagnostics > 8 * 1024 * 1024) close(); });
  child.on('close', () => {
    exited = true; clearTimeout(killTimer);
    if (stopping && process.platform !== 'win32') kill('SIGKILL');
    signal?.removeEventListener('abort', close); fail(); resolveStopped();
  });
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();
  return {
    close,
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    call(method, params) {
      if (closed) return Promise.reject(new Error('ACP connection closed'));
      if (pending.size >= 16) return Promise.reject(new Error('ACP request limit'));
      return new Promise((resolve, reject) => {
        const id = nextId++; pending.set(id, { method, resolve, reject });
        send({ jsonrpc: '2.0', id, method, params });
      });
    }
  };
}
