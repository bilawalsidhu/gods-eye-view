/**
 * One station set from several observation providers. Pure and portable: no
 * network, scene or UI imports.
 *
 * Aggregators such as OpenAQ republish many national networks, so the same
 * monitor can arrive twice: once from its own network (a direct provider) and
 * once as the aggregator's copy, with coordinates rounded a little
 * differently. Two readings from different providers closer than `dedupeM`
 * match one-to-one per provider pair, nearest pair first. Prefer a reference
 * monitor, then a rated reading, a direct provider and the newer observation.
 * Neighbouring stations from the same provider stay distinct.
 */

/** Grid cell edge in degrees: about 2.2 km, well above any dedupe distance. */
const CELL_DEG = 0.02;
const METRES_PER_DEGREE = 111_320;

const observedAt = (reading) =>
  Number.isFinite(reading?.observedMs) ? reading.observedMs : -Infinity;

/** Planar distance in metres; exact enough below a kilometre. */
function metres(a, b) {
  return Math.hypot(
    (a.lat - b.lat) * METRES_PER_DEGREE,
    (a.lon - b.lon) * METRES_PER_DEGREE * Math.cos((a.lat * Math.PI) / 180),
  );
}

/**
 * Whether a reading is rated on the scale of `view`: in the US AQI view
 * (`'aqi'`) a computed index (`aqi.index`), in any other view a category
 * from the layer's interpretation (`assessment.label`). A network's own
 * index (`rating`) alone does not count. The one definition of "rated" for
 * the merge and the card.
 */
export function isRatedReading(reading, view) {
  if (view === 'aqi') return Number.isFinite(reading?.aqi?.index);
  return Boolean(reading?.assessment?.label);
}

const placed = (reading) =>
  Number.isFinite(reading?.lat) &&
  Number.isFinite(reading?.lon) &&
  Math.abs(reading.lat) <= 90 &&
  Math.abs(reading.lon) <= 180;

/**
 * @param {Array<{provider: string, direct: boolean, readings: object[]}>} lists
 * @param {{dedupeM?: number, view?: string, replaced?: Map<object, object>}} [options] `view` is the scale
 *   readings are rated on (`isRatedReading`). The optional map records each dropped reading and its replacement.
 * @returns {object[]} The kept readings, in input order.
 */
export function mergeObservations(
  lists,
  { dedupeM = 150, view, replaced } = {},
) {
  const candidates = [];
  for (const list of Array.isArray(lists) ? lists : []) {
    if (!Array.isArray(list?.readings)) continue;
    for (const reading of list.readings)
      candidates.push({
        reading,
        provider: list.provider,
        direct: list.direct === true,
        monitor: reading?.monitor !== false,
        rated: isRatedReading(reading, view),
        at: observedAt(reading),
        order: candidates.length,
      });
  }
  // Best first: monitors before low-cost sensors, rated before unrated, direct before aggregated, then newer
  // before older; stable.
  const ranked = candidates
    .filter((candidate) => placed(candidate.reading))
    .sort(
      (a, b) =>
        Number(b.monitor) - Number(a.monitor) ||
        Number(b.rated) - Number(a.rated) ||
        Number(b.direct) - Number(a.direct) ||
        b.at - a.at ||
        a.order - b.order,
    );
  // Cells of CELL_DEG, each holding its readings by provider.
  const grid = new Map();
  ranked.forEach((candidate, rank) => {
    const { lat, lon } = candidate.reading;
    candidate.rank = rank;
    candidate.row = Math.floor(lat / CELL_DEG);
    candidate.col = Math.floor(lon / CELL_DEG);
    candidate.members = new Map([[candidate.provider, candidate.reading]]);
    const key = `${candidate.row}:${candidate.col}`;
    if (!grid.has(key)) grid.set(key, new Map());
    const cell = grid.get(key);
    if (!cell.has(candidate.provider)) cell.set(candidate.provider, []);
    cell.get(candidate.provider).push(candidate);
  });
  // Every pair of readings of two providers closer than dedupeM, nearest
  // first; a provider's own readings are never compared.
  const pairs = [];
  for (const a of ranked)
    for (let r = a.row - 1; r <= a.row + 1; r++)
      for (let c = a.col - 1; c <= a.col + 1; c++)
        for (const [provider, bucket] of grid.get(`${r}:${c}`) ?? [])
          if (provider !== a.provider)
            for (const b of bucket)
              if (b.rank > a.rank) {
                const apart = metres(a.reading, b.reading);
                if (apart < dedupeM) pairs.push({ a, b, apart });
              }
  pairs.sort(
    (x, y) => x.apart - y.apart || x.a.rank - y.a.rank || x.b.rank - y.b.rank,
  );
  // A site keeps one reading, and takes in at most one of each other
  // provider: the nearest. The better-ranked of a pair is kept.
  for (const { a, b } of pairs) {
    if (a.dropped || b.dropped) continue;
    // A previously matched group can join the winner if every member is a
    // distinct provider at this site. Keep selections pointing to the final winner.
    let compatible = true;
    for (const [provider, reading] of b.members) {
      if (a.members.has(provider) || metres(a.reading, reading) >= dedupeM) {
        compatible = false;
        break;
      }
    }
    if (!compatible) continue;
    b.dropped = true;
    for (const [provider, reading] of b.members) {
      a.members.set(provider, reading);
      replaced?.set(reading, a.reading);
    }
  }
  return candidates
    .filter((candidate) => !candidate.dropped)
    .map((candidate) => candidate.reading);
}
