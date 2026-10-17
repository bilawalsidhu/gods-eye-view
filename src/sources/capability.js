/** A permanent session capability miss; clients must not schedule background retries. */
export function isUnavailableCapability(value) {
  return (
    value?.code === 'OVERPASS_NOT_CONFIGURED' ||
    value?.unavailable === true ||
    value?.retryable === false
  );
}

/** Preserve the server's explicit capability and cooldown fields without upstream text. */
export function sourceResponseError(body, response, message) {
  const seconds = Number(response?.headers?.get('retry-after'));
  return Object.assign(new Error(message), {
    code: body?.code,
    retryable: body?.retryable !== false,
    retryAfterMs: Math.max(
      Number(body?.retryAfterMs) || 0,
      Number.isFinite(seconds) ? seconds * 1000 : 0,
    ),
  });
}
