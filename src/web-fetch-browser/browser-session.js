import { interactWithPage } from './browser-interaction.js';

let session;
let sessionTimer;

function expireSessionAfterIdle() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => { void closeSession(); }, 60_000);
}

export async function closeSession() {
  clearTimeout(sessionTimer);
  const current = session;
  session = undefined;
  if (current) await current.dispose();
}

export function hasSession() {
  return Boolean(session);
}

export function retainSession(current) {
  session = current;
  expireSessionAfterIdle();
}

export async function resumeSession(owner, steps, signal) {
  if (!owner || session?.owner !== owner || !steps) throw new Error('Browser session unavailable');
  const current = session;
  clearTimeout(sessionTimer);
  const abort = () => { void current.browser.close().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const result = await interactWithPage(current.page, steps, signal);
    expireSessionAfterIdle();
    return result;
  } catch (error) {
    await closeSession();
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
