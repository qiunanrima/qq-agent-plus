/** FIFO admission. Queue waiting does not start a CLI or consume execution time. */
export function createCodexQueue({ maxWaiting = 32, waitMs = 60000 } = {}) {
  const running = new Set(), waiting = [];
  let cancelling = false;
  const failure = message => Object.assign(new Error(message), { code: 'CODEX_NO_RETRY' });
  const drain = () => {
    if (cancelling) return;
    while (waiting.length) {
      const item = waiting[0];
      if (item.signal?.aborted || !item.isEnabled()) { item.cancel(failure('Codex queued request cancelled')); continue; }
      if (running.size >= item.limit || [...running].some(run => run.chatKey === item.chatKey)) return;
      waiting.shift(); item.cleanup(); running.add(item);
      let released = false;
      item.resolve(() => { if (released) return; released = true; running.delete(item); drain(); });
    }
  };
  return {
    status: () => ({ active: running.size, queued: waiting.length }),
    cancelWaiting() { cancelling = true; for (const item of [...waiting]) item.cancel(failure('Codex queued request cancelled')); cancelling = false; },
    acquire({ chatKey, limit, signal, isEnabled }) {
      if (signal?.aborted || !isEnabled()) return Promise.reject(failure('Codex queued request cancelled'));
      if (waiting.length >= maxWaiting) return Promise.reject(failure('Codex CLI queue full'));
      return new Promise((resolve, reject) => {
        const item = { chatKey, limit, signal, isEnabled, resolve };
        const abort = () => item.cancel(failure('Codex queued request cancelled'));
        const timer = setTimeout(() => item.cancel(failure('Codex CLI queue wait timed out')), waitMs);
        const guard = setInterval(() => { if (!isEnabled()) abort(); }, 100);
        item.cleanup = () => { clearTimeout(timer); clearInterval(guard); signal?.removeEventListener('abort', abort); };
        item.cancel = error => { const i = waiting.indexOf(item); if (i < 0) return; waiting.splice(i, 1); item.cleanup(); reject(error); drain(); };
        waiting.push(item); signal?.addEventListener('abort', abort, { once: true }); drain();
      });
    }
  };
}
