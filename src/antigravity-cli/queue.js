/** FIFO admission; waiting never starts a CLI or consumes its execution timeout. */
export function createCliQueue({ maxWaiting = 32, waitMs = 60000 } = {}) {
  const running = new Set(), waiting = [];
  const drain = () => {
    while (waiting.length) {
      const item = waiting[0];
      if (item.signal?.aborted || !item.isEnabled()) { item.cancel(new Error('Antigravity queued request cancelled')); continue; }
      if (running.size >= item.limit || [...running].some(r => item.chatKey && r.chatKey === item.chatKey)) return;
      waiting.shift(); item.cleanup(); running.add(item);
      let released = false;
      item.resolve(() => { if (released) return; released = true; running.delete(item); drain(); });
    }
  };
  return {
    status: () => ({ active: running.size, queued: waiting.length }),
    acquire({ chatKey, limit, signal, isEnabled }) {
      if (signal?.aborted || !isEnabled()) return Promise.reject(new Error('Antigravity queued request cancelled'));
      if (waiting.length >= maxWaiting) return Promise.reject(new Error('Antigravity CLI queue full'));
      return new Promise((resolve, reject) => {
        const item = { chatKey, limit, signal, isEnabled, resolve };
        const abort = () => item.cancel(new Error('Antigravity queued request cancelled'));
        const timer = setTimeout(() => item.cancel(new Error('Antigravity CLI queue wait timed out')), waitMs);
        const guard = setInterval(() => { if (!isEnabled()) abort(); }, 100);
        item.cleanup = () => { clearTimeout(timer); clearInterval(guard); signal?.removeEventListener('abort', abort); };
        item.cancel = error => { const i = waiting.indexOf(item); if (i < 0) return; waiting.splice(i, 1); item.cleanup(); error.code = 'ANTIGRAVITY_NO_RETRY'; reject(error); drain(); };
        waiting.push(item); signal?.addEventListener('abort', abort, { once: true }); drain();
      });
    }
  };
}
