const BASE = 'https://api.n2yo.com/rest/v1/satellite';
/** N2YO allows 1000 tle calls an hour per key; stay well under it. */
const HOURLY_LIMIT = 600;
/** Elements are refreshed this often for each satellite. */
const REFRESH_SEC = 6 * 3600;
/** Pinned satellites only: this many at most, so the limit cannot be reached. */
const MAX_SATELLITES = 20;
/** CelesTrak elements older than this many days are replaced by N2YO's. */
const STALE_DAYS = 5;

/**
 * Fetches orbital elements for one satellite from N2YO. The key travels in the
 * URL (that is how N2YO takes it), so it is never put in an error message or a
 * log line.
 */
export function createN2yoClient({
  key,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const calls = [];
  return {
    enabled: Boolean(key),
    /** Calls made in the last hour, by this process. */
    used() {
      const cutoff = now() - 3600_000;
      while (calls.length && calls[0] < cutoff) calls.shift();
      return calls.length;
    },
    /** @returns {Promise<{ name: string, line1: string, line2: string }>} */
    async tle(noradId) {
      if (!key) throw new Error('No N2YO key');
      if (!/^\d{1,6}$/.test(String(noradId)))
        throw new TypeError('Bad catalogue number');
      if (this.used() >= HOURLY_LIMIT)
        throw new Error('N2YO hourly limit reached');
      calls.push(now());
      let response;
      try {
        response = await fetchImpl(
          `${BASE}/tle/${noradId}&apiKey=${encodeURIComponent(key)}`,
          { signal: AbortSignal.timeout(15000) },
        );
      } catch {
        throw new Error('N2YO could not be reached');
      }
      if (!response.ok) throw new Error(`N2YO HTTP ${response.status}`);
      const body = await response.json().catch(() => null);
      const [line1, line2] = String(body?.tle ?? '').split(/\r?\n/);
      if (!line1?.startsWith('1 ') || !line2?.startsWith('2 '))
        throw new Error('N2YO sent no element set');
      return {
        name: String(body?.info?.satname ?? `SAT ${noradId}`),
        line1,
        line2,
      };
    },
  };
}

/**
 * Fills gaps in the satellite source from N2YO: for each pinned satellite
 * CelesTrak did not give, or gave only an old set, fetch the elements, at most
 * once every six hours. Returns how many it loaded and any failure text.
 *
 * @param {{ sats: ReturnType<import('./satellites.js').createSatelliteSource>,
 *   pins: string[], client: ReturnType<typeof createN2yoClient>,
 *   last?: Map<string, number>, nowSec: number }} args
 */
export async function refreshFromN2yo({
  sats,
  pins,
  client,
  last = new Map(),
  nowSec,
}) {
  const ids = pins
    .filter((id) => /^SAT-\d+$/.test(id))
    .slice(0, MAX_SATELLITES);
  let loaded = 0;
  let error = '';
  for (const id of ids) {
    const age = sats.epochAgeDays(id, nowSec);
    const wanted = age === null || age > STALE_DAYS;
    if (!wanted || nowSec - (last.get(id) ?? 0) < REFRESH_SEC) continue;
    last.set(id, nowSec);
    try {
      const { name, line1, line2 } = await client.tle(id.slice(4));
      if (sats.addElements(name, line1, line2)) loaded += 1;
    } catch (e) {
      error = e.message;
    }
  }
  return { loaded, error };
}
