export function runCancelled(reason, message = 'Run cancelled') {
  return Object.assign(new Error(message), { code: 'RUN_CANCELLED', cancelReason: reason });
}

/** Text alone is not proof: only a host-owned cancellation reason is intentional. */
export function isIntentionalCancellation(error, signal) {
  if (signal?.aborted) return signal.reason?.code === 'RUN_CANCELLED' || signal.reason?.message === 'Run cancelled';
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++)
    if (current.code === 'RUN_CANCELLED') return true;
  return false;
}
