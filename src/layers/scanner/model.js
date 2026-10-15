export const SCANNER_LAYER_ID = 'police-scanner';
export const SCANNER_ENTITY_PREFIX = 'scanner:';
export const SCANNER_REFRESH_MS = 5 * 60 * 1000;
export const SCANNER_CALL_POLL_MS = 12_000;
export const SCANNER_FEED_TYPES = Object.freeze(['stream', 'openmhz']);

/** Validate the `/api/scanner/feeds` body; malformed rows are dropped. */
export function normalizeScannerFeedList(body) {
  const rows = Array.isArray(body?.feeds) ? body.feeds : null;
  if (!rows) return null;
  const seen = new Set();
  const feeds = [];
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id : '';
    const lat = Number(row?.lat);
    const lon = Number(row?.lon);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id) || seen.has(id)) continue;
    if (!SCANNER_FEED_TYPES.includes(row.type)) continue;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) continue;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) continue;
    if (typeof row.name !== 'string' || !row.name.trim()) continue;
    seen.add(id);
    feeds.push({
      id,
      name: row.name.trim(),
      agency: typeof row.agency === 'string' ? row.agency : '',
      lat,
      lon,
      type: row.type,
      attribution: typeof row.attribution === 'string' ? row.attribution : '',
    });
  }
  return feeds;
}

/** Validate a `/api/scanner/calls/:id` body into time-ordered clip rows. */
export function normalizeScannerCalls(body) {
  const rows = Array.isArray(body?.calls) ? body.calls : [];
  return rows
    .filter((call) => typeof call?.url === 'string' && call.url)
    .map((call) => ({
      id: String(call.id ?? call.url),
      time: Number(call.time) || 0,
      seconds: Number.isFinite(Number(call.seconds))
        ? Number(call.seconds)
        : null,
      talkgroup: Number.isFinite(Number(call.talkgroup))
        ? Number(call.talkgroup)
        : null,
      url: call.url,
    }))
    .sort((a, b) => a.time - b.time);
}

/** Return clips not yet played, oldest first, remembering what was queued. */
export function takeNewCalls(calls, playedIds) {
  const fresh = [];
  for (const call of calls) {
    if (playedIds.has(call.id)) continue;
    playedIds.add(call.id);
    fresh.push(call);
  }
  return fresh;
}

export function scannerEntityId(feedId) {
  return `${SCANNER_ENTITY_PREFIX}${feedId}`;
}

/** Recover the feed id from a picked Cesium entity id, or null. */
export function scannerFeedIdFromEntityId(entityId) {
  const text = String(entityId ?? '');
  return text.startsWith(SCANNER_ENTITY_PREFIX)
    ? text.slice(SCANNER_ENTITY_PREFIX.length)
    : null;
}
