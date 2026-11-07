/**
 * Type designator and registration for aircraft whose feed reports neither
 * (OpenSky state vectors), from the server's Mictronics aircraft database
 * (/api/aircraft-types). Each address is asked about once; answers and misses
 * are remembered, so after the first snapshot only newly seen aircraft go to
 * the server. Best-effort like the adsbdb enrichment: a failed lookup leaves
 * the records as the feed sent them and is retried after the server's
 * Retry-After (a few seconds while its database loads), else RETRY_MS.
 */

const RETRY_MS = 60_000;
/** Forget addresses no longer in the feed once the memory passes this. */
const MAX_REMEMBERED = 50_000;
/** The most ids the server takes in one request (its MAX_IDS). */
export const BATCH_IDS = 20_000;

export function createAircraftTypeLookup({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** hex → [typeCode, registration, typeName] or null for a known miss. */
  const known = new Map();
  let retryAt = 0;

  async function requestBatch(ids, signal) {
    const response = await fetchImpl('/api/aircraft-types', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
      signal,
    });
    if (!response.ok) {
      // 503 while the server's database loads, with a Retry-After of seconds.
      const seconds = Number(response.headers?.get?.('retry-after'));
      throw Object.assign(new Error(`HTTP ${response.status}`), {
        retryMs: seconds > 0 ? seconds * 1000 : RETRY_MS,
      });
    }
    const payload = await response.json();
    for (const id of ids) {
      const row = payload?.aircraft?.[id];
      known.set(
        id,
        Array.isArray(row)
          ? [row[0], row[1] ?? null, payload?.typeNames?.[row[0]] ?? null]
          : null,
      );
    }
  }

  /** Ask about ids in batches the server accepts; one failure stops the rest. */
  async function request(ids, signal) {
    for (let start = 0; start < ids.length; start += BATCH_IDS)
      await requestBatch(ids.slice(start, start + BATCH_IDS), signal);
  }

  /** Ask about ids not yet known, unless a failure's retry time hasn't come. */
  async function ask(ids, signal) {
    const unknown = [...new Set(ids)].filter((id) => !known.has(id));
    if (!unknown.length || now() < retryAt) return;
    try {
      await request(unknown, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      retryAt = now() + (error.retryMs ?? RETRY_MS);
    }
  }

  return {
    /**
     * Type, name and registration for one address, or null when the database
     * doesn't know it or can't answer now (the caller may ask elsewhere).
     */
    async lookup(id, { signal } = {}) {
      const hex = String(id ?? '').toLowerCase();
      if (!/^[0-9a-f]{6}$/.test(hex)) return null;
      await ask([hex], signal);
      const entry = known.get(hex);
      return entry
        ? { typeCode: entry[0], registration: entry[1], typeName: entry[2] }
        : null;
    },
    /**
     * Fill `typeCode`, `typeName` and `registration` on records that lack a
     * type, in place. Records whose feed already reported a type keep it.
     */
    async fill(records, { signal } = {}) {
      const untyped = records.filter(
        (record) => !record.typeCode && /^[0-9a-f]{6}$/.test(record.id),
      );
      await ask(
        untyped.map((record) => record.id),
        signal,
      );
      for (const record of untyped) {
        const entry = known.get(record.id);
        if (!entry) continue;
        record.typeCode = entry[0];
        record.registration ??= entry[1];
        record.typeName ??= entry[2];
      }
      if (known.size > MAX_REMEMBERED) {
        const current = new Set(records.map((record) => record.id));
        for (const id of known.keys()) if (!current.has(id)) known.delete(id);
      }
      return records;
    },
  };
}
