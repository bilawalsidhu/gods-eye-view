/**
 * Parse a GFS `.idx` inventory into ordered message records.
 *
 * Each line is `msgNumber:byteOffset:d=YYYYMMDDHH:VAR:LEVEL:...:`. Malformed
 * lines are skipped; a payload with no valid lines is rejected so callers never
 * treat an HTML error page as an empty inventory.
 *
 * @param {string} text - Raw `.idx` body.
 * @returns {{ messages: Array<{index: number, offset: number, variable: string, level: string}> }}
 */
export function parseGfsIdx(text) {
  const messages = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split(':');
    if (
      parts.length < 6 ||
      !/^\d+$/.test(parts[0]) ||
      !/^\d+$/.test(parts[1]) ||
      !parts[3] ||
      !parts[4]
    )
      continue;
    messages.push({
      index: Number(parts[0]),
      offset: Number(parts[1]),
      variable: parts[3],
      level: parts[4],
    });
  }
  if (!messages.length) throw new Error('malformed GFS index');
  return { messages };
}

/**
 * Byte ranges for the two 10 m wind components. A message runs from its own
 * offset to one byte before the next message in file order.
 *
 * @param {{messages: Array<object>}} parsed - {@link parseGfsIdx} result.
 * @param {{level?: string}} [options]
 * @returns {{u: {start: number, end: number}, v: {start: number, end: number}}}
 */
export function windMessageRanges(parsed, { level = '10 m above ground' } = {}) {
  const range = (variable) => {
    const index = parsed.messages.findIndex(
      (message) => message.variable === variable && message.level === level,
    );
    const message = parsed.messages[index];
    const next = parsed.messages[index + 1];
    if (!message || !next) throw new Error(`missing ${variable} at ${level}`);
    return { start: message.offset, end: next.offset - 1 };
  };
  return { u: range('UGRD'), v: range('VGRD') };
}

/** Fetch a bounded text response as a Buffer. */
export async function fetchText({ url, fetchImpl = fetch, signal }) {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Fetch one bounded byte range. Rejects oversized ranges, non-206 responses
 * (except a whole-object 200 starting at zero), and short bodies.
 */
export async function fetchRange({
  url,
  start,
  end,
  fetchImpl = fetch,
  signal,
  maxBytes = 8 * 1024 * 1024,
}) {
  if (end < start || end - start + 1 > maxBytes)
    throw new Error('range too large');
  const response = await fetchImpl(url, {
    signal,
    headers: { Range: `bytes=${start}-${end}` },
  });
  const validStatus =
    response.status === 206 || (response.status === 200 && start === 0);
  if (!validStatus || !response.ok)
    throw new Error(`invalid range response ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length !== end - start + 1)
    throw new Error('invalid range length');
  return buffer;
}
