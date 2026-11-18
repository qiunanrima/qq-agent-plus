import { performance } from 'node:perf_hooks';

/** Node turns delays above its signed 32-bit timer limit into 1 ms. */
export function scheduleLongTimeout(callback, durationMs) {
  const started = performance.now();
  const maxDelay = 2 ** 31 - 1;
  let timer;
  const arm = remaining => {
    timer = setTimeout(() => {
      const left = durationMs - (performance.now() - started);
      if (left > 1) arm(left);
      else callback();
    }, Math.max(1, Math.min(maxDelay, Math.ceil(remaining))));
  };
  arm(durationMs);
  return () => clearTimeout(timer);
}
