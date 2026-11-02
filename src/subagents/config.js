export const SUBAGENT_DEFAULTS = Object.freeze({ enabled: false, graduated: false });

export function normalizeSubagentConfig(raw) {
  return { enabled: raw?.enabled === true, graduated: raw?.graduated === true };
}

// 硬限制不由模型参数或远端内容扩张。
export const SUBAGENT_LIMITS = Object.freeze({
  concurrency: 2, callsPerRun: 2, rounds: 3, toolCalls: 4,
  timeoutMs: 45000, tokens: 16000, inputChars: 4000, toolChars: 6000, resultChars: 4000
});
