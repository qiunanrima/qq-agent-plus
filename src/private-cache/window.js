// Choose a repeatable boundary inside the already visibility-filtered, budgeted window.
// IDs divisible by larger powers of two are rarer and make longer-lived boundaries.
export function privateCacheBoundary(messages, lines) {
  if (messages.length < 8) return 0;
  const maxDrop = Math.floor(messages.length / 4);
  const charBudget = Math.floor(lines.reduce((sum, line) => sum + line.length + 1, 0) / 4);
  let droppedChars = 0;
  let boundary = 0;
  let best = 0;
  for (let i = 0; i <= maxDrop && droppedChars <= charBudget; i++) {
    const id = messages[i].id;
    if (!Number.isSafeInteger(id) || id < 1) return 0;
    const rank = (id & -id) >>> 0;
    if (rank > best) {
      best = rank;
      boundary = i;
    }
    droppedChars += lines[i].length + 1;
  }
  return boundary;
}

export function privateCacheConfig(value) {
  return { enabled: value?.enabled === true, graduated: value?.graduated === true };
}
