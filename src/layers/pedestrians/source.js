import {
  SENSORS_URL,
  COUNTS_URL,
  COUNT_WINDOW_MINUTES,
  PAGE_SIZE,
} from './policy.js';
import {
  normalizeSensors,
  normalizeCounts,
  mergePedestrianRecords,
  windowStartIso,
  parseSensingMs,
} from './records.js';

/**
 * Melbourne pedestrian-counter snapshot source. Keyless and CORS-open, so
 * the browser fetches the council's Opendatasoft endpoints directly — no
 * proxy, no credential. Sensor locations are cached across polls; the count
 * window is anchored to the feed's own latest reading (the feed can lag wall
 * clock by an hour), and every record carries that `asOfMs` so the layer can
 * show how current the snapshot really is.
 */
export function createMelbournePedestrianSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  sensorsTtlMs = 6 * 60 * 60 * 1000,
} = {}) {
  let sensorCache = null;
  let sensorCacheAt = 0;

  async function getJson(url, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, { signal });
    if (!response.ok)
      throw new Error(`Melbourne Open Data HTTP ${response.status}`);
    const payload = await response.json();
    signal?.throwIfAborted();
    if (!payload || !Array.isArray(payload.results))
      throw new Error('Malformed Melbourne Open Data response');
    return payload.results;
  }

  async function loadSensors(signal, nowMs) {
    if (sensorCache && nowMs - sensorCacheAt < sensorsTtlMs) return sensorCache;
    const rows = [];
    for (let offset = 0; offset < 300; offset += PAGE_SIZE) {
      const page = await getJson(
        `${SENSORS_URL}?limit=${PAGE_SIZE}&offset=${offset}`,
        signal,
      );
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    sensorCache = normalizeSensors(rows);
    sensorCacheAt = nowMs;
    return sensorCache;
  }

  /** The feed's newest reading, in epoch ms — the anchor for the window. */
  async function loadFeedLatest(signal) {
    const rows = await getJson(
      `${COUNTS_URL}?select=sensing_datetime&order_by=sensing_datetime%20DESC&limit=1`,
      signal,
    );
    return parseSensingMs(rows[0]?.sensing_datetime);
  }

  async function loadCounts(signal, asOfMs, windowMinutes) {
    const where = encodeURIComponent(
      `sensing_datetime>="${windowStartIso(asOfMs, windowMinutes)}"`,
    );
    const select = encodeURIComponent(
      'location_id,sum(total_of_directions) as total',
    );
    const rows = [];
    for (let offset = 0; offset < 300; offset += PAGE_SIZE) {
      const page = await getJson(
        `${COUNTS_URL}?select=${select}&where=${where}&group_by=location_id&limit=${PAGE_SIZE}&offset=${offset}`,
        signal,
      );
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return normalizeCounts(rows);
  }

  return {
    async getSnapshot({ signal, windowMinutes = COUNT_WINDOW_MINUTES } = {}) {
      const nowMs = Date.now();
      const [sensors, feedLatestMs] = await Promise.all([
        loadSensors(signal, nowMs),
        loadFeedLatest(signal),
      ]);
      // No usable feed timestamp → fall back to wall clock; the window still
      // resolves and every sensor simply reads as unknown, which is honest.
      const asOfMs = Number.isFinite(feedLatestMs) ? feedLatestMs : nowMs;
      const counts = await loadCounts(signal, asOfMs, windowMinutes);
      return mergePedestrianRecords(sensors, counts, { asOfMs, windowMinutes });
    },
    label: 'City of Melbourne · Pedestrian Counting System',
    attribution: {
      name: 'City of Melbourne',
      description:
        'Pedestrian Counting System — fixed street counters (CC BY 4.0)',
      text: '© City of Melbourne (CC BY)',
      href: 'https://data.melbourne.vic.gov.au',
    },
  };
}
