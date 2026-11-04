// Network access is exclusively delegated to cap.http.request in service/client.
import { createHealthService } from './service.mjs';
import { createInterface } from 'node:readline';
import { HealthError, hostError, publicError } from './errors.mjs';

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let seq = 0;
const pending = new Map();
const callHost = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); reject(new HealthError('宿主能力调用超时', 'E_TIMEOUT')); }, 25000);
  pending.set(id, { resolve, reject, timer });
  send({ id, method, params });
});
const service = createHealthService(callHost);
let busy = false;
createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message.method) {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(hostError(message.error));
    else item.resolve(message.result);
    return;
  }
  if (message.method === 'shutdown') { send({ id: message.id, result: {} }); process.exit(0); }
  if (['init', 'ping', 'schedule'].includes(message.method)) { send({ id: message.id, result: { ok: true } }); return; }
  if (!['callTool', 'probe'].includes(message.method)) return;
  if (busy) { send({ id: message.id, error: { code: 'E_BUSY', message: '健康插件正在处理请求，请稍后重试' } }); return; }
  busy = true;
  Promise.resolve().then(() => message.method === 'probe' ? service.probe()
    : service.call(message.params?.name, message.params?.args, message.params?.context))
    .then(result => send({ id: message.id, result }))
    // Never serialize upstream errors, URLs or response bodies: they may contain account tokens.
    .catch(error => send({ id: message.id, error: publicError(error) }))
    .finally(() => { busy = false; });
});
