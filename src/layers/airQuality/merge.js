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
 *
 * In the AQI view a site's readings are whole stations, each with several
 * pollutants: there the kept station takes in, per pollutant, the freshest
 * value any of the site's monitors used (`mergeStationValues`), so no
 * network's pollutants are lost to another's, and its index is computed
 * again from them.
 */

/** Grid cell edge in degrees: about 2.2 km of latitude. */
const CELL_DEG = 0.02;
/** Grid columns around the globe. */
const COLUMNS = Math.round(360 / CELL_DEG);
const EARTH_RADIUS_M = 6_371_008.8;
const METRES_PER_DEGREE = (EARTH_RADIUS_M * Math.PI) / 180;

const observedAt = (reading) =>
  Number.isFinite(reading?.observedMs) ? reading.observedMs : -Infinity;

const radians = (degrees) => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in metres (haversine): exact across the
 * antimeridian and near the poles, where longitude degrees shrink to
 * nothing.
 */
function metres(a, b) {
  const h =
    Math.sin(radians(b.lat - a.lat) / 2) ** 2 +
    Math.cos(radians(a.lat)) *
      Math.cos(radians(b.lat)) *
      Math.sin(radians(b.lon - a.lon) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The grid columns within `distance` metres of a point at `lat` in column
 * `col`: enough of them to span the distance at the highest latitude the
 * search reaches, wrapping at the antimeridian; every column near a pole.
 */
function columnsNear(col, lat, distance) {
  const edge = Math.min(90, Math.abs(lat) + distance / METRES_PER_DEGREE);
  const width = METRES_PER_DEGREE * CELL_DEG * Math.cos(radians(edge));
  const span = width > 0 ? Math.ceil(distance / width) : COLUMNS;
  if (2 * span + 1 >= COLUMNS)
    return Array.from({ length: COLUMNS }, (_, c) => c);
  return Array.from(
    { length: 2 * span + 1 },
    (_, i) => (((col - span + i) % COLUMNS) + COLUMNS) % COLUMNS,
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

/** Per-pollutant fields of an AQI-view station (`aqiStations`). */
const VALUE_FIELDS = [
  'valueTimes',
  'valueAveraging',
  'valueMethods',
  'valueCoverage',
  'hourValues',
  'dayValues',
];

/**
 * One AQI-view station from the readings of one site: `base`, the reading
 * the merge kept, with each pollutant's freshest value among it and
 * `others` (by `valueTimes`; at the same time the earlier reading's). A
 * reading offers the values its own index used (`aqiValues`, else
 * `values`); low-cost sensors (`monitor: false`) offer none to a monitor.
 * Each value keeps its own times, averaging, method, coverage, 1-hour and
 * 24-hour companions, and `valueSources` names the reading it came from
 * (`{provider, id, network}`). A pollutant none of them has keeps the first
 * exclusion reason given for it. The index is left for the caller.
 */
export function mergeStationValues(base, others = []) {
  if (!base?.values || base.monitor === false) return base;
  const members = [base, ...others].filter(
    (reading) => reading?.values && reading.monitor !== false,
  );
  const offered = (reading) => reading.aqiValues ?? reading.values;
  const time = (reading, key) =>
    Number.isFinite(reading.valueTimes?.[key])
      ? reading.valueTimes[key]
      : -Infinity;
  const merged = {
    ...base,
    values: {},
    excluded: {},
    valueSources: {},
    ...Object.fromEntries(VALUE_FIELDS.map((field) => [field, {}])),
  };
  const keys = new Set(
    members.flatMap((reading) => Object.keys(offered(reading))),
  );
  for (const key of keys) {
    let best = null;
    for (const reading of members)
      if (
        Number.isFinite(offered(reading)[key]) &&
        (!best || time(reading, key) > time(best, key))
      )
        best = reading;
    if (!best) continue;
    merged.values[key] = offered(best)[key];
    for (const field of VALUE_FIELDS)
      if (best[field] && key in best[field])
        merged[field][key] = best[field][key];
    merged.valueSources[key] = {
      provider: best.provider,
      id: best.id,
      network: best.network,
    };
  }
  for (const reading of members)
    for (const [key, reason] of Object.entries(
      reading.aqiExcluded ?? reading.excluded ?? {},
    ))
      if (!(key in merged.values) && !(key in merged.excluded))
        merged.excluded[key] = reason;
  const times = Object.values(merged.valueTimes).filter(Number.isFinite);
  if (times.length) merged.observedMs = Math.max(...times);
  return merged;
}

/**
 * @param {Array<{provider: string, direct: boolean, readings: object[]}>} lists
 * @param {{dedupeM?: number, view?: string, replaced?: Map<object, object>,
 *   combine?: (kept: object, others: object[]) => object}} [options] `view` is the scale
 *   readings are rated on (`isRatedReading`). The optional map records each dropped reading and its replacement.
 *   `combine`, when given, makes the one reading of a site from the kept one and the others there, best first
 *   (in the AQI view, `mergeStationValues` and the index computed again).
 * @returns {object[]} The kept readings, in input order.
 */
export function mergeObservations(
  lists,
  { dedupeM = 150, view, replaced, combine } = {},
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
  const rankOf = new Map();
  ranked.forEach((candidate, rank) => {
    rankOf.set(candidate.reading, rank);
    const { lat, lon } = candidate.reading;
    candidate.rank = rank;
    candidate.row = Math.floor(lat / CELL_DEG);
    // Columns count from the antimeridian, so 180° is column 0 like -180°.
    candidate.col = Math.floor((lon + 180) / CELL_DEG) % COLUMNS;
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
  const rows = Math.ceil(dedupeM / (METRES_PER_DEGREE * CELL_DEG));
  for (const a of ranked) {
    const columns = columnsNear(a.col, a.reading.lat, dedupeM);
    for (let r = a.row - rows; r <= a.row + rows; r++)
      for (const c of columns)
        for (const [provider, bucket] of grid.get(`${r}:${c}`) ?? [])
          if (provider !== a.provider)
            for (const b of bucket)
              if (b.rank > a.rank) {
                const apart = metres(a.reading, b.reading);
                if (apart < dedupeM) pairs.push({ a, b, apart });
              }
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
  // A site's one reading, made from all of its readings where asked.
  const combined = new Map();
  if (combine)
    for (const candidate of ranked)
      if (!candidate.dropped && candidate.members.size > 1) {
        const others = [...candidate.members.values()]
          .filter((reading) => reading !== candidate.reading)
          .sort((a, b) => rankOf.get(a) - rankOf.get(b));
        combined.set(candidate.reading, combine(candidate.reading, others));
      }
  if (replaced)
    for (const [dropped, kept] of replaced)
      if (combined.has(kept)) replaced.set(dropped, combined.get(kept));
  return candidates
    .filter((candidate) => !candidate.dropped)
    .map((candidate) => combined.get(candidate.reading) ?? candidate.reading);
}
