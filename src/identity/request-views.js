function proposalView(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.uin),
    primaryName: String(row.primary_name || ''),
    sourceChatKey: String(row.source_chat_key || ''),
    reasonCode: String(row.reason_code || ''),
    reason: String(row.reason || ''),
    verificationMessage: String(row.verification_message || ''),
    status: String(row.status || ''),
    createdAt: Number(row.created_at) || 0,
    decidedAt: Number(row.decided_at) || 0,
    decidedBy: String(row.decided_by || ''),
    notifiedAt: Number(row.notified_at) || 0,
    notifyError: String(row.notify_error || ''),
    cooldownUntil: Number(row.cooldown_until) || 0,
    dispatchAttemptId: String(row.dispatch_attempt_id || ''),
    dispatchStartedAt: Number(row.dispatch_started_at) || 0,
    dispatchedAt: Number(row.dispatched_at) || 0,
    dispatchError: String(row.dispatch_error || ''),
    opportunityId: String(row.opportunity_id || ''),
    updatedAt: Number(row.updated_at) || 0
  };
}

function incomingRequestView(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.uin),
    primaryName: String(row.primary_name || ''),
    comment: String(row.comment || ''),
    status: String(row.status || ''),
    decision: String(row.decision || ''),
    createdAt: Number(row.created_at) || 0,
    decidedAt: Number(row.decided_at) || 0,
    decidedBy: String(row.decided_by || ''),
    notifiedAt: Number(row.notified_at) || 0,
    notifyError: String(row.notify_error || ''),
    actionAttemptId: String(row.action_attempt_id || ''),
    actionStartedAt: Number(row.action_started_at) || 0,
    actionCompletedAt: Number(row.action_completed_at) || 0,
    actionError: String(row.action_error || ''),
    whitelistApplied: Boolean(row.whitelist_applied),
    whitelistError: String(row.whitelist_error || ''),
    updatedAt: Number(row.updated_at) || 0
  };
}
export { proposalView, incomingRequestView };
