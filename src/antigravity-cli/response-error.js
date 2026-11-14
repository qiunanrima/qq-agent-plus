/** CLI diagnostics sometimes arrive as successful assistant text instead of protocol errors. */
export function assertAntigravityResponse(text) {
  const firstLine = String(text || '').trim().split(/\r?\n/, 1)[0]
    .replace(/^[⚠❌✖!\s\uFE0F]+/u, '').trim();
  // Match diagnostics at the start, not ordinary prose mentioning server capacity.
  const capacity = /^(?:(?:error|warning|错误|警告)\s*[:：]\s*)?(?:(?:the\s+)?model\s+(?:is\s+)?(?:currently\s+)?(?:at\s+capacity|(?:capacity\s+(?:is\s+)?)?(?:exhausted|overloaded)|(?:has\s+)?(?:insufficient|no\s+available)\s+capacity)|(?:the\s+)?(?:requested\s+)?model[^.!?\n]{0,80}\b(?:capacity\s+(?:is\s+)?(?:exhausted|unavailable|insufficient)|insufficient\s+capacity)|(?:当前)?模型(?:容量|服务容量|可用容量)(?:不足|已满|耗尽|已耗尽)|(?:当前)?模型(?:的)?容量不足)/i.test(firstLine);
  const explicitError = /^(?:\[error\]|error\s*[:：]|错误\s*[:：])/i.test(firstLine);
  if (!capacity && !explicitError) return;
  const error = new Error(capacity ? 'Antigravity model capacity exhausted' : 'Antigravity CLI reported an error');
  error.code = capacity ? 'ANTIGRAVITY_MODEL_CAPACITY' : 'ANTIGRAVITY_RESPONSE_ERROR';
  throw error;
}
