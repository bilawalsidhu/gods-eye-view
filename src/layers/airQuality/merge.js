/**
 * One station set from several observation providers. Pure and portable: no
 * network, scene or UI imports.
 *
 * Aggregators such as OpenAQ republish many national networks, so the same
 * monitor can arrive twice: once from its own network (a direct provider) and
 * once as the aggregator's copy, with coordinates rounded a little
 * differently. Two readings from different providers closer than `dedupeM`
 * are one site: the direct provider's reading wins, and between two of the
 * same standing the newer observation wins. A provider's own neighbouring
 * stations are never merged with each other.
 */

/** Grid cell edge in degrees: about 2.2 km, well above any dedupe distance. */
const CELL_DEG = 0.02;
const METRES_PER_DEGREE = 111_320;

const observedAt = (reading) => {
  const at = Number.isFinite(reading?.observedMs)
    ? reading.observedMs
    : Date.parse(reading?.time);
  return Number.isFinite(at) ? at : -Infinity;
};

/** Planar distance in metres; exact enough below a kilometre. */
function metres(a, b) {
  return Math.hypot(
    (a.lat - b.lat) * METRES_PER_DEGREE,
    (a.lon - b.lon) * METRES_PER_DEGREE * Math.cos((a.lat * Math.PI) / 180),
  );
}

const placed = (reading) =>
  Number.isFinite(reading?.lat) &&
  Number.isFinite(reading?.lon) &&
  Math.abs(reading.lat) <= 90 &&
  Math.abs(reading.lon) <= 180;

/**
 * @param {Array<{provider: string, direct: boolean, readings: object[]}>} lists
 * @param {{dedupeM?: number}} [options]
 * @returns {object[]} The kept readings, in input order.
 */
export function mergeObservations(lists, { dedupeM = 150 } = {}) {
  const candidates = [];
  for (const list of Array.isArray(lists) ? lists : []) {
    if (!Array.isArray(list?.readings)) continue;
    for (const reading of list.readings)
      candidates.push({
        reading,
        provider: list.provider,
        direct: list.direct === true,
        at: observedAt(reading),
        order: candidates.length,
      });
  }
  // Best first: direct before aggregated, then newer before older; stable.
  const ranked = candidates
    .filter((candidate) => placed(candidate.reading))
    .sort(
      (a, b) =>
        Number(b.direct) - Number(a.direct) || b.at - a.at || a.order - b.order,
    );
  const grid = new Map();
  const kept = candidates.filter((candidate) => !placed(candidate.reading));
  for (const candidate of ranked) {
    const { reading } = candidate;
    const row = Math.floor(reading.lat / CELL_DEG);
    const col = Math.floor(reading.lon / CELL_DEG);
    let duplicate = false;
    for (let r = row - 1; r <= row + 1 && !duplicate; r++)
      for (let c = col - 1; c <= col + 1 && !duplicate; c++)
        for (const other of grid.get(`${r}:${c}`) || [])
          if (
            other.provider !== candidate.provider &&
            metres(reading, other.reading) < dedupeM
          ) {
            duplicate = true;
            break;
          }
    if (duplicate) continue;
    const key = `${row}:${col}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(candidate);
    kept.push(candidate);
  }
  return kept
    .sort((a, b) => a.order - b.order)
    .map((candidate) => candidate.reading);
}
