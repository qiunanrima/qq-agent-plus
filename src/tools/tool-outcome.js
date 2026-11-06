/** Only host-certified pre-execution validation can be corrected without a barrier. */
export function blocksToolFinish(result) {
  return result?.partialFailure === true || (result?.isError === true && result.skillBlocked !== true
    && !(result.errorCode === 'INVALID_TOOL_ARGUMENTS' && result.noEffect === true));
}
