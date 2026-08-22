const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function retryDelay(response, attempt, baseDelayMs, maxDelayMs) {
  const retryAfter = response?.headers?.get?.('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(maxDelayMs, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(maxDelayMs, Math.max(0, date - Date.now()));
  }
  return Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
}

async function fetchWithRetry(url, init, {
  fetchImpl = fetch,
  maxAttempts = 5,
  baseDelayMs = 500,
  maxDelayMs = 8000,
  onRetry,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, init);
      if (!TRANSIENT_STATUSES.has(response.status) || attempt === maxAttempts) {
        return response;
      }
      await response.arrayBuffer().catch(() => undefined);
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) throw error;
    }

    const delayMs = retryDelay(response, attempt, baseDelayMs, maxDelayMs);
    onRetry?.({
      url: String(url),
      attempt,
      nextAttempt: attempt + 1,
      delayMs,
      status: response?.status,
      error: lastError,
    });
    await wait(delayMs);
  }
  throw lastError;
}

module.exports = { TRANSIENT_STATUSES, fetchWithRetry };
