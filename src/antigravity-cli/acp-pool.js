/** Chat-owned processes; each turn still receives a fresh ACP session/capability. */
export function createAcpPool({ idleMs = 3600000, maxIdle = 4 } = {}) {
  const entries = new Map();
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
      let entry = entries.get(key);
      if (entry?.busy) throw new Error('ACP chat already active');
      if (entry && (entry.signature !== signature || entry.peer.closed || !entry.valid())) {
        await discard(key, entry); entry = null;
      }
      if (!entry) {
        entry = { signature, busy: true, active: null, valid };
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
    },
    async close() { await Promise.all([...entries].map(([key, entry]) => discard(key, entry))); }
  };
}
