/** Shared admission for repair mode. A mention of a printer is not a repair request. */
export function repairTask(message) {
  const text = String(message || '').trim();
  if (
    !text ||
    /^(?:explain|describe|what|why|how|which|tell me about|write|summarize|translate)\b/i.test(text)
  )
    return null;
  if (
    !/\b(?:fix|repair|troubleshoot|diagnos\w*|not working|doesn'?t work|isn'?t working|won'?t|can'?t|cannot|keeps? crashing|freezing|disconnect\w*|no internet|no sound|too slow|very slow|running slow|work agala|velai seiyala|connect agala|print agala|problem|issue)\b/i.test(
      text,
    )
  )
    return null;
  if (/\b(?:spooler|printer|printing|print service)\b/i.test(text)) return { domain: 'spooler' };
  if (/\b(?:wi-?fi|wireless|internet|network|connection)\b/i.test(text))
    return { domain: 'network' };
  if (/\bbluetooth\b/i.test(text)) return { domain: 'bluetooth' };
  if (/\b(?:audio|sound|speaker|microphone|mic)\b/i.test(text)) return { domain: 'audio' };
  if (
    /\b(?:windows|pc|laptop|computer|system|cpu|ram|memory|disk|performance|startup)\b/i.test(text)
  )
    return { domain: 'system' };
  return null;
}
