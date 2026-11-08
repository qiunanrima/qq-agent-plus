/** Chat-owned processes; each turn still receives a fresh ACP session/capability. */
export function createAcpPool({ idleMs = 3600000, maxIdle = 5, maxProcesses = 5, maxTurns = 2 } = {}) {
  const entries = new Map();
  let pending = Promise.resolve();
  function discard(key, entry) {
    if (entry.closing) return entry.closing;
    if (entries.get(key) === entry) entries.delete(key);
    clearTimeout(entry.timer);
    clearInterval(entry.guard);
    entry.active = null;
    entry.closing = (async () => {
      await entry.peer.close();
      await entry.dispose?.();
    })();
    return entry.closing;
  }
  return {
    async acquire(key, signature, create, valid) {
      const previous = pending;
      let unlock;
      pending = new Promise(resolve => { unlock = resolve; });
      await previous;
      try {
      let entry = entries.get(key);
      if (entry?.busy) throw new Error('ACP chat already active');
      if (entry && (entry.signature !== signature || entry.peer.closed || !entry.valid())) {
        await discard(key, entry); entry = null;
      }
      if (!entry) {
        while (entries.size >= maxProcesses) {
          const [oldKey, old] = entries.entries().next().value;
          await discard(oldKey, old);
        }
        entry = { signature, busy: true, active: null, valid, turns: 0 };
        const resource = await create(entry);
        Object.assign(entry, resource);
        entries.set(key, entry);
        entry.guard = setInterval(() => {
          if (!entry.busy && (!entry.valid() || entry.peer.closed)) void discard(key, entry).catch(() => {});
        }, 1000);
        entry.guard.unref?.();
      }
      clearTimeout(entry.timer);
      entry.busy = true;
      return {
        entry,
        async release(healthy) {
          if (entries.get(key) !== entry) return entry.closing;
          // CLI 1.4 retains session workers: bound their lifetime while allowing
          // the next turn to reuse initialization once.
          if (++entry.turns >= maxTurns && !entry.sessionDisposed) return discard(key, entry);
          entry.sessionDisposed = false;
          entry.active = null;
          if (!healthy || entry.peer.closed || !entry.valid()) return discard(key, entry);
          entry.busy = false;
          entry.lastUsed = Date.now();
          entry.timer = setTimeout(() => { void discard(key, entry).catch(() => {}); }, idleMs);
          entry.timer.unref?.();
          const idle = [...entries].filter(([, item]) => !item.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
          while (idle.length > maxIdle) {
            const [oldKey, old] = idle.shift();
            await discard(oldKey, old);
          }
        }
      };
      } finally { unlock(); }
    },
    async close() { await Promise.all([...entries].map(([key, entry]) => discard(key, entry))); }
  };
}
