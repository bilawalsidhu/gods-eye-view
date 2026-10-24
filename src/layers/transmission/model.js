/** Bounded, source-neutral records for the Cape Town transmission pilot. */
export const LAYER_ID = 'transmission';
export const VOLTAGES = Object.freeze([
  110000, 132000, 150000, 220000, 400000, 500000, 765000,
]);
export const MAX_FEATURES = 1000;
export const MAX_VERTICES = 12000;
export const DISPLAY_LIMIT = 600;
export const DETAIL_HEIGHT_M = 1800000;
export const DEFAULT_PARAMS = Object.freeze({
  voltage: 'all',
  showUnknown: false,
});
const COLORS = [
  '#f2cc60',
  '#f2cc60',
  '#f2cc60',
  '#f59e42',
  '#e876c2',
  '#b29afa',
  '#b29afa',
];

/** Only documented filter values enter runtime or shared state. */
export function normalizeParams(current, patch = {}) {
  return {
    voltage:
      patch.voltage === 'all' || VOLTAGES.includes(Number(patch.voltage))
        ? String(patch.voltage)
        : current.voltage,
    showUnknown:
      typeof patch.showUnknown === 'boolean'
        ? patch.showUnknown
        : current.showUnknown,
  };
}

/** Colour is the highest tagged voltage; unknown substations use a neutral outline. */
export function recordColor(record) {
  if (record.voltageState === 'unknown') return '#b7c1cb';
  const highest = Math.max(...record.voltages);
  return COLORS[VOLTAGES.indexOf(highest)] || '#f2cc60';
}

export function intersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Validate the complete pack before rendering; never silently present a partial parse. */
export function normalizePack(geojson, metadata) {
  const bbox = metadata?.bbox;
  if (
    metadata?.schemaVersion !== 1 ||
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    !bbox.every(Number.isFinite) ||
    bbox[0] >= bbox[2] ||
    bbox[1] >= bbox[3] ||
    bbox[0] < -180 ||
    bbox[2] > 180 ||
    bbox[1] < -90 ||
    bbox[3] > 90 ||
    metadata.cutoffV !== 110000 ||
    !Number.isFinite(Date.parse(metadata.sourceTimestamp))
  )
    throw new Error('Invalid transmission metadata');
  if (
    geojson?.type !== 'FeatureCollection' ||
    !Array.isArray(geojson.features) ||
    geojson.features.length > MAX_FEATURES ||
    geojson.features.length !== metadata.features
  )
    throw new Error('Invalid transmission feature budget');
  const ids = new Set();
  let vertices = 0;
  const rows = geojson.features.map((feature) => {
    const p = feature.properties;
    const g = feature.geometry;
    if (
      !/^(way|node)\/[1-9][0-9]*$/.test(feature.id) ||
      ids.has(feature.id) ||
      !p ||
      !['line', 'substation'].includes(p.kind) ||
      !['known', 'unknown'].includes(p.voltageState)
    )
      throw new Error('Invalid transmission identity');
    ids.add(feature.id);
    const unknown = p.voltageState === 'unknown';
    const tagged =
      typeof p.voltage === 'string'
        ? p.voltage
            .split(/[;,]/)
            .map((v) => v.trim())
            .filter(Boolean)
        : [];
    if (
      (!unknown &&
        (!tagged.length ||
          tagged.some((v) => !/^[0-9]+$/.test(v)) ||
          JSON.stringify(tagged.map(Number)) !== JSON.stringify(p.voltages))) ||
      !Array.isArray(p.voltages) ||
      p.voltages.length > 20 ||
      (unknown &&
        (p.kind !== 'substation' || p.voltages.length || p.voltage != null)) ||
      (!unknown &&
        (!p.voltages.length ||
          !p.voltages.every((v) => Number.isSafeInteger(v) && v > 0) ||
          Math.max(...p.voltages) < 110000))
    )
      throw new Error('Invalid transmission voltage');
    if (p.kind === 'line' ? g?.type !== 'MultiLineString' : g?.type !== 'Point')
      throw new Error('Invalid transmission geometry');
    const parts = p.kind === 'line' ? g.coordinates : [[g.coordinates]];
    if (
      !Array.isArray(parts) ||
      !parts.length ||
      parts.some(
        (part) =>
          !Array.isArray(part) || part.length < (p.kind === 'line' ? 2 : 1),
      )
    )
      throw new Error('Invalid transmission coordinates');
    const points = parts.flat();
    vertices += points.length;
    if (
      vertices > MAX_VERTICES ||
      points.some(
        (c) =>
          !Array.isArray(c) ||
          c.length !== 2 ||
          !c.every(Number.isFinite) ||
          c[0] < bbox[0] - 1e-8 ||
          c[0] > bbox[2] + 1e-8 ||
          c[1] < bbox[1] - 1e-8 ||
          c[1] > bbox[3] + 1e-8,
      )
    )
      throw new Error('Invalid transmission coordinates');
    const bounds = [
      Math.min(...points.map((c) => c[0])),
      Math.min(...points.map((c) => c[1])),
      Math.max(...points.map((c) => c[0])),
      Math.max(...points.map((c) => c[1])),
    ];
    const anchor = points[Math.floor(points.length / 2)];
    return {
      id: feature.id,
      kind: p.kind,
      voltageState: p.voltageState,
      voltages: [...p.voltages],
      voltage: p.voltage ?? null,
      name: String(p.name || '').slice(0, 180),
      operator: String(p.operator || '').slice(0, 180),
      representativePoint: p.representativePoint === true,
      clipped: p.clipped === true,
      overlappingAreas: Array.isArray(p.overlappingAreas)
        ? p.overlappingAreas
            .filter((id) => /^way\/[1-9][0-9]*$/.test(id))
            .slice(0, 8)
        : [],
      geometry: g,
      bounds,
      anchor: { lon: anchor[0], lat: anchor[1] },
    };
  });
  return { rows, metadata };
}

/** Stable bounded display cohort; counts describe filtered data separately from visible geometry. */
export function selectRecords(rows, params, view, height) {
  const filtered = rows.filter((r) =>
    r.voltageState === 'unknown'
      ? params.showUnknown
      : params.voltage === 'all' || r.voltages.includes(Number(params.voltage)),
  );
  const zoomedOut = !Number.isFinite(height) || height > DETAIL_HEIGHT_M;
  const candidates =
    zoomedOut || !view
      ? []
      : filtered.filter((r) => intersects(r.bounds, view));
  candidates.sort(
    (a, b) =>
      Number(a.voltageState === 'unknown') -
        Number(b.voltageState === 'unknown') || a.id.localeCompare(b.id),
  );
  return {
    filtered,
    visible: candidates.slice(0, DISPLAY_LIMIT),
    omitted: Math.max(0, candidates.length - DISPLAY_LIMIT),
    zoomedOut,
  };
}
