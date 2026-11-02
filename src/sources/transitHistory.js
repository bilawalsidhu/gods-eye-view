/** Validate the entire decoded identifier, including UTF-8 length. */
export function validTransitIdentifier(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/[\u0000-\u001f\u007f/\\]/u.test(value) &&
    value !== '.' &&
    value !== '..' &&
    new TextEncoder().encode(value).length <= 256 &&
    !/[\uD800-\uDFFF]/u.test(value)
  );
}

/** Selection reads are bounded and cancellable through body parsing. */
export async function fetchTransitHistory(
  feedId,
  vehicleId,
  signal,
  fetchImpl = fetch,
) {
  if (!validTransitIdentifier(vehicleId))
    throw new TypeError('Invalid transit vehicle identifier');
  const response = await fetchImpl(
    `/api/transit/trail/${encodeURIComponent(feedId)}/${encodeURIComponent(vehicleId)}`,
    { signal, headers: { Accept: 'application/json' } },
  );
  if (!response.ok) throw new Error(`Transit history HTTP ${response.status}`);
  const reader = response.body?.getReader?.();
  let text = '';
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 32768)
          throw new RangeError('Transit history exceeds response limit');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
  } else {
    text = await response.text();
    if (new TextEncoder().encode(text).length > 32768)
      throw new RangeError('Transit history exceeds response limit');
  }
  signal?.throwIfAborted();
  const payload = JSON.parse(text);
  if (
    payload.version !== 1 ||
    payload.feedId !== feedId ||
    payload.vehicleId !== vehicleId ||
    !Array.isArray(payload.fixes) ||
    payload.fixes.length > 128 ||
    !Array.isArray(payload.epochs) ||
    payload.epochs.length > 8
  )
    throw new TypeError('Invalid transit history response');
  let previous = -Infinity;
  const epochs = new Set();
  for (const epoch of payload.epochs) {
    if (
      !Number.isInteger(epoch.id) ||
      epoch.id < 1 ||
      epoch.id > 0xffffffff ||
      epochs.has(epoch.id) ||
      !['trip', 'route', 'mode'].every(
        (key) =>
          typeof epoch[key] === 'string' &&
          new TextEncoder().encode(epoch[key]).length <= 256,
      )
    )
      throw new TypeError('Invalid transit history epoch');
    epochs.add(epoch.id);
  }
  for (const fix of payload.fixes) {
    if (
      !Array.isArray(fix) ||
      fix.length !== 5 ||
      !fix.every(Number.isFinite) ||
      fix[0] < 0 ||
      fix[0] <= previous ||
      Math.abs(fix[1]) > 90 ||
      Math.abs(fix[2]) > 180 ||
      !Number.isInteger(fix[3]) ||
      !epochs.has(fix[4])
    )
      throw new TypeError('Invalid transit history fix');
    previous = fix[0];
  }
  return payload;
}
