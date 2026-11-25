import { readResponseJsonCapped } from '../../sources/httpBody.js';

const SKIP_KEYS = [
  'total',
  'duplicateId',
  'fractionalId',
  'malformedId',
  'invalidGeometry',
  'missingName',
];

function cleanSkipped(value) {
  const out = {};
  for (const key of SKIP_KEYS)
    out[key] =
      Number.isSafeInteger(value?.[key]) && value[key] >= 0 ? value[key] : 0;
  return out;
}

/** Same-origin, bounded snapshot acquisition for NGA World Port Index. */
export function createPortsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/ports', {
        signal,
        cache: 'no-store',
      });
      if (!response?.ok)
        throw new Error(
          `World Port Index unavailable (HTTP ${response?.status})`,
        );
      const payload = await readResponseJsonCapped(
        response,
        9 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (
        !payload ||
        !Array.isArray(payload.records) ||
        payload.records.length > 8000 ||
        !Number.isFinite(payload.retrievedAt) ||
        typeof payload.complete !== 'boolean' ||
        typeof payload.partial !== 'boolean' ||
        payload.partial === payload.complete ||
        !payload.records.every(
          (item) =>
            /^wpi:[1-9]\d*$/.test(item?.id || '') &&
            Number.isSafeInteger(item.wpiNumber) &&
            Number.isFinite(item.lat) &&
            Math.abs(item.lat) <= 90 &&
            Number.isFinite(item.lon) &&
            Math.abs(item.lon) <= 180 &&
            typeof item.name === 'string' &&
            item.name.length > 0,
        )
      )
        throw new Error('Malformed World Port Index snapshot');
      return {
        records: payload.records,
        retrievedAt: payload.retrievedAt,
        mirrorLastEditAt: Number.isFinite(payload.mirrorLastEditAt)
          ? payload.mirrorLastEditAt
          : null,
        ngaPublicationDate: null,
        skipped: cleanSkipped(payload.skipped),
        partial: payload.partial,
        complete: payload.complete,
        stale: payload.stale === true,
        version: `${payload.retrievedAt}:${payload.records.length}`,
      };
    },
  };
}
